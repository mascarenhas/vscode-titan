import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { childEnvironment, resolveTitanSdk, titanCompilerCommand } from "./titan-sdk.mjs";

export const runtimeDlls = [
  "lua55.dll", "libuv-1.dll", "libllhttp-9.4.dll", "libsqlite3-0.dll",
  "libssl-3-x64.dll", "libcrypto-3-x64.dll"
];
const repository = fileURLToPath(new URL("..", import.meta.url));
const forward = (value) => value.replaceAll("\\", "/");
const hash = (value) => createHash("sha256").update(value).digest("hex");

// Run the installed native compiler program directly. titanc.exe resolves its
// own installation root and frontend script, so native argv, relocation and
// spaces in the SDK path all work without entering cmd.exe.
export function windowsCompilerCommand(sdk, args = []) {
  return titanCompilerCommand(sdk, args, "win32");
}

export function nativeBuildDirectory(buildRoot, target) {
  return path.join(buildRoot,
    ["server-test-build", "server-test-run"].includes(target) ? "tests" : "server", "native");
}

// These strings are parsed by Titan's configured-command parser, not a shell.
// Forward slashes avoid backslash escapes; double quotes retain spaces.
export function compilerArgument(value) {
  assert(!/[\0\r\n"]/.test(value), "native tool arguments cannot contain NUL/newline/quotes");
  return `"${forward(value)}"`;
}

export function windowsApplicationArguments({ sourceRoot, directory, embeddedSource, sdk, test = false,
  entry = test ? "server.tests" : "titan_language_server",
  executable = test ? "server.tests.exe" : "titan-language-server.exe" }) {
  return ["--tree", forward(sourceRoot), "--output", forward(directory), "--source-first", "--incremental",
    "--exe", forward(path.join(directory, "bin", executable)),
    "-I", forward(path.join(repository, "src/server")),
    "--c-source", forward(path.join(repository, "src/server/compiler_io_clock.c")),
    "--c-source", forward(embeddedSource), "-L", forward(path.join(sdk, "lib")), "-lcrypto",
    ...(test ? ["--test", "--no-uv-bootstrap", "--ldflag=-Wl,--stack,8388608"] : []),
    entry];
}

export function buildProfileEnvironment(target, inherited, requestedProfile) {
  const selected = Object.fromEntries(Object.entries(inherited).map(([name, value]) => [name.toUpperCase(), value]));
  const profile = requestedProfile ?? selected.VSCODE_TITAN_BUILD_PROFILE ?? selected.TITAN_BUILD_PROFILE ??
    (["server-test-build", "server-test-run"].includes(target) ? "validation" : "production");
  assert(["validation", "production"].includes(profile),
    "build profile must be validation or production");
  const overrides = { VSCODE_TITAN_BUILD_PROFILE: profile, TITAN_BUILD_PROFILE: profile };
  for (const key of ["TITAN_EXTRA_CPPFLAGS", "TITAN_EXTRA_CFLAGS", "TITAN_EXTRA_LDFLAGS"]) {
    if (selected[key] !== undefined) overrides[key] = selected[key];
  }
  return childEnvironment(inherited, overrides, [], "win32");
}

export function nativeBuildFlags(profile, { cppflags = [], cflags = [], ldflags = [] } = {}) {
  assert(["validation", "production"].includes(profile),
    "build profile must be validation or production");
  const validation = profile === "validation";
  return {
    cppflags: [...cppflags],
    cflags: ["-std=c99", validation ? "-O0" : "-O3", ...(validation ? ["-fno-lto"] : []),
      "-Wall", "-Wextra", "-Werror", ...cflags],
    ldflags: [...(validation ? ["-fno-lto"] : []), ...ldflags]
  };
}

function nativeExtraFlags(lua, environment) {
  // Reuse the compiler's configured-command grammar for quoted inherited
  // flags. NUL-delimited words retain spaces and empty arguments without a shell.
  const script = 'local driver = require("titan-compiler.driver"); ' +
    'for _, name in ipairs({"TITAN_EXTRA_CPPFLAGS", "TITAN_EXTRA_CFLAGS", "TITAN_EXTRA_LDFLAGS"}) do ' +
    'local words, err = driver.split_shell_words(os.getenv(name) or ""); ' +
    'assert(words, name .. ": " .. tostring(err)); io.write(tostring(#words), "\\0"); ' +
    'for _, word in ipairs(words) do io.write(word, "\\0") end end';
  const result = spawnSync(lua, ["-E", "-e", script], {
    env: environment, encoding: "utf8", windowsHide: true, shell: false
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || "compiler could not parse native flags");
  const words = result.stdout.split("\0");
  assert.equal(words.pop(), "", "invalid compiler flag response");
  const flags = {};
  for (const key of ["cppflags", "cflags", "ldflags"]) {
    const count = Number(words.shift());
    assert(Number.isInteger(count) && count >= 0 && count <= words.length,
      "invalid compiler flag vector");
    flags[key] = words.splice(0, count);
  }
  assert.equal(words.length, 0, "unexpected compiler flag words");
  return flags;
}

async function fileDigest(filename) {
  assert((await lstat(filename)).isFile(), `expected regular input: ${filename}`);
  return hash(await readFile(filename));
}
async function allFiles(files) {
  for (const file of files) {
    try { if (!(await lstat(file)).isFile()) return false; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }
  return true;
}
async function copyChanged(source, destination) {
  const digest = await fileDigest(source);
  if (await allFiles([destination]) && await fileDigest(destination) === digest) return;
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

export function windowsPathContains(root, candidate) {
  const relative = path.win32.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith("..\\") &&
    !path.win32.isAbsolute(relative));
}

export async function assertBuildRootOutsideSdk(sdk, buildRoot) {
  const sdkDirectory = await realpath(sdk);
  let ancestor = path.resolve(buildRoot);
  const missing = [];
  for (;;) {
    let directory;
    try { directory = await realpath(ancestor); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      // An unresolved existing link must fail closed, not be treated as a
      // missing directory whose physical location is its lexical parent.
      try {
        await lstat(ancestor);
        throw new Error(`cannot resolve existing build path: ${ancestor}`);
      } catch (inspectError) {
        if (inspectError.code !== "ENOENT") throw inspectError;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
      continue;
    }
    const destination = path.join(directory, ...missing);
    assert(!windowsPathContains(sdkDirectory, destination),
      "build output must be outside the read-only SDK");
    return;
  }
}

export async function buildWindows(target, {
  sdk, buildRoot = path.join(repository, ".build", "windows"), sourceRoot = path.join(repository, "src"),
  clang, ar, ranlib, filter, buildProfile
} = {}) {
  assert(process.platform === "win32" && process.arch === "x64", "Windows x64 native tools are required");
  sdk = resolveTitanSdk({ prefix: sdk });
  assert(clang && ar && ranlib, "supply --clang, --ar and --ranlib absolute executable paths");
  for (const value of [sdk, clang, ar, ranlib, buildRoot, sourceRoot]) {
    assert(path.isAbsolute(value), `an absolute path is required: ${value}`);
  }
  sdk = path.resolve(sdk); buildRoot = path.resolve(buildRoot); sourceRoot = path.resolve(sourceRoot);
  await assertBuildRootOutsideSdk(sdk, buildRoot);
  const targets = ["server", "server-test-build", "server-test-run", "stage", "package"];
  assert(targets.includes(target), `expected one of ${targets.join(", ")}`);
  const lua = path.join(sdk, "bin", "lua.exe");
  const inheritedPath = Object.entries(process.env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const env = childEnvironment(buildProfileEnvironment(target, process.env, buildProfile), {
    CC: compilerArgument(clang), AR: compilerArgument(ar), RANLIB: compilerArgument(ranlib),
    RC: compilerArgument(path.join(path.dirname(clang), "llvm-rc.exe")),
    CCACHE_DISABLE: "1", TITAN_ROOT: sdk, TITAN_PREFIX: path.join(buildRoot, "compiler-cache"),
    PATH: `${path.dirname(process.execPath)};${path.dirname(clang)};${path.join(sdk, "bin")};${inheritedPath}`,
    TITAN_PATH_0_6: forward(path.join(sdk, "lib/titan/0.6")),
    TITAN_PATH: forward(path.join(sdk, "lib/titan/0.6")),
    LUA_PATH: `${forward(sdk)}/share/lua/5.5/?.lua;${forward(sdk)}/share/lua/5.5/?/init.lua`,
    // The support module is the ordinary Lua native module; the standard
    // provider directory holds Titan providers, not Lua C modules.
    LUA_CPATH: `${forward(sdk)}/lib/lua/5.5/?.dll`
  }, ["LUA_PATH_5_5", "LUA_CPATH_5_5", "TITAN_SOURCE_PATH"]);
  function run(command, args, cwd = repository, overrides = {}) {
    console.log(JSON.stringify({ command, args, cwd }));
    const result = spawnSync(command, args, {
      cwd, env: childEnvironment(env, overrides), stdio: "inherit", windowsHide: true, shell: false
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${path.basename(command)} failed (${result.signal ?? result.status})`);
  }
  function compile(args, cwd, overrides) {
    const invocation = windowsCompilerCommand(sdk, args);
    run(invocation.command, invocation.args, cwd, overrides);
  }
  await mkdir(buildRoot, { recursive: true });
  const lockPath = path.join(buildRoot, "build.lock");
  const lock = await open(lockPath, "wx");
  try {
    await lock.writeFile(`${process.pid}\n`);
    const fixture = path.join(nativeBuildDirectory(buildRoot, target), "compiler_io_process_fixture.exe");
    const routerFixtureDirectory = path.join(nativeBuildDirectory(buildRoot, target), "router-worker");
    const routerFixture = path.join(routerFixtureDirectory, "bin", "router_worker_fixture.exe");
    const testExe = path.join(buildRoot, "tests", "bin", "server.tests.exe");
    if (target === "server-test-run") {
      const testEnv = { ...env, TITAN_PROBE_CACHE_DISABLE: "1", TITAN_COMPILER_IO_PROCESS_FIXTURE: fixture,
        TITAN_ROUTER_WORKER_FIXTURE: routerFixture,
        LUA_PATH_5_5: env.LUA_PATH, LUA_CPATH_5_5: env.LUA_CPATH };
      delete testEnv.TITAN_PATH; delete testEnv.TITAN_PATH_0_6;
      const result = spawnSync(testExe, filter ? [`--filter=${filter}`] : [], {
        cwd: path.dirname(testExe), env: testEnv, stdio: "inherit", windowsHide: true
      });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `native tests failed (${result.signal ?? result.status})`);
      return;
    }
    const test = target === "server-test-build";
    const directory = path.join(buildRoot, test ? "tests" : "server");
    const native = nativeBuildDirectory(buildRoot, target);
    await mkdir(directory, { recursive: true });
    await mkdir(native, { recursive: true });
    const embeddedSource = path.join(native, "embedded_interfaces_profile_windows.c");
    run(lua, ["scripts/generate-embedded-interfaces.lua", "--windows-profile", sdk, embeddedSource]);
    if (test) {
      const flags = nativeBuildFlags(env.TITAN_BUILD_PROFILE, nativeExtraFlags(lua, env));
      run(clang, [...flags.cppflags, ...flags.cflags, "-municode",
        "test/fixtures/compiler-io-process.c", ...flags.ldflags, "-o", fixture]);
      compile(windowsApplicationArguments({
        sourceRoot: `${path.join(repository, "src")};${path.join(repository, "test/fixtures")}`,
        directory: routerFixtureDirectory, embeddedSource, sdk,
        entry: "router_worker_fixture", executable: "router_worker_fixture.exe"
      }), repository);
    }
    compile(windowsApplicationArguments({ sourceRoot, directory, embeddedSource, sdk, test }), repository);
    for (const destination of test ? [directory, routerFixtureDirectory] : [directory]) {
      for (const name of runtimeDlls) await copyChanged(path.join(sdk, "bin", name), path.join(destination, "bin", name));
      await copyChanged(path.join(sdk, "lib/titan/0.6/titan.dll"), path.join(destination, "lib/titan/0.6/titan.dll"));
    }
    if (test) return;
    // The extension's bin is the launcher's installation bin; DLL providers are
    // siblings under lib/titan/0.6, preserving Titan's normal runtime lookup.
    for (const name of [...runtimeDlls, "titan-language-server.exe"]) {
      await copyChanged(path.join(directory, "bin", name), path.join(repository, "bin", name));
    }
    for (const name of ["titan.dll", "titan_language_server.dll"]) {
      await copyChanged(path.join(directory, "lib/titan/0.6", name), path.join(repository, "lib/titan/0.6", name));
    }
    if (["stage", "package"].includes(target)) {
      if (target === "stage") {
        run(process.execPath, ["scripts/browser-semantic-pack.mjs", "--check-prefix", sdk]);
      }
      run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--noEmit"]);
      run(process.execPath, ["scripts/esbuild.mjs"]);
      run(process.execPath, ["scripts/stage-lua-modules.mjs"], repository, { TITAN_PREFIX: sdk });
      run(process.execPath, ["scripts/stage-notices.mjs"], repository, { TITAN_PREFIX: sdk });
    }
    if (target === "package") {
      const destination = path.join(buildRoot, "vsix/titan-win32-x64.vsix");
      await mkdir(path.dirname(destination), { recursive: true });
      run(process.execPath, ["node_modules/@vscode/vsce/vsce", "package", "--no-dependencies",
        "--target", "win32-x64", "--out", destination], repository, { TITAN_PREFIX: sdk });
      run(process.execPath, ["scripts/inspect-windows-package.mjs", destination, sdk,
        path.join(path.dirname(clang), "llvm-readobj.exe")]);
    }
  } finally { await lock.close(); await rm(lockPath); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [target, ...rest] = process.argv.slice(2), options = {};
    for (let index = 0; index < rest.length; index += 2) {
      const key = { "--sdk": "sdk", "--build-root": "buildRoot", "--source-root": "sourceRoot",
        "--clang": "clang", "--ar": "ar", "--ranlib": "ranlib", "--filter": "filter",
        "--build-profile": "buildProfile" }[rest[index]];
      assert(key && rest[index + 1] !== undefined, `invalid option ${rest[index]}`);
      options[key] = rest[index + 1];
    }
    await buildWindows(target, options);
  } catch (error) { console.error(error.stack ?? error); process.exitCode = 1; }
}
