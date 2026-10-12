import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { orderedModules, moduleOutputs, compilerArgument, runtimeDlls, childEnvironment, selectedBuildEnvironment,
  windowsPathContains, assertBuildRootOutsideSdk, buildProfileEnvironment, nativeBuildFlags,
  nativeBuildDirectory, windowsCompilerCommand, windowsApplicationLinkFlags } from "./build-windows.mjs";

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
  assert.deepEqual(runtimeDlls, ["lua55.dll", "libuv-1.dll", "libllhttp-9.4.dll", "libsqlite3-0.dll", "libssl-3-x64.dll", "libcrypto-3-x64.dll"]);
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

test("Windows test targets select validation while deliverables select production", () => {
  for (const target of ["server-test-build", "server-test-run"]) {
    const environment = buildProfileEnvironment(target, {});
    assert.equal(environment.VSCODE_TITAN_BUILD_PROFILE, "validation");
    assert.equal(environment.TITAN_BUILD_PROFILE, "validation");
  }
  for (const target of ["plan", "server", "stage", "package"]) {
    assert.equal(buildProfileEnvironment(target, {}).TITAN_BUILD_PROFILE, "production");
  }
});

test("explicit Windows profile selection overrides environment and rejects unknown profiles", () => {
  assert.equal(buildProfileEnvironment("server", { vscode_titan_build_profile: "validation" })
    .TITAN_BUILD_PROFILE, "validation");
  assert.equal(buildProfileEnvironment("server-test-build", { TITAN_BUILD_PROFILE: "production" })
    .TITAN_BUILD_PROFILE, "production");
  assert.equal(buildProfileEnvironment("server", { VSCODE_TITAN_BUILD_PROFILE: "validation" }, "production")
    .TITAN_BUILD_PROFILE, "production");
  assert.throws(() => buildProfileEnvironment("server", {}, "optimized"), /validation or production/);
  assert.throws(() => buildProfileEnvironment("server", { TITAN_BUILD_PROFILE: "unknown" }),
    /validation or production/);
});

test("profile selection retains explicit sanitizer overrides with canonical Windows spellings", () => {
  const inherited = { Titan_Extra_Cflags: "-O1 -fsanitize=address", titan_extra_ldflags: "-fsanitize=address",
    TITAN_EXTRA_CPPFLAGS: '-DNAME="two words"', Unrelated: "keep" };
  const snapshot = { ...inherited };
  const environment = buildProfileEnvironment("server-test-build", inherited);
  assert.equal(environment.TITAN_EXTRA_CFLAGS, "-O1 -fsanitize=address");
  assert.equal(environment.TITAN_EXTRA_LDFLAGS, "-fsanitize=address");
  assert.equal(environment.TITAN_EXTRA_CPPFLAGS, '-DNAME="two words"');
  assert(!Object.hasOwn(environment, "Titan_Extra_Cflags"));
  assert(!Object.hasOwn(environment, "titan_extra_ldflags"));
  assert.equal(environment.Unrelated, "keep");
  assert.deepEqual(inherited, snapshot);
});

test("native helpers share validation defaults and apply explicit compiler/link controls last", () => {
  const flags = nativeBuildFlags("validation", {
    cppflags: ["-DNAME=two words"], cflags: ["-O1", "-fsanitize=address"],
    ldflags: ["-fsanitize=address", "-flto"]
  });
  assert.deepEqual(flags.cppflags, ["-DNAME=two words"]);
  assert.deepEqual(flags.cflags, ["-std=c99", "-O0", "-fno-lto", "-Wall", "-Wextra", "-Werror",
    "-O1", "-fsanitize=address"]);
  assert.deepEqual(flags.ldflags, ["-fno-lto", "-fsanitize=address", "-flto"]);
  const production = nativeBuildFlags("production");
  assert(production.cflags.includes("-O3"));
  assert(!production.cflags.includes("-O0"));
  assert(!production.cflags.includes("-fno-lto"));
  assert.deepEqual(production.ldflags, []);
});

test("production and test native helpers have separate graph ownership", () => {
  const testDirectory = nativeBuildDirectory("build", "server-test-build");
  assert.equal(nativeBuildDirectory("build", "server-test-run"), testDirectory,
    "test execution must find the fixture built by its graph");
  for (const target of ["server", "stage", "package"]) {
    const productionDirectory = nativeBuildDirectory("build", target);
    assert.equal(productionDirectory, path.join("build", "server", "native"));
    assert.notEqual(productionDirectory, testDirectory,
      "test profile must not replace native production link inputs");
  }
});

test("profile identity invalidates a graph even when explicit flags coincide", () => {
  const inherited = { TITAN_EXTRA_CFLAGS: "-O1", TITAN_EXTRA_LDFLAGS: "-fno-lto" };
  const validation = selectedBuildEnvironment(buildProfileEnvironment("server", inherited, "validation"));
  const production = selectedBuildEnvironment(buildProfileEnvironment("server", inherited, "production"));
  assert.equal(validation.TITAN_EXTRA_CFLAGS, production.TITAN_EXTRA_CFLAGS);
  assert.equal(validation.TITAN_EXTRA_LDFLAGS, production.TITAN_EXTRA_LDFLAGS);
  assert.notDeepEqual(validation, production);
});


test("Windows compilation invokes the installed LuaRocks script directly", () => {
  const sdk = "C:\\SDK space 路径";
  const arguments_ = ["--tree", "source space", "server.root"];
  assert.deepEqual(windowsCompilerCommand(sdk, arguments_), {
    command: path.win32.join(sdk, "bin", "lua.exe"),
    args: ["-E", path.win32.join(sdk, "lib", "luarocks", "rocks-5.5", "titan", "0.6.0-1", "bin", "titanc"), ...arguments_]
  });
  assert.deepEqual(arguments_, ["--tree", "source space", "server.root"]);
});

test("the Windows test aggregate reserves its own stack before explicit caller overrides", () => {
  const inputs = ["C:\\build space\\native.o", "C:\\sdk\\libcrypto.dll.a"];
  const extraFlags = "-Wl,--stack,16777216 -fsanitize=address";
  const nativeInputs = inputs.map(compilerArgument).join(" ");
  assert.equal(windowsApplicationLinkFlags({ test: true, extraFlags, inputs }),
    `-Wl,--stack,8388608 ${extraFlags} ${nativeInputs}`);
  assert.equal(windowsApplicationLinkFlags({ extraFlags, inputs }), `${extraFlags} ${nativeInputs}`);
  assert.equal(windowsApplicationLinkFlags({ test: true }), "-Wl,--stack,8388608");
  assert.equal(windowsApplicationLinkFlags(), "");
});
