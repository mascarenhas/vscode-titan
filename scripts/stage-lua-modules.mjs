import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import * as path from "node:path";

const LUA_VERSION = "5.5";
const LUA_SOURCE_VERSION = "5.5.1";
const EXPECTED_COMPILER_VERSION = {
  LUA_VERSION,
  TITAN_ABI_VERSION: "2",
  TITAN_VERSION: "0.6.0"
};
const EXPECTED_LANGUAGE_SERVER_API_VERSION = 1;
const EXPECTED_SHARE_ROOT = [
  "argparse.lua:file",
  "c-parser:directory",
  "inspect.lua:file",
  ...(process.platform === "win32" ? [] : ["luarocks:directory"]),
  "relabel.lua:file",
  "titan:directory",
  "titan-compiler:directory"
];
const EXPECTED_NATIVE_ROOT = [
  `lfs.${process.platform === "win32" ? "dll" : "so"}:file`,
  `lpeglabel.${process.platform === "win32" ? "dll" : "so"}:file`
];
const REQUIRED_SHARE_FILES = [
  "c-parser/cdriver.lua",
  "inspect.lua",
  "relabel.lua",
  "titan-compiler/checker.lua",
  "titan-compiler/checker/completion.lua",
  "titan-compiler/completion.lua",
  "titan-compiler/driver.lua",
  "titan-compiler/maybe3.lua",
  "titan-compiler/parser.lua",
  "titan-compiler/types.lua",
  "titan-compiler/version.lua"
];
const EXPECTED_INCLUDE_ROOT = [
  "lauxlib.h:file",
  "llhttp.h:file",
  "luaconf.h:file",
  "lua.h:file",
  "lua.hpp:file",
  "lualib.h:file",
  "minicoro.h:file",
  "sqlite3.h:file",
  "titan:directory",
  "titan.h:file",
  "uv:directory",
  "uv.h:file"
];

const repositoryRoot = process.cwd();
const titanPrefix = path.resolve(
  repositoryRoot,
  process.env.TITAN_PREFIX ?? ".titan"
);
let bundledOpenSSL = false;
try {
  bundledOpenSSL = (await lstat(path.join(titanPrefix, "include", "openssl"))).isDirectory();
} catch (cause) {
  if (cause.code !== "ENOENT") throw cause;
}
if (bundledOpenSSL) EXPECTED_INCLUDE_ROOT.push("openssl:directory");
const outputPrefix = path.join(repositoryRoot, "dist", "titan");
const trees = [
  {
    description: "Lua source module tree",
    source: path.join(titanPrefix, "share", "lua", LUA_VERSION),
    destination: path.join(outputPrefix, "share", "lua", LUA_VERSION),
    expectedRoot: EXPECTED_SHARE_ROOT
  },
  {
    description: "Lua native module tree",
    source: path.join(titanPrefix, "lib", "lua", LUA_VERSION),
    destination: path.join(outputPrefix, "lib", "lua", LUA_VERSION),
    expectedRoot: EXPECTED_NATIVE_ROOT
  },
  {
    description: "Titan SDK include tree",
    source: path.join(titanPrefix, "include"),
    destination: path.join(outputPrefix, "include"),
    expectedRoot: EXPECTED_INCLUDE_ROOT
  },
  {
    description: "Lua native source tree",
    source: path.join(titanPrefix, "src"),
    destination: path.join(outputPrefix, "src"),
    expectedRoot: [`lua-${LUA_SOURCE_VERSION}:directory`]
  }
];

function entryKind(entry) {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "symbolic link";
  return "unsupported";
}

async function validateRootInventory(tree) {
  let entries;
  try {
    entries = await readdir(tree.source, { withFileTypes: true });
  } catch (cause) {
    throw new Error(
      `cannot read ${tree.description} at ${tree.source}: ${cause.message}`
    );
  }
  const actual = entries
    .map((entry) => `${entry.name}:${entryKind(entry)}`)
    .sort();
  const expected = [...tree.expectedRoot].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${tree.description} inventory changed: expected ${
        JSON.stringify(expected)
      }, found ${JSON.stringify(actual)}`
    );
  }
}

async function requireRegularFile(root, relativePath, description) {
  const filename = path.join(root, ...relativePath.split("/"));
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch (cause) {
    throw new Error(`cannot inspect ${description} at ${filename}: ${cause.message}`);
  }
  if (!metadata.isFile()) {
    throw new Error(`${description} is not a regular file: ${filename}`);
  }
  return filename;
}

function assignedLuaString(source, name, filename) {
  const assignment = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`).exec(source);
  if (assignment === null) {
    throw new Error(`cannot find ${name} in compiler version module ${filename}`);
  }
  return assignment[1];
}

async function validateCompilerVersion(shareRoot) {
  const filename = await requireRegularFile(
    shareRoot,
    "titan-compiler/version.lua",
    "compiler version module"
  );
  const source = await readFile(filename, "utf8");
  for (const [name, expected] of Object.entries(EXPECTED_COMPILER_VERSION)) {
    const actual = assignedLuaString(source, name, filename);
    if (actual !== expected) {
      throw new Error(
        `incompatible compiler ${name} in ${filename}: expected ${expected}, found ${actual}`
      );
    }
  }

  const driverFilename = await requireRegularFile(
    shareRoot,
    "titan-compiler/driver.lua",
    "compiler driver module"
  );
  const driverSource = await readFile(driverFilename, "utf8");
  const apiMatch = driverSource.match(
    /^\s*driver[.]LANGUAGE_SERVER_API_VERSION\s*=\s*([0-9]+)\s*$/m
  );
  if (apiMatch === null) {
    throw new Error(
      `cannot find LANGUAGE_SERVER_API_VERSION in compiler driver ${driverFilename}`
    );
  }
  const actualApi = Number(apiMatch[1]);
  if (actualApi !== EXPECTED_LANGUAGE_SERVER_API_VERSION) {
    throw new Error(
      `incompatible compiler LANGUAGE_SERVER_API_VERSION in ${driverFilename}: ` +
      `expected ${EXPECTED_LANGUAGE_SERVER_API_VERSION}, found ${actualApi}`
    );
  }
}

async function inventory(root, relativeRoot = "") {
  const directory = relativeRoot.length === 0
    ? root
    : path.join(root, ...relativeRoot.split("/"));
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  const result = [];
  for (const entry of entries) {
    const relativePath = relativeRoot.length === 0
      ? entry.name
      : `${relativeRoot}/${entry.name}`;
    const filename = path.join(directory, entry.name);
    const metadata = await lstat(filename);
    if (entry.isDirectory()) {
      result.push({ path: relativePath, type: "directory" });
      result.push(...await inventory(root, relativePath));
    } else if (entry.isFile()) {
      const contents = await readFile(filename);
      result.push({
        path: relativePath,
        type: "file",
        mode: metadata.mode & 0o777,
        size: metadata.size,
        sha256: createHash("sha256").update(contents).digest("hex")
      });
    } else {
      throw new Error(
        `${root} contains an unsupported ${entryKind(entry)} at ${relativePath}`
      );
    }
  }
  return result;
}

function compareInventories(tree, sourceInventory, stagedInventory) {
  if (JSON.stringify(stagedInventory) !== JSON.stringify(sourceInventory)) {
    throw new Error(
      `staged ${tree.description} does not exactly match ${tree.source}`
    );
  }
}

await rm(outputPrefix, { recursive: true, force: true });

for (const tree of trees) {
  await validateRootInventory(tree);
}
for (const relativePath of REQUIRED_SHARE_FILES) {
  await requireRegularFile(
    trees[0].source,
    relativePath,
    `required Lua module ${relativePath}`
  );
}
await validateCompilerVersion(trees[0].source);
if (bundledOpenSSL) {
  for (const header of ["ssl.h", "crypto.h", "opensslv.h"]) {
    await requireRegularFile(
      trees[2].source, `openssl/${header}`, `bundled OpenSSL header ${header}`
    );
  }
}

let fileCount = 0;
let byteCount = 0;
for (const tree of trees) {
  const sourceInventory = await inventory(tree.source);
  await mkdir(path.dirname(tree.destination), { recursive: true });
  await cp(tree.source, tree.destination, {
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    recursive: true
  });
  const stagedInventory = await inventory(tree.destination);
  compareInventories(tree, sourceInventory, stagedInventory);
  for (const entry of stagedInventory) {
    if (entry.type !== "file") continue;
    fileCount += 1;
    byteCount += entry.size;
  }
}

console.log(
  `staged ${fileCount} compiler module and SDK files (${byteCount} bytes) in ${
    path.relative(repositoryRoot, outputPrefix)
  }`
);
