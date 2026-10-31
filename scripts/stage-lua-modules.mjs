import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSdkIncludeInventory } from "./sdk-include-inventory.mjs";
import { resolveTitanSdk } from "./titan-sdk.mjs";

const LUA_VERSION = "5.5";
const LUA_SOURCE_VERSION = "5.5.1";
const EXPECTED_COMPILER_VERSION = {
  LUA_VERSION,
  TITAN_ABI_VERSION: "2",
  TITAN_VERSION: "0.6.0"
};
const EXPECTED_LANGUAGE_SERVER_API_VERSION = 1;
// The compiler modules, their packaged dependencies and nothing else. The
// standard modules are native providers, so there is no share/lua/5.5/titan
// tree; generated shims were removed with the provider rewrite.
const EXPECTED_SHARE_ROOT = [
  "argparse.lua:file",
  "c-parser:directory",
  "inspect.lua:file",
  "relabel.lua:file",
  "titan-compiler:directory"
];
export function nativeRootInventory(platform = process.platform) {
  const suffix = platform === "win32" ? "dll" : "so";
  return [`lfs.${suffix}:file`, `lpeglabel.${suffix}:file`, `luv.${suffix}:file`];
}
export const requiredShareFiles = [
  "c-parser/cdriver.lua",
  "inspect.lua",
  "relabel.lua",
  "titan-compiler/checker.lua",
  "titan-compiler/build.lua",
  "titan-compiler/build_worker.lua",
  "titan-compiler/checker/completion.lua",
  "titan-compiler/completion.lua",
  "titan-compiler/process.lua",
  "titan-compiler/driver.lua",
  "titan-compiler/maybe3.lua",
  "titan-compiler/documentation.lua",
  "titan-compiler/parser.lua",
  "titan-compiler/path.lua",
  "titan-compiler/source_selection.lua",
  "titan-compiler/types.lua",
  "titan-compiler/version.lua"
];
export async function sdkPayloadTrees(sdk, { platform = process.platform } = {}) {
  const trees = [
    {
      description: "Lua source module tree",
      relative: `share/lua/${LUA_VERSION}`,
      expectedRoot: EXPECTED_SHARE_ROOT
    },
    {
      description: "Lua native module tree",
      relative: `lib/lua/${LUA_VERSION}`,
      expectedRoot: nativeRootInventory(platform)
    },
    {
      description: "Titan SDK include tree",
      relative: "include",
      validateInventory: (entries) => validateSdkIncludeInventory(entries, platform)
    },
    {
      description: "Lua native source tree",
      relative: "src",
      expectedRoot: [`lua-${LUA_SOURCE_VERSION}:directory`]
    }
  ];
  for (const tree of trees) {
    tree.source = path.join(sdk, tree.relative);
    tree.selectedRoot = await validateRootInventory(tree);
  }
  return trees;
}

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
  if (tree.validateInventory) {
    return tree.validateInventory(actual);
  }
  const expected = [...tree.expectedRoot].sort();
  const selectedNames = new Set(expected.map((entry) => entry.split(":")[0]));
  const selected = actual.filter((entry) => selectedNames.has(entry.split(":")[0]));
  if (JSON.stringify(selected) !== JSON.stringify(expected)) {
    throw new Error(
      `${tree.description} inventory changed: expected ${
        JSON.stringify(expected)
      }, found ${JSON.stringify(selected)}`
    );
  }
  return expected;
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

async function inventory(root, relativeRoot = "", selectedRoot) {
  const directory = relativeRoot.length === 0
    ? root
    : path.join(root, ...relativeRoot.split("/"));
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const selectedNames = selectedRoot && new Set(selectedRoot.map((member) => member.split(":")[0]));

  const result = [];
  for (const entry of entries) {
    if (relativeRoot.length === 0 && selectedNames && !selectedNames.has(entry.name)) continue;
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

async function validateRequiredPayload(trees) {
  for (const relativePath of requiredShareFiles) {
    await requireRegularFile(
      trees[0].source,
      relativePath,
      `required Lua module ${relativePath}`
    );
  }
  await validateCompilerVersion(trees[0].source);
  if (trees[2].selectedRoot.includes("openssl:directory")) {
    for (const header of ["ssl.h", "crypto.h", "opensslv.h"]) {
      await requireRegularFile(
        trees[2].source, `openssl/${header}`, `bundled OpenSSL header ${header}`
      );
    }
  }
}

export async function sdkPayloadInventory(sdk, options) {
  const trees = await sdkPayloadTrees(sdk, options);
  await validateRequiredPayload(trees);
  const result = [];
  for (const tree of trees) {
    for (const entry of await inventory(tree.source, "", tree.selectedRoot)) {
      result.push({ ...entry, path: `${tree.relative}/${entry.path}` });
    }
  }
  return result;
}

export async function validateStagedLuaModules(sdk, destination, options) {
  const expected = (await sdkPayloadInventory(sdk, options)).filter((entry) => entry.type === "file");
  const actual = (await inventory(destination)).filter((entry) => entry.type === "file");
  if (JSON.stringify(actual.sort((a, b) => a.path.localeCompare(b.path))) !==
      JSON.stringify(expected.sort((a, b) => a.path.localeCompare(b.path)))) {
    throw new Error(`staged compiler module and SDK payload does not exactly match selected inputs from ${sdk}`);
  }
}

export async function stageLuaModules({ sdk, destination, platform = process.platform } = {}) {
  sdk ??= resolveTitanSdk();
  const repositoryRoot = process.cwd();
  const outputPrefix = destination ?? path.join(repositoryRoot, "dist", "titan");
  const trees = await sdkPayloadTrees(sdk, { platform });
  await validateRequiredPayload(trees);
  await rm(outputPrefix, { recursive: true, force: true });

  let fileCount = 0;
  let byteCount = 0;
  for (const tree of trees) {
    const sourceInventory = await inventory(tree.source, "", tree.selectedRoot);
    const treeDestination = path.join(outputPrefix, tree.relative);
    await mkdir(treeDestination, { recursive: true });
    for (const member of tree.selectedRoot) {
      const name = member.split(":")[0];
      await cp(path.join(tree.source, name), path.join(treeDestination, name), {
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        recursive: true
      });
    }
    const stagedInventory = await inventory(treeDestination);
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

}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--check-payload") {
    const [, , , sdk, destination] = process.argv;
    if (!sdk || !destination) throw new Error("usage: stage-lua-modules.mjs --check-payload SDK DIRECTORY");
    await validateStagedLuaModules(sdk, destination);
  } else {
    await stageLuaModules();
  }
}
