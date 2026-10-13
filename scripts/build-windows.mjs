import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTitanSdk, titanCompilerCommand } from "./titan-sdk.mjs";

export const runtimeDlls = [
  "lua55.dll", "libuv-1.dll", "libllhttp-9.4.dll", "libsqlite3-0.dll",
  "libssl-3-x64.dll", "libcrypto-3-x64.dll"
];
const repository = fileURLToPath(new URL("..", import.meta.url));
const forward = (value) => value.replaceAll("\\", "/");
const hash = (value) => createHash("sha256").update(value).digest("hex");

// LuaRocks' Windows wrapper is a batch file with installation-specific paths.
// Invoke the installed script with its selected Lua to retain native argv and
// relocated SDK support without entering cmd.exe.
export function windowsCompilerCommand(sdk, args = []) {
  return titanCompilerCommand(sdk, args, "win32");
}

export function orderedModules(plan, selected) {
  const result = [], seen = new Set(), visiting = new Set();
  function visit(name) {
    if (seen.has(name)) return;
    assert(!visiting.has(name), `cyclic source imports at ${name}`);
    const module = plan.modules[name];
    assert(module, `missing native module ${name}`);
    if (module.parseError) throw new Error(module.parseError);
    visiting.add(name);
    for (const dependency of module.imports) visit(dependency);
    visiting.delete(name);
    seen.add(name);
    result.push(name);
  }
  for (const name of selected) visit(name);
  return result;
}

export function moduleOutputs(stage, module) {
  const stem = path.join(stage, module.main.replace(/\.titan$/, ""));
  return [".o", ".c", ".ffi.h", ...(module.foreign ? [".titan.h"] : [])]
    .map((suffix) => stem + suffix);
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

export function windowsApplicationLinkFlags({ test = false, extraFlags = "", inputs = [] } = {}) {
  // The unbootstrapped validation aggregate exercises the protocol's depth-128
  // JSON round trips on the executable stack. Match Titan's Windows stdlib
  // test harness reserve; explicit caller flags follow this test-only default.
  return [...(test ? ["-Wl,--stack,8388608"] : []), extraFlags,
    ...inputs.map(compilerArgument)].filter(Boolean).join(" ");
}

export function childEnvironment(inherited, overrides, removed = []) {
  const replaced = new Set([...Object.keys(overrides), ...removed].map((name) => name.toUpperCase()));
  const result = {};
  // Windows environment names are case-insensitive. Node's spawn chooses one
  // spelling when a JS object contains duplicates; remove all overridden forms.
  for (const [name, value] of Object.entries(inherited)) {
    if (!replaced.has(name.toUpperCase())) result[name] = value;
  }
  return { ...result, ...overrides };
}

export function buildProfileEnvironment(target, inherited, requestedProfile) {
  const selected = selectedBuildEnvironment(inherited);
  const profile = requestedProfile ?? selected.VSCODE_TITAN_BUILD_PROFILE ?? selected.TITAN_BUILD_PROFILE ??
    (["server-test-build", "server-test-run"].includes(target) ? "validation" : "production");
  assert(["validation", "production"].includes(profile),
    "build profile must be validation or production");
  const overrides = { VSCODE_TITAN_BUILD_PROFILE: profile, TITAN_BUILD_PROFILE: profile };
  for (const key of ["TITAN_EXTRA_CPPFLAGS", "TITAN_EXTRA_CFLAGS", "TITAN_EXTRA_LDFLAGS"]) {
    if (selected[key] !== null) overrides[key] = selected[key];
  }
  return childEnvironment(inherited, overrides);
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

export function selectedBuildEnvironment(environment) {
  const keys = ["CC", "AR", "RANLIB", "RC", "PATH", "CCACHE_DISABLE", "TITAN_JOBS",
    "VSCODE_TITAN_BUILD_PROFILE", "TITAN_BUILD_PROFILE",
    "TITAN_ROCKS_ROOT", "TITAN_EXTRA_CPPFLAGS", "TITAN_EXTRA_CFLAGS", "TITAN_EXTRA_LDFLAGS",
    "TITAN_NO_LINE_DIRECTIVES", "CPATH", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH",
    "OBJC_INCLUDE_PATH", "LIBRARY_PATH", "COMPILER_PATH", "GCC_EXEC_PREFIX", "SDKROOT"];
  return Object.fromEntries(keys.map((key) => [key,
    Object.entries(environment).find(([name]) => name.toUpperCase() === key)?.[1] ?? null]));
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
async function digestFiles(files) {
  const result = [];
  for (const file of [...new Set(files)].sort()) result.push([file, await fileDigest(file)]);
  return hash(JSON.stringify(result));
}
async function existingJson(filename, fallback) {
  try { return JSON.parse(await readFile(filename, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
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
  const targets = ["plan", "server", "server-test-build", "server-test-run", "stage", "package"];
  assert(targets.includes(target), `expected one of ${targets.join(", ")}`);
  const lua = path.join(sdk, "bin", "lua.exe");
  const inheritedPath = Object.entries(process.env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const env = childEnvironment(buildProfileEnvironment(target, process.env, buildProfile), {
    CC: compilerArgument(clang), AR: compilerArgument(ar), RANLIB: compilerArgument(ranlib),
    RC: compilerArgument(path.join(path.dirname(clang), "llvm-rc.exe")),
    CCACHE_DISABLE: "1", TITAN_JOBS: "1", TITAN_ROCKS_ROOT: sdk, TITAN_PREFIX: path.join(buildRoot, "compiler-cache"),
    PATH: `${path.dirname(process.execPath)};${path.dirname(clang)};${path.join(sdk, "bin")};${inheritedPath}`,
    TITAN_PATH_0_6: forward(path.join(sdk, "lib/titan/0.6")),
    TITAN_PATH: forward(path.join(sdk, "lib/titan/0.6")),
    LUA_PATH: `${forward(sdk)}/share/lua/5.5/?.lua;${forward(sdk)}/share/lua/5.5/?/init.lua`,
    LUA_CPATH: `${forward(sdk)}/lib/lua/5.5/?.dll;${forward(sdk)}/lib/titan/0.6/?.dll`
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
    const testExe = path.join(buildRoot, "tests", "bin", "server.tests.exe");
    if (target === "server-test-run") {
      const testEnv = { ...env, TITAN_PROBE_CACHE_DISABLE: "1", TITAN_COMPILER_IO_PROCESS_FIXTURE: fixture,
        LUA_PATH_5_5: env.LUA_PATH, LUA_CPATH_5_5: env.LUA_CPATH };
      delete testEnv.TITAN_PATH; delete testEnv.TITAN_PATH_0_6;
      const result = spawnSync(testExe, filter ? [`--filter=${filter}`] : [], {
        cwd: path.dirname(testExe), env: testEnv, stdio: "inherit", windowsHide: true
      });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `native tests failed (${result.signal ?? result.status})`);
      return;
    }
    run(lua, [path.join(repository, "scripts/generate-native-build.lua"),
      forward(sourceRoot), forward(buildRoot), forward(sdk), "--windows-plan"]);
    const plan = await existingJson(path.join(buildRoot, "native-plan.json"));
    assert.equal(plan.version, 1);
    if (target === "plan") {
      console.log(JSON.stringify({ server: orderedModules(plan, plan.server).length,
        tests: orderedModules(plan, plan.tests).length, sdkFiles: plan.sdkFiles.length }));
      return;
    }
    const nativeFlags = nativeBuildFlags(env.TITAN_BUILD_PROFILE, nativeExtraFlags(lua, env));
    const test = target === "server-test-build";
    const mode = test ? "tests" : "server", stage = path.join(buildRoot, test ? "test-src" : "server-src");
    const directory = path.join(buildRoot, mode), native = nativeBuildDirectory(buildRoot, target);
    await mkdir(directory, { recursive: true }); await mkdir(native, { recursive: true });
    const stateFile = path.join(directory, "build-state.json");
    const previous = await existingJson(stateFile, { objects: {} });
    const state = { objects: {} };
    const sdkDigest = await digestFiles(plan.sdkFiles);
    const buildEnvironment = selectedBuildEnvironment(env);
    const toolDigest = await digestFiles([clang, ar, ranlib,
      path.join(path.dirname(clang), "llvm-rc.exe"), path.join(path.dirname(clang), "ld.lld.exe")]);
    const settings = hash(JSON.stringify({ sdkDigest, clang, ar, ranlib, toolDigest, buildEnvironment, test,
      driver: await digestFiles([fileURLToPath(import.meta.url), path.join(repository, "scripts/generate-native-build.lua")]) }));
    // Probe records hash their source; the owning build configuration supplies
    // tool/header/flag invalidation without writing the immutable SDK.
    const headers = await digestFiles(plan.headers.map((name) => path.join(stage, name)));
    env.TITAN_PREFIX = path.join(buildRoot, "compiler-cache", hash(settings + headers));
    // Relative staged inputs keep native argument vectors compact without
    // changing source ownership or the parsed graph.
    const tree = forward(path.relative(directory, stage));
    const args = [...(test ? ["--test"] : []), "--source-first", "--incremental", "-j1"];
    for (const name of orderedModules(plan, test ? plan.tests : plan.server)) {
      const module = plan.modules[name], outputs = moduleOutputs(stage, module);
      const stamp = hash(JSON.stringify({ settings, headers,
        module, sources: await digestFiles(module.sources.map((file) => path.join(stage, file))),
        dependencies: module.imports.map((dependency) => state.objects[dependency]) }));
      if (previous.objects[name] !== stamp || !await allFiles(outputs)) {
        await rm(outputs[0], { force: true });
        if (!module.foreign) await rm(outputs[0].replace(/\.o$/, ".titan.h"), { force: true });
        compile([...args, "-c", "--tree", tree, name], directory);
        assert(await allFiles(outputs), `missing generated companions for ${name}`);
      }
      state.objects[name] = stamp;
    }
    const clock = path.join(native, "compiler_io_clock.o");
    const embedded = path.join(native, "embedded_interfaces_windows.o");
    const embeddedSource = path.join(native, "embedded_interfaces_profile_windows.c");
    const nativeSources = ["src/server/compiler_io_clock.c", "src/server/compiler_io_clock.h",
      "src/server/embedded_interfaces_native.h", "scripts/generate-embedded-interfaces.lua",
      "src/server/embedded_interfaces_windows.c", "test/fixtures/compiler-io-process.c"];
    const nativeStamp = hash(settings + await digestFiles(nativeSources.map((file) => path.join(repository, file))));
    if (previous.native !== nativeStamp || !await allFiles([clock, embedded, embeddedSource, fixture])) {
      run(clang, [...nativeFlags.cppflags, ...nativeFlags.cflags, "-c",
        "src/server/compiler_io_clock.c", "-o", clock]);
      run(lua, ["scripts/generate-embedded-interfaces.lua", "--windows-profile", sdk, embeddedSource]);
      run(clang, [...nativeFlags.cppflags, ...nativeFlags.cflags,
        "-I", path.join(sdk, "include"), "-I", path.join(sdk, "src/lua-5.5.1"), "-I", path.join(repository, "src/server"),
        "-c", embeddedSource, "-o", embedded]);
      run(clang, [...nativeFlags.cppflags, ...nativeFlags.cflags, "-municode",
        "test/fixtures/compiler-io-process.c", ...nativeFlags.ldflags, "-o", fixture]);
    }
    state.native = nativeStamp;
    const root = test ? "server.tests" : "titan_language_server";
    const executable = path.join(directory, "bin", test ? "server.tests.exe" : "titan-language-server.exe");
    const provider = path.join(directory, "lib/titan/0.6", ...root.split(".")) + ".dll";
    const linkStamp = hash(JSON.stringify({ settings, nativeStamp, objects: state.objects }));
    if (previous.link !== linkStamp || !await allFiles([executable, provider])) {
      // content_identity calls SHA256 directly; Windows imports that API from
      // the controlled native DLL instead of the Unix flattened static provider.
      const linkFlags = windowsApplicationLinkFlags({ test, extraFlags: env.TITAN_EXTRA_LDFLAGS ?? "",
        inputs: [clock, embedded, path.join(sdk, "lib/libcrypto.dll.a")] });
      compile([...args, ...(test ? ["--no-uv-bootstrap"] : ["--launcher-name", "titan-language-server"]),
        "--tree", tree, root], directory, { TITAN_EXTRA_LDFLAGS: linkFlags });
      assert(await allFiles([executable, provider]), "missing DLL application outputs");
    }
    state.link = linkStamp;
    for (const name of runtimeDlls) await copyChanged(path.join(sdk, "bin", name), path.join(directory, "bin", name));
    await copyChanged(path.join(sdk, "lib/titan/0.6/titan.dll"), path.join(directory, "lib/titan/0.6/titan.dll"));
    await writeFile(stateFile, JSON.stringify(state, null, 2) + "\n");
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
