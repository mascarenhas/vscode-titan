import assert from "node:assert/strict";
import test from "node:test";
import { validateImports, packageImages } from "./inspect-windows-package.mjs";

const pe = "Format: COFF-x86-64\nArch: x86_64\n";
test("delivered images use the controlled Lua/native DLLs and Windows APIs", () => {
  assert.deepEqual(validateImports("server.dll", pe + "Import {\n Name: lua-5.5.1.dll\n}\nImport {\n Name: KERNEL32.dll\n}\nImport {\n Name: api-ms-win-crt-runtime-l1-1-0.dll\n}\n"),
    ["lua-5.5.1.dll", "kernel32.dll", "api-ms-win-crt-runtime-l1-1-0.dll"]);
  assert.equal(packageImages.length, 11);
});
test("unreviewed compiler runtimes and wrong architecture fail inspection", () => {
  for (const library of ["libc++.dll", "libgcc_s_seh-1.dll", "msys-2.0.dll", "libwinpthread-1.dll", "VCRUNTIME140.dll"])
    assert.throws(() => validateImports("server.dll", pe + `Import {\n Name: ${library}\n}\n`), /unreviewed runtime dependency/);
  assert.throws(() => validateImports("server.dll", "Format: COFF-i386\nArch: i386\n Name: KERNEL32.dll\n"), /wrong PE architecture/);
});
