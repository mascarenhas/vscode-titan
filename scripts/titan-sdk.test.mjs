import assert from "node:assert/strict";
import test from "node:test";
import { compilerDiscoveryEnvironment, findWindowsCompiler, resolveTitanSdk } from "./titan-sdk.mjs";

test("explicit SDK overrides PATH without invoking a compiler", () => {
  const run = () => assert.fail("explicit SDK must not query PATH");
  assert.equal(resolveTitanSdk({ platform: "linux", prefix: "/opt/titan", environment: { TITAN_PREFIX: "/other" }, run }), "/opt/titan");
  assert.equal(resolveTitanSdk({ platform: "win32", environment: { Titan_Prefix: "C:\\Titan SDK" }, run }), "C:\\Titan SDK");
});

test("PATH compiler reports its SDK independently of Lua and probe overrides", () => {
  const environment = { PATH: "/selected/bin", TITAN_PREFIX: "", TITAN_ROCKS_ROOT: "/wrong",
    LUA_PATH: "/wrong", LUA_CPATH_5_5: "/wrong", LUA_INIT_5_5: "wrong", TITAN_PATH_0_6: "/wrong", CC: "cc" };
  const prefix = resolveTitanSdk({ platform: "linux", environment, run(command, args, options) {
    assert.equal(command, "titanc");
    assert.deepEqual(args, ["--print-prefix"]);
    assert.deepEqual(options.env, { PATH: "/selected/bin", CC: "cc" });
    assert.equal(options.shell, false);
    return { status: 0, stdout: "/actual/sdk with spaces\n" };
  } });
  assert.equal(prefix, "/actual/sdk with spaces");
});

test("Windows PATH lookup honors case-insensitive variables and PATHEXT order", () => {
  const tried = [];
  const compiler = findWindowsCompiler({ Path: '"C:\\Other";C:\\Titan SDK\\bin', PathExt: ".EXE;.BAT" }, (filename) => {
    tried.push(filename);
    return filename === "C:\\Titan SDK\\bin\\titanc.BAT";
  });
  assert.equal(compiler, "C:\\Titan SDK\\bin\\titanc.BAT");
  assert.equal(tried[0], "C:\\Other\\titanc.EXE");
});

test("Windows batch discovery uses relocated adjacent Lua with native arguments", () => {
  const prefix = resolveTitanSdk({ platform: "win32", environment: { Path: "C:\\Titan SDK\\bin" },
    findCompiler: () => "C:\\Alias\\titanc.bat", realpath: () => "D:\\Moved Titan\\bin\\titanc.bat",
    run(command, args, options) {
      assert.equal(command, "D:\\Moved Titan\\bin\\lua.exe");
      assert.deepEqual(args, ["-E", "D:\\Moved Titan\\lib\\luarocks\\rocks-5.5\\titan\\0.6.0-1\\bin\\titanc", "--print-prefix"]);
      assert.equal(options.shell, false);
      return { status: 0, stdout: "D:/Moved Titan\r\n" };
    } });
  assert.equal(prefix, "D:\\Moved Titan");
});

test("discovery failures are actionable and malformed output is rejected", () => {
  const environment = {};
  assert.throws(() => resolveTitanSdk({ platform: "linux", environment, run: () => ({ error: new Error("ENOENT") }) }), /set TITAN_PREFIX/);
  assert.throws(() => resolveTitanSdk({ platform: "linux", environment, run: () => ({ status: 2, stderr: "unknown option" }) }), /unknown option/);
  for (const stdout of ["", "relative\n", "/sdk\nnoise\n", "/sdk\0\n"]) {
    assert.throws(() => resolveTitanSdk({ platform: "linux", environment, run: () => ({ status: 0, stdout }) }), /one absolute/);
  }
  assert.deepEqual(compilerDiscoveryEnvironment({ Path: "selected", tItAn_RoCkS_rOoT: "wrong" }), { Path: "selected" });
});

test("Windows prefix queries preserve extended path components", () => {
  const prefix = "\\\\?\\C:\\SDK\\literal\\..\\Titan";
  assert.equal(resolveTitanSdk({ platform: "win32", environment: {},
    findCompiler: () => "C:\\SDK\\titanc.exe",
    run: () => ({ status: 0, stdout: prefix + "\r\n" })
  }), prefix);
});
