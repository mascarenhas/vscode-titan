import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectPackage, validateImports, packageImages } from "./inspect-windows-package.mjs";

const pe = "Format: COFF-x86-64\nArch: x86_64\n";
test("Windows package inspection validates required SDK headers and permits unrelated installed headers", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "titan-vsix-headers-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sdk = path.join(root, "sdk"), include = path.join(sdk, "include");
  for (const name of ["titan", "uv"]) await mkdir(path.join(include, name), { recursive: true });
  for (const name of ["lauxlib.h", "llhttp.h", "luaconf.h", "lua.h", "lua.hpp", "lualib.h",
    "minicoro.h", "sqlite3.h", "titan.h", "transfer.h", "uv.h", "backtrace.h", "backtrace-supported.h"]) {
    await writeFile(path.join(include, name), `/* ${name} */\n`);
  }
  const inspect = () => inspectPackage(path.join(root, "missing.vsix"), sdk, "unused", root);
  await assert.rejects(inspect(), { code: "ENOENT" });
  await rm(path.join(include, "backtrace.h"));
  await assert.rejects(inspect(), /SDK include tree inventory changed/);
  await rm(path.join(include, "backtrace-supported.h"));
  await assert.rejects(inspect(), { code: "ENOENT" });
  await writeFile(path.join(include, "unreviewed.h"), "unreviewed\n");
  await assert.rejects(inspect(), { code: "ENOENT" });
});

test("delivered images use the controlled Lua/native DLLs and Windows APIs", () => {
  assert.deepEqual(validateImports("server.dll", pe + "Import {\n Name: lua55.dll\n}\nImport {\n Name: KERNEL32.dll\n}\nImport {\n Name: api-ms-win-crt-runtime-l1-1-0.dll\n}\n"),
    ["lua55.dll", "kernel32.dll", "api-ms-win-crt-runtime-l1-1-0.dll"]);
  assert.equal(packageImages.length, 12);
  assert(packageImages.includes("dist/titan/lib/lua/5.5/luv.dll"));
  assert(packageImages.includes("bin/lua55.dll"));
  assert(!packageImages.includes("bin/lua-5.5.1.dll"));
});
test("unreviewed compiler runtimes and wrong architecture fail inspection", () => {
  for (const library of ["lua-5.5.1.dll", "libc++.dll", "libgcc_s_seh-1.dll", "msys-2.0.dll", "libwinpthread-1.dll", "VCRUNTIME140.dll"])
    assert.throws(() => validateImports("server.dll", pe + `Import {\n Name: ${library}\n}\n`), /unreviewed runtime dependency/);
  assert.throws(() => validateImports("server.dll", "Format: COFF-i386\nArch: i386\n Name: KERNEL32.dll\n"), /wrong PE architecture/);
});

test("libuv permits the exact Windows synchronization API set and rejects unreviewed contracts", () => {
  const image = "bin/libuv-1.dll";
  const imports = "Import {\n Name: KERNEL32.dll\n}\n" +
    "Import {\n Name: API-MS-Win-Core-Synch-l1-2-0.dll\n}\n";
  assert.deepEqual(validateImports(image, pe + imports),
    ["kernel32.dll", "api-ms-win-core-synch-l1-2-0.dll"]);
  for (const name of ["api-ms-win-core-synch-l1-2-1.dll", "api-ms-win-core-file-l1-2-0.dll",
    "api-ms-win-core-synch-l1-2-0.dll.extra", "api-ms-win-core-unreviewed-l1-1-0.dll",
    "ext-ms-win-unreviewed-l1-1-0.dll", "unreviewed.dll"]) {
    assert.throws(() => validateImports(image, pe + imports + `Import {\n Name: ${name}\n}\n`),
      /unreviewed runtime dependency/);
  }
});


test("compiler luv uses the same Lua runtime and permitted Windows APIs", () => {
  assert.deepEqual(validateImports("dist/titan/lib/lua/5.5/luv.dll", pe +
    "Import {\n Name: lua55.dll\n}\nImport {\n Name: WS2_32.dll\n}\n" +
    "Import {\n Name: IPHLPAPI.DLL\n}\nImport {\n Name: dbghelp.dll\n}\n"),
  ["lua55.dll", "ws2_32.dll", "iphlpapi.dll", "dbghelp.dll"]);
});
