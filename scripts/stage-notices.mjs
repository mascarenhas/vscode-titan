import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCompilerRocks } from "./compiler-rocks.mjs";

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

async function readRequired(source, description) {
  try {
    return await readFile(source, "utf8");
  } catch (cause) {
    throw new Error(`cannot read ${description} from ${source}: ${cause.message}`);
  }
}

function requireContent(contents, marker, source, description) {
  if (!contents.includes(marker)) {
    throw new Error(
      `${description} mismatch in ${source}: expected ${JSON.stringify(marker)}`
    );
  }
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

export async function stageLuaNotices({ sdk = titanPrefix, destination = outputRoot,
  platform = process.platform, manifestReader } = {}) {
  const versions = [];
  // Standalone Windows LuaRocks manages the installed rocks but does not ship
  // its own Lua module tree. Only Unix includes those LuaRocks source modules.
  if (platform !== "win32") {
    const luaRocksVersion = "3.13.0";
    const installedConfig = path.join(sdk, "share", "lua", "5.5", "luarocks", "core", "cfg.lua");
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
      path.join(destination, luaRocksDestination),
      `LuaRocks ${luaRocksVersion} license`
    );
    versions.push({
      name: "LuaRocks",
      version: luaRocksVersion,
      notice: luaRocksDestination
    });

  }

  for (const component of await verifyCompilerRocks(sdk, { platform, manifestReader })) {
    const notice = path.join(destination, component.notice);
    await mkdir(path.dirname(notice), { recursive: true });
    await writeFile(notice, component.license, "utf8");
    versions.push({ name: component.name, version: component.version, notice: component.notice });
  }
  if (platform === "win32") {
    // Stock luv statically includes libuv. Its bundled license is byte-identical
    // to the libuv license already installed by Titan and staged with its SDK.
    const licenses = [
      ["libuv-LICENSE", "Copyright (c) 2015-present libuv project contributors."],
      ["libuv-LICENSE-extra", "Copyright Joyent, Inc. and other Node contributors."],
      ["libuv-tree-LICENSE", "Copyright 2002 Niels Provos"],
      ["libuv-inet-LICENSE", "Copyright (c) 2004 by Internet Systems Consortium, Inc."]
    ];
    for (const [name, marker] of licenses) {
      const license = path.join(sdk, "share", "titan", "LICENSES", name);
      const contents = await readRequired(license, "luv bundled libuv license");
      requireContent(contents, marker, license, "luv bundled libuv license");
    }
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

export async function stageNotices() {
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
      ...(process.platform === "win32" ? ["",
        "The Windows compiler's luv module also includes libuv; its license is",
        "preserved at `titan/LICENSES/libuv-LICENSE`, `libuv-LICENSE-extra`,",
        "`libuv-tree-LICENSE`, and `libuv-inet-LICENSE` in the same directory."] : []),
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

}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await stageNotices();
}
