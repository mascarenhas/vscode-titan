import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";
import { semanticDirectory, semanticFiles, semanticNotices, verifyBrowserNotices,
  verifyInstalledBrowserPack } from "./browser-semantic-pack.mjs";
import { runtimeDlls } from "./build-windows.mjs";
import { verifyCompilerRocks } from "./compiler-rocks.mjs";
import { validateSdkIncludeInventory } from "./sdk-include-inventory.mjs";
import { sdkPayloadInventory } from "./stage-lua-modules.mjs";
import { compilerDiscoveryEnvironment } from "./titan-sdk.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const packageImages = [
  ...runtimeDlls.map((name) => `bin/${name}`), "bin/titan-language-server.exe",
  "lib/titan/0.6/titan.dll", "lib/titan/0.6/titan_language_server.dll",
  "dist/titan/lib/lua/5.5/lfs.dll", "dist/titan/lib/lua/5.5/lpeglabel.dll", "dist/titan/lib/lua/5.5/luv.dll"
].sort();
// libuv 1.53 links Synchronization.lib; Windows resolves WaitOnAddress through
// this documented API-set contract. Keep the core API-set allowance exact.
const systemDlls = new Set(["advapi32.dll", "api-ms-win-core-synch-l1-2-0.dll",
  "bcrypt.dll", "crypt32.dll", "dbghelp.dll", "iphlpapi.dll",
  "kernel32.dll", "kernelbase.dll", "normaliz.dll", "ntdll.dll", "ole32.dll", "psapi.dll", "rpcrt4.dll",
  "secur32.dll", "shell32.dll", "shlwapi.dll", "ucrtbase.dll", "user32.dll", "userenv.dll", "version.dll",
  "winmm.dll", "ws2_32.dll"]);
export function validateImports(image, output) {
  assert(output.includes("Format: COFF-x86-64") && output.includes("Arch: x86_64"), `wrong PE architecture: ${image}`);
  const imports = [...output.matchAll(/^\s*Name: ([^\r\n]+)$/gm)].map((match) => match[1].toLowerCase());
  assert(imports.length > 0, `no import table observed: ${image}`);
  for (const name of imports) {
    assert(runtimeDlls.includes(name) || systemDlls.has(name) || /^api-ms-win-crt-[a-z0-9-]+[.]dll$/.test(name),
      `unreviewed runtime dependency ${name} in ${image}`);
  }
  return imports;
}

export function readPackage(filename) {
  return new Promise((resolve, reject) => {
    yauzl.open(filename, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const files = new Map(), names = new Set();
      const fail = (cause) => { zip.close(); reject(cause); };
      zip.on("error", fail);
      zip.on("end", () => resolve(files));
      zip.on("entry", (entry) => {
        try {
          const name = entry.fileName;
          assert(!name.includes("\\") && !name.startsWith("/") && !name.split("/").includes(".."), "unsafe VSIX pathname");
          assert(!names.has(name.toLowerCase()), `duplicate Windows VSIX pathname: ${name}`);
          names.add(name.toLowerCase());
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          assert(mode === 0 || mode === (name.endsWith("/") ? 0o040000 : 0o100000),
            `VSIX entry is not a regular file or directory: ${name}`);
          if (name.endsWith("/")) return zip.readEntry();
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return fail(streamError);
            const chunks = [];
            stream.on("error", fail);
            stream.on("data", (chunk) => chunks.push(chunk));
            stream.on("end", () => { files.set(name, Buffer.concat(chunks)); zip.readEntry(); });
          });
        } catch (cause) { fail(cause); }
      });
      zip.readEntry();
    });
  });
}
async function tree(root, relative = "") {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await tree(root, name));
    else { assert(entry.isFile(), `unsupported source-tree entry ${name}`); result.push(name); }
  }
  return result.sort();
}

export async function inspectPackage(filename, sdk, readobj, repository) {
  const includeEntries = await readdir(path.join(sdk, "include"), { withFileTypes: true });
  validateSdkIncludeInventory(includeEntries.map((entry) => `${entry.name}:${
    entry.isDirectory() ? "directory" : entry.isFile() ? "file" :
      entry.isSymbolicLink() ? "symbolic link" : "unsupported"}`), "win32");
  const files = await readPackage(filename);
  const required = ["dist/extension.js", "package.json", "readme.md", "LICENSE.txt", "language-configuration.json",
    "syntaxes/titan.tmLanguage.json", "dist/notices/README.md",
    ...semanticNotices.map((name) => `dist/notices/titan/${name}`),
    ...semanticFiles.map((name) => `dist/titan/${semanticDirectory}/${name}`),
    ...packageImages];
  for (const name of required) assert(files.has(`extension/${name}`), `missing VSIX file ${name}`);
  const manifest = files.get("extension.vsixmanifest")?.toString("utf8") ?? "";
  assert(manifest.includes('TargetPlatform="win32-x64"'), "VSIX lacks Windows x64 target");
  for (const name of files.keys()) {
    assert(!/^extension\/(?:\.agents|\.build|\.git|\.titan(?:-validation)?|node_modules|plugins|scripts|src|test)\//.test(name), `development payload ${name}`);
    assert(!/(?:^|\/)\.titan-ls(?:\/|$)|[.](?:map|so)(?:[.]|$)/.test(name) &&
      (!/[.]a(?:[.]|$)/.test(name) || name === `extension/dist/titan/${semanticDirectory}/titan.a`),
      `unexpected cache/native payload ${name}`);
  }
  const actualImages = [...files.keys()].filter((name) => /[.](dll|exe)$/i.test(name)).map((name) => name.replace(/^extension\//, "")).sort();
  assert.deepEqual(actualImages, packageImages, "VSIX executable/DLL inventory differs");
  const payload = (await sdkPayloadInventory(sdk, { platform: "win32" })).filter((entry) => entry.type === "file");
  const payloadPrefix = "extension/dist/titan/";
  assert.deepEqual([...files.keys()].filter((name) => name.startsWith(payloadPrefix))
    .map((name) => name.slice(payloadPrefix.length)).sort(), payload.map((entry) => entry.path).sort(),
  "VSIX compiler inventory differs from selected SDK payload");
  for (const entry of payload) assert.equal(hash(files.get(payloadPrefix + entry.path)), entry.sha256,
    `VSIX compiler bytes differ: ${entry.path}`);
  await verifyInstalledBrowserPack(sdk);
  await verifyBrowserNotices(sdk, (name) => files.get(`extension/dist/notices/titan/${name}`));
  for (const name of await tree(path.join(repository, "dist/notices"))) {
    assert.equal(hash(files.get(`extension/dist/notices/${name}`)), hash(await readFile(path.join(repository, "dist/notices", name))), `VSIX notice differs: ${name}`);
  }
  const rocks = await verifyCompilerRocks(sdk, { platform: "win32" });
  for (const component of rocks) {
    const notice = files.get(`extension/dist/notices/${component.notice}`);
    assert(notice, `VSIX lacks LuaRocks dependency notice: ${component.notice}`);
    assert.equal(notice.toString("utf8"), component.license,
      `VSIX LuaRocks dependency notice differs: ${component.notice}`);
  }
  const scratch = await mkdtemp(path.join(tmpdir(), "titan-vsix-pe-"));
  try {
    const report = [];
    for (const name of packageImages) {
      const bytes = files.get(`extension/${name}`), input = path.join(scratch, name);
      assert.equal(hash(bytes), hash(await readFile(path.join(repository, name))), `VSIX image differs from staged bytes: ${name}`);
      await mkdir(path.dirname(input), { recursive: true });
      await writeFile(input, bytes);
      const result = spawnSync(readobj, ["--coff-imports", input], { encoding: "utf8", shell: false, windowsHide: true });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `PE inspection failed: ${result.stderr}`);
      report.push({ path: name, sha256: hash(bytes), imports: validateImports(name, result.stdout) });
    }
    for (const { path: relative } of payload) {
      const destination = path.join(scratch, "dist/titan", relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, files.get(payloadPrefix + relative));
    }
    const root = path.join(scratch, "dist/titan");
    const share = path.join(root, "share/lua/5.5");
    const smoke = spawnSync(process.execPath, [
      path.join(repository, "scripts/test-multi-root.mjs"),
      path.join(scratch, "bin/titan-language-server.exe"), "browser-packaged"
    ], {
      cwd: scratch,
      env: {
        ...compilerDiscoveryEnvironment(),
        TITAN_ROOT: root,
        TITAN_TEST_HOST_SDK: sdk,
        TITAN_LS_LUA_PATH: `${share}/?.lua;${share}/?/init.lua`,
        TITAN_LS_LUA_CPATH: `${path.join(root, "lib/lua/5.5")}/?.dll`
      },
      encoding: "utf8", shell: false, windowsHide: true
    });
    if (smoke.error) throw smoke.error;
    assert.equal(smoke.status, 0, `extracted Windows browser smoke failed: ${smoke.stderr}`);
    process.stdout.write(smoke.stdout);
    return { target: "win32-x64", vsixSha256: hash(await readFile(filename)), files: files.size, images: report };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [filename, sdk, readobj] = process.argv.slice(2);
    assert(filename && sdk && readobj, "usage: inspect-windows-package.mjs VSIX SDK LLVM_READOBJ");
    console.log(JSON.stringify(await inspectPackage(filename, sdk, readobj, fileURLToPath(new URL("..", import.meta.url))), null, 2));
  } catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
