import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { compilerArgument, runtimeDlls, childEnvironment, windowsPathContains, assertBuildRootOutsideSdk,
  buildProfileEnvironment, nativeBuildFlags, nativeBuildDirectory, windowsCompilerCommand,
  windowsApplicationArguments } from "./build-windows.mjs";

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

test("Windows applications delegate source and native graphs to one compiler invocation", () => {
  for (const testBuild of [false, true]) {
    const directory = path.resolve("build space", testBuild ? "tests" : "server");
    const sourceRoot = path.resolve("source space");
    const embeddedSource = path.resolve("generated", "embedded.c"), sdk = path.resolve("sdk");
    const args = windowsApplicationArguments({ sourceRoot, directory, embeddedSource, sdk, test: testBuild });
    assert.equal(args[args.indexOf("--tree") + 1], sourceRoot.replaceAll("\\", "/"));
    assert.equal(args[args.indexOf("--output") + 1], directory.replaceAll("\\", "/"));
    assert.equal(args[args.indexOf("--exe") + 1],
      path.join(directory, "bin", testBuild ? "server.tests.exe" : "titan-language-server.exe").replaceAll("\\", "/"));
    assert(args.includes("--source-first") && args.includes("--incremental"));
    assert(!args.includes("--static") && !args.includes("-c"));
    assert.equal(args.filter((arg) => arg === "--c-source").length, 2);
    assert(args.includes(embeddedSource.replaceAll("\\", "/")));
    assert.equal(args.at(-1), testBuild ? "server.tests" : "titan_language_server");
    assert.equal(args.includes("--test"), testBuild);
    assert.equal(args.includes("--no-uv-bootstrap"), testBuild);
    assert.equal(args.includes("--ldflag=-Wl,--stack,8388608"), testBuild);
    assert(args.includes("-lcrypto"));
  }
});

test("the router worker fixture is a private compiler-owned application", () => {
  const sourceRoot = `${path.resolve("src")};${path.resolve("test/fixtures")}`;
  const directory = path.resolve("tests/native/router-worker");
  const args = windowsApplicationArguments({ sourceRoot, directory,
    embeddedSource: path.resolve("native/embedded.c"), sdk: path.resolve("sdk"),
    entry: "router_worker_fixture", executable: "router_worker_fixture.exe" });
  assert.equal(args[args.indexOf("--tree") + 1], sourceRoot.replaceAll("\\", "/"));
  assert.equal(args[args.indexOf("--output") + 1], directory.replaceAll("\\", "/"));
  assert.equal(args[args.indexOf("--exe") + 1],
    path.join(directory, "bin/router_worker_fixture.exe").replaceAll("\\", "/"));
  assert.equal(args.at(-1), "router_worker_fixture");
  assert(args.includes("--source-first") && args.includes("--incremental"));
  assert(!args.includes("--test") && !args.includes("--no-uv-bootstrap"));
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

test("Windows test targets select validation while deliverables select production", () => {
  for (const target of ["server-test-build", "server-test-run"]) {
    const environment = buildProfileEnvironment(target, {});
    assert.equal(environment.VSCODE_TITAN_BUILD_PROFILE, "validation");
    assert.equal(environment.TITAN_BUILD_PROFILE, "validation");
  }
  for (const target of ["server", "stage", "package"]) {
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


test("Windows compilation invokes the installed compiler program directly", () => {
  const sdk = "C:\\SDK space 路径";
  const arguments_ = ["--tree", "source space", "server.root"];
  assert.deepEqual(windowsCompilerCommand(sdk, arguments_), {
    command: path.win32.join(sdk, "bin", "titanc.exe"),
    args: arguments_
  });
  assert.deepEqual(arguments_, ["--tree", "source space", "server.root"]);
});

