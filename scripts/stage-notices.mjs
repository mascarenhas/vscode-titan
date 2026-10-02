import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import * as path from "node:path";
import { receiptPath, verifyCompilerReceipt } from "./windows-compiler-receipt.mjs";

const repositoryRoot = process.cwd();
const titanRepository = path.resolve(
  repositoryRoot,
  process.env.TITAN_REPO ?? "../titan"
);
const titanPrefix = path.resolve(
  repositoryRoot,
  process.env.TITAN_PREFIX ?? ".titan"
);
const outputRoot = path.join(repositoryRoot, "dist", "notices");
const luaShareRoot = path.join(titanPrefix, "share", "lua", "5.5");
const luaNativeRoot = path.join(titanPrefix, "lib", "lua", "5.5");
const rocksRoot = path.join(titanPrefix, "lib", "luarocks", "rocks-5.5");

const runtimePackages = [
  "semver",
  "vscode-jsonrpc",
  "vscode-languageclient",
  "vscode-languageserver-protocol",
  "vscode-languageserver-textdocument",
  "vscode-languageserver-types"
];

const licenseNames = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "License.txt",
  "NOTICE",
  "NOTICE.md",
  "NOTICE.txt",
  "thirdpartynotices.txt"
];

const luaRockComponents = [
  {
    name: "argparse",
    rockName: "argparse",
    version: "0.7.2-1",
    payloads: [path.join(luaShareRoot, "argparse.lua")],
    licenseRelativePath: path.join("doc", "LICENSE"),
    licenseDestination: path.join("lua", "argparse", "LICENSE"),
    licenseMarkers: ["The MIT License (MIT)", "Peter Melnichenko"]
  },
  {
    name: "inspect",
    rockName: "inspect",
    version: "3.1.3-0",
    payloads: [path.join(luaShareRoot, "inspect.lua")],
    embeddedLicenseSource: path.join(luaShareRoot, "inspect.lua"),
    licenseDestination: path.join("lua", "inspect", "LICENSE"),
    licenseMarkers: ["MIT LICENSE", "Enrique García Cota"]
  },
  {
    name: "LuaFileSystem",
    rockName: "luafilesystem",
    version: "1.9.0-1",
    payloads: [path.join(luaNativeRoot, process.platform === "win32" ? "lfs.dll" : "lfs.so")],
    licenseRelativePath: path.join("docs", "license.html"),
    licenseDestination: path.join("lua", "luafilesystem", "LICENSE.html"),
    licenseMarkers: ["<h1>License</h1>", "The LuaFileSystem authors"]
  },
  {
    name: "LPegLabel",
    rockName: "LPegLabel",
    rockDirectory: "lpeglabel",
    version: "1.6.2-1",
    payloads: [
      path.join(luaNativeRoot, process.platform === "win32" ? "lpeglabel.dll" : "lpeglabel.so"),
      path.join(luaShareRoot, "relabel.lua")
    ],
    licenseRelativePath: path.join("doc", "LICENSE"),
    licenseDestination: path.join("lua", "lpeglabel", "LICENSE"),
    licenseMarkers: ["The MIT License (MIT)", "Sérgio Medeiros"]
  }
];

function rockRoot(component) {
  const directory = component.rockDirectory ?? component.rockName;
  return path.join(rocksRoot, directory, component.version);
}

function rockspecPath(component) {
  const directory = component.rockDirectory ?? component.rockName;
  return path.join(
    rockRoot(component),
    `${directory}-${component.version}.rockspec`
  );
}

async function readRequired(source, description) {
  try {
    return await readFile(source, "utf8");
  } catch (cause) {
    throw new Error(`cannot read ${description} from ${source}: ${cause.message}`);
  }
}

async function requirePayload(source, componentName) {
  try {
    await access(source);
  } catch (cause) {
    throw new Error(
      `bundled Lua component ${componentName} is missing its payload ${source}: ${cause.message}`
    );
  }
}

function requireContent(contents, marker, source, description) {
  if (!contents.includes(marker)) {
    throw new Error(
      `${description} mismatch in ${source}: expected ${JSON.stringify(marker)}`
    );
  }
}

function rockspecField(contents, field, source, componentName) {
  const match = contents.match(
    new RegExp(`^\\s*${field}\\s*=\\s*["']([^"']+)["']`, "m")
  );
  if (!match) {
    throw new Error(
      `cannot identify ${field} for bundled Lua component ${componentName} in ${source}`
    );
  }
  return match[1];
}

async function validateRockspec(component) {
  const source = rockspecPath(component);
  const contents = await readRequired(
    source,
    `${component.name} ${component.version} rockspec`
  );
  const actualName = rockspecField(contents, "package", source, component.name);
  const actualVersion = rockspecField(contents, "version", source, component.name);
  if (actualName !== component.rockName || actualVersion !== component.version) {
    throw new Error(
      `bundled Lua component metadata mismatch in ${source}: expected ` +
      `${component.rockName} ${component.version}, found ${actualName} ${actualVersion}`
    );
  }
}

function extractInspectLicense(contents, source) {
  const match = contents.match(/inspect\._LICENSE\s*=\s*\[\[\r?\n([\s\S]*?)\]\]/);
  if (!match) {
    throw new Error(`inspect license source mismatch in ${source}: _LICENSE is missing`);
  }
  return `${match[1].replace(/\r?\n$/, "")}\n`;
}

async function copyRequired(source, destination, description) {
  try {
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  } catch (cause) {
    throw new Error(`cannot stage ${description} from ${source}: ${cause.message}`);
  }
}

async function stageTitanNotices() {
  const destination = path.join(outputRoot, "titan");
  await copyRequired(
    process.platform === "win32"
      ? path.join(titanPrefix, "share", "titan", "LICENSE")
      : path.join(titanRepository, "LICENSE"),
    path.join(destination, "LICENSE"),
    "Titan license"
  );
  await copyRequired(
    path.join(titanPrefix, "share", "titan", "THIRD_PARTY_NOTICES.md"),
    path.join(destination, "THIRD_PARTY_NOTICES.md"),
    "Titan third-party notices"
  );

  const sourceLicenses = path.join(titanPrefix, "share", "titan", "LICENSES");
  const entries = (await readdir(sourceLicenses, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0) {
    throw new Error(`Titan license directory is empty: ${sourceLicenses}`);
  }
  for (const entry of entries) {
    await copyRequired(
      path.join(sourceLicenses, entry.name),
      path.join(destination, "LICENSES", entry.name),
      `Titan dependency license ${entry.name}`
    );
  }
}

async function stageLuaNotices() {
  const versions = [];
  if (process.platform === "win32") {
    // Validate the installed source receipt against every shipped native/Lua
    // artifact and notice; Windows has no LuaRocks installation to consult.
    const rows = await verifyCompilerReceipt(titanPrefix);
    await copyRequired(path.join(titanPrefix, receiptPath),
      path.join(outputRoot, "lua", "compiler-dependencies.tsv"), "compiler dependency receipt");
    for (const name of [...new Set(rows.map((row) => row.name))]) {
      const row = rows.find((entry) => entry.name === name);
      const source = path.join(titanPrefix, row.notice);
      const contents = await readRequired(source, `${name} source license`);
      requireContent(contents, "Permission is hereby granted", source, "MIT license source");
      const destination = path.join("lua", name, "LICENSE");
      await copyRequired(source, path.join(outputRoot, destination), `${name} license`);
      versions.push({ name, version: row.version, notice: destination });
    }
    return versions;
  }

  const luaRocksVersion = "3.13.0";
  const installedConfig = path.join(luaShareRoot, "luarocks", "core", "cfg.lua");
  const sourceRoot = path.join(titanRepository, `luarocks-${luaRocksVersion}`);
  const sourceConfig = path.join(sourceRoot, "src", "luarocks", "core", "cfg.lua");
  const luaRocksLicense = path.join(sourceRoot, "COPYING");
  for (const [source, description] of [
    [installedConfig, "installed LuaRocks version metadata"],
    [sourceConfig, "LuaRocks license-source version metadata"]
  ]) {
    const contents = await readRequired(source, description);
    requireContent(
      contents,
      `local program_version = "${luaRocksVersion}"`,
      source,
      "LuaRocks version metadata"
    );
  }
  const luaRocksLicenseContents = await readRequired(
    luaRocksLicense,
    `LuaRocks ${luaRocksVersion} license`
  );
  requireContent(
    luaRocksLicenseContents,
    "Copyright 2011-2022, the LuaRocks project authors.",
    luaRocksLicense,
    "LuaRocks license source"
  );
  const luaRocksDestination = path.join("lua", "luarocks", "COPYING");
  await copyRequired(
    luaRocksLicense,
    path.join(outputRoot, luaRocksDestination),
    `LuaRocks ${luaRocksVersion} license`
  );
  versions.push({
    name: "LuaRocks",
    version: luaRocksVersion,
    notice: luaRocksDestination
  });

  for (const component of luaRockComponents) {
    await validateRockspec(component);
    for (const payload of component.payloads) {
      await requirePayload(payload, `${component.name} ${component.version}`);
    }

    const destination = path.join(outputRoot, component.licenseDestination);
    if (component.embeddedLicenseSource) {
      const sourceContents = await readRequired(
        component.embeddedLicenseSource,
        `${component.name} ${component.version} embedded license source`
      );
      const licenseContents = extractInspectLicense(
        sourceContents,
        component.embeddedLicenseSource
      );
      for (const marker of component.licenseMarkers) {
        requireContent(
          licenseContents,
          marker,
          component.embeddedLicenseSource,
          `${component.name} license source`
        );
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, licenseContents, "utf8");
    } else {
      const licenseSource = path.join(
        rockRoot(component),
        component.licenseRelativePath
      );
      const licenseContents = await readRequired(
        licenseSource,
        `${component.name} ${component.version} license`
      );
      for (const marker of component.licenseMarkers) {
        requireContent(
          licenseContents,
          marker,
          licenseSource,
          `${component.name} license source`
        );
      }
      await copyRequired(
        licenseSource,
        destination,
        `${component.name} ${component.version} license`
      );
    }

    versions.push({
      name: component.name,
      version: component.version,
      notice: component.licenseDestination
    });
  }

  return versions;
}

async function stageJavaScriptNotices() {
  const bundledPackages = JSON.parse(
    await readFile(path.join(repositoryRoot, "dist", "bundled-packages.json"), "utf8")
  );
  if (JSON.stringify(bundledPackages) !== JSON.stringify(runtimePackages)) {
    throw new Error(
      "bundled JavaScript packages changed without a matching notice inventory: " +
      JSON.stringify(bundledPackages)
    );
  }
  const versions = [];
  for (const packageName of runtimePackages) {
    const packageRoot = path.join(repositoryRoot, "node_modules", packageName);
    const manifest = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8")
    );
    const destination = path.join(outputRoot, "javascript", packageName);
    await mkdir(destination, { recursive: true });
    const sourceNames = new Set(await readdir(packageRoot));
    let copied = 0;
    for (const filename of licenseNames) {
      // Preserve the real basename on case-insensitive filesystems as well.
      if (!sourceNames.has(filename)) continue;
      try {
        await copyFile(
          path.join(packageRoot, filename),
          path.join(destination, filename)
        );
        copied += 1;
      } catch (cause) {
        if (cause.code !== "ENOENT") throw cause;
      }
    }
    if (copied === 0) {
      throw new Error(`no license or notice found for bundled package ${packageName}`);
    }
    versions.push(`${packageName} ${manifest.version}`);
  }
  return versions;
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.join(outputRoot, "javascript"), { recursive: true });
await stageTitanNotices();
const luaVersions = await stageLuaNotices();
const javaScriptVersions = await stageJavaScriptNotices();
await writeFile(
  path.join(outputRoot, "README.md"),
  [
    "# Bundled component notices",
    "",
    "This VSIX contains the native Titan language-server executable and its",
    process.platform === "win32"
      ? "DLL application, controlled shared Lua and native runtime DLLs, plus the compiler and its Lua"
      : "selected statically linked runtime modules, the Titan compiler and its Lua",
    "dependencies under `share/lua/5.5` and `lib/lua/5.5`,",
    "and a bundled JavaScript language client. Their license and notice files are",
    "preserved below. The extension's own license is at the VSIX root.",
    "",
    "Titan-owned Lua modules are covered by `titan/LICENSE`; Titan's native",
    "third-party notices and license texts are under `titan/`.",
    "",
    "## Bundled Lua components",
    "",
    ...luaVersions.map(
      (entry) => `- ${entry.name} ${entry.version} — \`${entry.notice.split(path.sep).join("/")}\``
    ),
    "",
    "## Bundled JavaScript packages",
    "",
    ...javaScriptVersions.map((entry) => `- ${entry}`),
    ""
  ].join("\n"),
  "utf8"
);

console.log(`staged bundled-component notices in ${path.relative(repositoryRoot, outputRoot)}`);
