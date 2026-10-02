import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { orderedModules, moduleOutputs, compilerArgument, runtimeDlls, childEnvironment, selectedBuildEnvironment,
  windowsPathContains, assertBuildRootOutsideSdk } from "./build-windows.mjs";

test("SDK ownership recognizes Windows case variants without confusing sibling prefixes", () => {
  for (const candidate of ["c:\\sdk", "C:\\SDK\\build", "c:/Sdk/missing/child"]) {
    assert(windowsPathContains("C:\\sdk", candidate), candidate);
  }
  for (const candidate of ["C:\\sdk-build", "C:\\sibling\\build", "D:\\sdk", "C:\\"]) {
    assert(!windowsPathContains("C:\\sdk", candidate), candidate);
  }
});

test("SDK ownership resolves both existing directories and future children", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "titan-sdk-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sdk = path.join(root, "sdk");
  await mkdir(path.join(sdk, "existing"), { recursive: true });
  for (const destination of [sdk, path.join(sdk, "existing"), path.join(sdk, "future", "build")]) {
    await assert.rejects(assertBuildRootOutsideSdk(sdk, destination), /outside the read-only SDK/);
  }
  if (process.platform === "win32") {
    await assert.rejects(assertBuildRootOutsideSdk(sdk, path.join(sdk.toUpperCase(), "future")),
      /outside the read-only SDK/);
  }
  await assertBuildRootOutsideSdk(sdk, path.join(root, "sdk-build", "future"));
  await assertBuildRootOutsideSdk(sdk, path.join(root, "sibling"));
});

test("SDK ownership rejects real directory aliases or preserves traversal failures", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "titan-sdk-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sdk = path.join(root, "sdk"), alias = path.join(root, "alias");
  await mkdir(sdk);
  const linkType = process.platform === "win32" ? "junction" : "dir";
  try { await symlink(sdk, alias, linkType); }
  catch (error) {
    if (process.platform === "win32" && ["EACCES", "EPERM"].includes(error.code)) {
      t.skip("directory alias fixture creation was denied"); return;
    }
    throw error;
  }
  assert((await lstat(alias)).isSymbolicLink());
  assert.equal(await readlink(alias), sdk);
  let traversalError;
  try { await realpath(alias); } catch (error) { traversalError = error; }
  if (traversalError) {
    // Some nonadmin Windows sessions create junctions but cannot follow them.
    // Prove error propagation and no writes, not successful alias resolution.
    const sameFailure = (error) => error.code === traversalError.code &&
      error.errno === traversalError.errno && error.syscall === traversalError.syscall;
    for (const destination of [alias, path.join(alias, "future", "build")]) {
      await assert.rejects(assertBuildRootOutsideSdk(sdk, destination), sameFailure);
    }
    await assert.rejects(assertBuildRootOutsideSdk(alias, path.join(root, "sibling")), sameFailure);
    assert.deepEqual(await readdir(sdk), []);
    t.diagnostic(`Directory alias traversal unavailable (${traversalError.code}, ${traversalError.errno}); ` +
      "verified unchanged lookup failure and no SDK writes. Supported-alias resolution was not exercised.");
    return;
  }
  for (const destination of [alias, path.join(alias, "future", "build")]) {
    await assert.rejects(assertBuildRootOutsideSdk(sdk, destination), /outside the read-only SDK/);
  }
  await assert.rejects(assertBuildRootOutsideSdk(alias, path.join(sdk, "build")), /outside the read-only SDK/);
  await assertBuildRootOutsideSdk(alias, path.join(root, "sibling"));
  const unresolved = path.join(root, "unresolved");
  await symlink(path.join(sdk, "not-created"), unresolved, linkType);
  await assert.rejects(assertBuildRootOutsideSdk(sdk, path.join(unresolved, "build")),
    /cannot resolve existing build path/);
  assert.deepEqual(await readdir(sdk), []);
});

test("Windows scheduling follows parsed dependencies once and rejects cycles", () => {
  const module = (imports = []) => ({ imports, parseError: null });
  const plan = { modules: { root: module(["left", "right"]), left: module(["shared"]), right: module(["shared"]), shared: module() } };
  assert.deepEqual(orderedModules(plan, ["root"]), ["shared", "left", "right", "root"]);
  plan.modules.shared.imports.push("root");
  assert.throws(() => orderedModules(plan, ["root"]), /cyclic source imports/);
});

test("an unrelated broken test does not prevent a production graph", () => {
  const plan = { modules: { server: { imports: [], parseError: null }, tests: { imports: [], parseError: "broken test source" } } };
  assert.deepEqual(orderedModules(plan, ["server"]), ["server"]);
  assert.throws(() => orderedModules(plan, ["tests"]), /broken test source/);
});

test("folder modules own one source stem and foreign companion", () => {
  const outputs = moduleOutputs("stage", { main: "owner/owner.titan", foreign: true });
  assert.deepEqual(outputs, [".o", ".c", ".ffi.h", ".titan.h"].map((suffix) => path.join("stage", "owner", "owner") + suffix));
});

test("configured compiler arguments retain spaces and Unicode without a command shell", () => {
  assert.equal(compilerArgument("C:\\Program Files\\路径\\clang.exe"), '"C:/Program Files/路径/clang.exe"');
  assert.throws(() => compilerArgument('C:/bad"argument'), /cannot contain/);
  assert.throws(() => compilerArgument("bad\nargument"), /cannot contain/);
  assert.deepEqual(runtimeDlls, ["lua-5.5.1.dll", "libuv-1.dll", "libllhttp-9.4.dll", "libsqlite3-0.dll", "libssl-3-x64.dll", "libcrypto-3-x64.dll"]);
});

test("child build environment overrides all Windows spellings and leaves its parent untouched", () => {
  const parent = { Path: "old", PATH: "also old", cc: "old-cc", CC: "other-cc", Lua_Path_5_5: "ambient", Unrelated: "keep" };
  const snapshot = { ...parent };
  assert.deepEqual(childEnvironment(parent, { PATH: "new", CC: "new-cc" }, ["LUA_PATH_5_5"]),
    { Unrelated: "keep", PATH: "new", CC: "new-cc" });
  assert.deepEqual(parent, snapshot);
});

test("build fingerprints retain explicit compiler controls and exclude unrelated environment", () => {
  const controls = { CC: "chosen-clang", AR: "chosen-ar", RANLIB: "chosen-ranlib", RC: "chosen-rc",
    TITAN_EXTRA_CPPFLAGS: "-DTEST=1", TITAN_EXTRA_CFLAGS: "-O0", TITAN_EXTRA_LDFLAGS: "-s" };
  const selected = selectedBuildEnvironment({ ...controls, UNRELATED_BUILD_NOTE: "exclude this" });
  for (const [key, value] of Object.entries(controls)) assert.equal(selected[key], value);
  assert(!Object.hasOwn(selected, "UNRELATED_BUILD_NOTE"));
  assert.deepEqual(selected, selectedBuildEnvironment({ ...controls, UNRELATED_BUILD_NOTE: "changed unrelated input" }));
});
