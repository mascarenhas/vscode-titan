import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { serverTestShards } from "./run-server-tests.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const reportFiles = ["coverage.gcov", "coverage.html", "coverage.info", "coverage.xml", "lines.json", "gcovr.cfg", "single_page.html"];
const formatFiles = { html: "coverage.html", lcov: "coverage.info", cobertura: "coverage.xml" };
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

async function files(root, relative = "") {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === ".coverage") continue;
    const filename = path.join(relative, entry.name);
    assert.ok(!entry.isSymbolicLink(), `coverage source must be a regular file or directory: ${filename}`);
    if (entry.isDirectory()) result.push(...await files(root, filename));
    else if (entry.isFile()) result.push(filename);
  }
  return result.sort();
}

// Match the ordinary native build's folder-main ownership, including flat
// alternatives shadowed by a folder. Classify logical modules, not contributors.
export function discoverProductionModules(sourceFiles) {
  const authored = sourceFiles.filter((name) => name.endsWith(".titan") && !name.split(path.sep).includes(".coverage")).sort();
  const folders = new Map();
  for (const filename of authored) {
    const directory = path.dirname(filename);
    if (path.basename(directory) === path.basename(filename, ".titan")) folders.set(directory, filename);
  }
  const modules = new Map();
  for (const filename of authored) {
    const directory = path.dirname(filename);
    const main = folders.get(directory) ?? filename;
    const stem = main.slice(0, -".titan".length);
    if (!folders.has(directory) && folders.has(stem)) continue;
    const name = (folders.has(directory) ? directory : stem).split(path.sep).join(".");
    const basename = name.split(".").at(-1);
    if (basename === "tests" || basename.startsWith("test_") || basename.endsWith("_test")) continue;
    if (!modules.has(name)) modules.set(name, { name, main, sources: [] });
    modules.get(name).sources.push(filename);
  }
  const result = [...modules.values()].sort((left, right) => left.name.localeCompare(right.name, "en"));
  assert.ok(result.length, "no production Titan source modules discovered");
  return result;
}

function cleanEnvironment(environment) {
  const result = { ...environment };
  for (const name of ["LUA_PATH", "LUA_CPATH", "LUA_PATH_5_5", "LUA_CPATH_5_5", "TITAN_SOURCE_PATH",
    "TITAN_PATH", "TITAN_PATH_0_6", "GCOV_PREFIX", "GCOV_PREFIX_STRIP", "TITAN_FILTER"]) delete result[name];
  return result;
}

// Pipe both streams: compiler-IO tests require stream-backed inherited stderr.
// Own one process group and reject cancellation even if its leader exits zero.
export async function execute(command, args, { cwd, env, log, quiet = false, signal, timeout } = {}) {
  const canceled = (origin) => {
    const error = new Error(`${path.basename(command)} ${origin === "timeout" ? "timed out" : `canceled (${origin})`}`);
    error.exitCode = origin === "timeout" ? 124 : origin === "SIGTERM" ? 143 : 130;
    return error;
  };
  if (signal?.aborted) throw canceled("SIGINT");
  const chunks = [];
  const grouped = process.platform !== "win32";
  const child = spawn(command, args, { cwd, env, detached: grouped, stdio: ["ignore", "pipe", "pipe"] });
  const signalOwned = (name) => {
    if (child.pid === undefined) return;
    try {
      if (grouped) process.kill(-child.pid, name);
      else child.kill(name);
    } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  let interrupted;
  let escalation;
  const stop = (origin) => {
    if (interrupted) return;
    interrupted = origin;
    signalOwned("SIGTERM");
    escalation = setTimeout(() => signalOwned("SIGKILL"), 2_000);
  };
  const onInterrupt = () => stop("SIGINT");
  const onTerminate = () => stop("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  signal?.addEventListener("abort", onInterrupt, { once: true });
  const deadline = timeout === undefined ? undefined : setTimeout(() => stop("timeout"), timeout * 1_000);
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
    chunks.push(chunk);
    if (!quiet) (stream === child.stdout ? process.stdout : process.stderr).write(chunk);
  });
  try {
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const output = Buffer.concat(chunks).toString("utf8");
    if (log) await writeFile(log, output);
    if (interrupted) throw canceled(interrupted);
    if (status.code !== 0) {
      const error = new Error(`${path.basename(command)} failed (${status.code ?? status.signal})${log ? `; see ${log}` : ""}${quiet && output.trim() ? `\n${output.trim()}` : ""}`);
      error.exitCode = status.code ?? 1;
      throw error;
    }
    if (grouped && child.pid !== undefined) {
      let descendants = false;
      try { process.kill(-child.pid, 0); descendants = true; }
      catch (error) { if (error.code !== "ESRCH") throw error; }
      assert.ok(!descendants, `${path.basename(command)} exited with surviving subprocesses`);
    }
    return output;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    signal?.removeEventListener("abort", onInterrupt);
    clearTimeout(escalation);
    clearTimeout(deadline);
    signalOwned("SIGKILL");
  }
}

export function parseArguments(args, environment = process.env) {
  const [action, ...rest] = args;
  assert.ok(["build", "run"].includes(action), "usage: server-coverage.mjs build|run --build-dir DIR [options]");
  const options = { action, prefix: environment.TITAN_PREFIX, cc: environment.CC ?? "gcc", gcov: environment.GCOV ?? "gcov",
    gcovr: environment.GCOVR ?? "gcovr", formats: [], timeout: 1200, repository };
  const names = new Map((action === "build" ? ["prefix", "build-dir", "native-dir", "report-dir", "cc", "gcov", "gcovr", "format"] :
    ["build-dir", "timeout"]).map((name) => [`--${name}`, name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]));
  for (let index = 0; index < rest.length; index += 2) {
    const key = names.get(rest[index]);
    const value = rest[index + 1];
    assert.ok(key && value !== undefined && !value.startsWith("--"), `invalid coverage option: ${rest[index]}`);
    if (key === "format") options.formats.push(value);
    else options[key] = value;
  }
  for (const key of action === "build" ? ["prefix", "buildDir", "nativeDir"] : ["buildDir"]) {
    assert.ok(options[key], `--${key.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase())} is required`);
    options[key] = path.resolve(options[key]);
  }
  options.reportDir = path.resolve(options.reportDir ?? path.join(options.buildDir, "report"));
  options.formats = [...new Set(options.formats)];
  assert.ok(options.formats.every((format) => Object.hasOwn(formatFiles, format)), "--format must be html, lcov, or cobertura");
  options.timeout = Number(options.timeout);
  assert.ok(Number.isFinite(options.timeout) && options.timeout > 0, "--timeout must be positive seconds");
  return options;
}

// Use the producer's object reader rather than duplicating its native metadata
// format or interpreting raw gcov records as Titan executable lines.
const metadataAudit = `local metadata = require "titan-compiler.objectmetadata"
local function read(filename)
    local file = assert(io.open(filename, "rb"))
    local bytes = assert(file:read("a")); assert(file:close()); return bytes
end
local function equal_paths(actual, expected, name)
    assert(type(actual) == "table", name .. ": missing source inventory")
    table.sort(actual); table.sort(expected)
    assert(#actual == #expected, name .. ": source inventory differs")
    for i, filename in ipairs(expected) do
        assert(actual[i] == filename, name .. ": source inventory differs: " .. tostring(actual[i]))
    end
end
local index = 1
while index <= #arg do
    local name, object, generated, count = arg[index], arg[index + 1], arg[index + 2], tonumber(arg[index + 3])
    local expected = {}
    for offset = 1, count do expected[offset] = arg[index + 3 + offset] end
    local entry, failure = metadata.read(read(object), object)
    assert(entry, failure)
    assert(entry.type.name == name, name .. ": wrong object module")
    local native = assert(entry.object_metadata, name .. ": missing object metadata")
    assert(native.coverage and native.coverage.enabled,
        name .. ": production module was not instrumented (colocated test_ functions are excluded)")
    assert(#(native.coverage_test_functions or {}) == 0, name .. ": production module owns test_ functions")
    equal_paths(entry.source_files, expected, name)
    equal_paths(native.coverage.sources, expected, name)
    equal_paths(native.coverage.files, { generated }, name)
    io.write(name .. "\\n")
    index = index + 4 + count
end
`;

async function auditModules(build, run, env) {
  const args = build.modules.flatMap((module) => [module.name, module.object, module.generated,
    String(module.sources.length), ...module.sources]);
  const output = await run(build.lua, ["-E", path.join(build.buildDir, "inspect-coverage.lua"), ...args],
    { cwd: build.buildDir, env, quiet: true, log: path.join(build.buildDir, "logs", "inventory.log") });
  assert.deepEqual(output.trim().split(/\r?\n/), build.modules.map((module) => module.name), "production coverage inventory audit incomplete");
  for (const module of build.modules) assert.ok((await stat(module.object.replace(/\.o$/, ".gcno"))).isFile(), `missing coverage notes: ${module.name}`);
}

export async function buildCoverage(options, { run = execute, environment = process.env } = {}) {
  assert.ok(process.platform === "linux" || process.platform === "darwin", "native coverage supports GCC Linux/macOS only");
  const root = await realpath(options.repository);
  const prefix = await realpath(options.prefix);
  const nativeDir = await realpath(options.nativeDir);
  const sourceFiles = await files(path.join(root, "src"));
  const production = discoverProductionModules(sourceFiles);
  const nativeFiles = ["compiler_io_clock.o", "embedded_interfaces_native.o", "compiler_io_process_fixture"].map((name) => path.join(nativeDir, name));
  const provider = path.join(prefix, "lib/titan/0.6/titan.a");
  const titanc = path.join(prefix, "bin/titanc");
  const lua = path.join(prefix, "bin/lua");
  for (const filename of [...nativeFiles, provider, titanc, lua]) assert.ok((await stat(filename)).isFile(), `missing coverage build input: ${filename}`);
  // A fresh copied tree keeps source-adjacent .coverage files out of src and
  // independent of ordinary/instrumented builds in other directories.
  await mkdir(path.dirname(options.buildDir), { recursive: true });
  await mkdir(options.buildDir);
  const buildDir = await realpath(options.buildDir);
  const stage = path.join(buildDir, "src");
  await mkdir(path.join(buildDir, "logs"));
  for (const relative of sourceFiles.filter((name) => name.endsWith(".titan") || /\.[ch]$/.test(name) && !/\.(ffi|titan)\.h$/.test(name))) {
    const destination = path.join(stage, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(root, "src", relative), destination);
  }
  const env = cleanEnvironment(environment);
  Object.assign(env, {
    BUILD_PROFILE: "validation", TITAN_BUILD_PROFILE: "validation", CC: options.cc, CCACHE_DISABLE: "1",
    TITAN_ROCKS_ROOT: prefix, TITAN_PATH_0_6: path.join(prefix, "lib/titan/0.6"), TITAN_PATH: path.join(prefix, "lib/titan/0.6"),
    TITAN_EXTRA_CPPFLAGS: env.TITAN_EXTRA_CPPFLAGS || env.VSCODE_TITAN_OPENSSL_CPPFLAGS || "",
    TITAN_EXTRA_LDFLAGS: [env.TITAN_EXTRA_LDFLAGS, process.platform === "darwin" ? "-Wl,-export_dynamic" : "-Wl,-E",
      ...nativeFiles.slice(0, 2).map(quote), quote(provider), env.VSCODE_TITAN_OPENSSL_LDFLAGS].filter(Boolean).join(" ")
  });
  const formats = options.formats ?? [];
  const reportDir = path.resolve(options.reportDir ?? path.join(buildDir, "report"));
  const selected = production.map((module) => module.name);
  await run(titanc, ["--test", "--no-uv-bootstrap", "--source-first", "-j2", "--coverage", "--coverage-root", buildDir,
    "--coverage-gcov", options.gcov, "--coverage-output", reportDir,
    ...formats.flatMap((format) => ["--coverage-format", format]), ...(formats.length ? ["--coverage-gcovr", options.gcovr] : []),
    ...selected.flatMap((name) => ["--coverage-module", name]), "--tree", stage, "server.tests", ...selected],
  { cwd: buildDir, env, log: path.join(buildDir, "logs", "build.log") });
  // Runtime fixture compilers receive caller flags, not final-image payloads.
  const runtimeEnvironment = Object.fromEntries(["AR", "RANLIB", "TITAN_EXTRA_CPPFLAGS", "TITAN_EXTRA_CFLAGS", "TITAN_EXTRA_LDFLAGS",
    "VSCODE_TITAN_OPENSSL_CPPFLAGS", "VSCODE_TITAN_OPENSSL_LDFLAGS"].map((name) => [name, environment[name] ?? ""]));
  Object.assign(runtimeEnvironment, { CC: options.cc, AR: runtimeEnvironment.AR || "ar", RANLIB: runtimeEnvironment.RANLIB || "ranlib" });
  const build = { root, prefix, buildDir, reportDir, formats, lua, executable: path.join(buildDir, "server/tests"),
    processFixture: nativeFiles[2], runtimeEnvironment, modules: production.map((module) => {
      const stem = path.join(stage, path.dirname(module.main), ".coverage", path.basename(module.main, ".titan"));
      return { name: module.name, object: stem + ".o", generated: stem + ".c", sources: module.sources.map((source) => path.join(stage, source)) };
    }) };
  assert.ok((await stat(build.executable)).isFile(), "coverage test executable was not produced");
  await writeFile(path.join(buildDir, "inspect-coverage.lua"), metadataAudit);
  await auditModules(build, run, env);
  await writeFile(path.join(buildDir, "coverage-build.json"), JSON.stringify(build, null, 2) + "\n");
  console.log(`Coverage build includes ${build.modules.length} production modules.`);
  return build;
}

export function validateNativeOwners(output) {
  const observed = [...new Set([...output.matchAll(/^\[ RUN\s+\] (server\.[A-Za-z_][A-Za-z_0-9]*)\./gm)].map((match) => match[1]))].sort();
  assert.deepEqual(observed, [...serverTestShards.flat()].sort(), "coverage native aggregate did not execute every test owner");
}

export async function runCoverage(options, { run = execute, environment = process.env } = {}) {
  const build = JSON.parse(await readFile(path.join(options.buildDir, "coverage-build.json"), "utf8"));
  assert.equal(build.buildDir, await realpath(options.buildDir), "coverage build directory moved; rebuild coverage");
  // Clear only producer-owned report filenames, even for an external report
  // directory. A failed rerun must not leave the preceding successful report.
  await mkdir(build.reportDir, { recursive: true });
  for (const name of reportFiles) await rm(path.join(build.reportDir, name), { force: true });
  const env = { ...cleanEnvironment(environment), ...build.runtimeEnvironment, BUILD_PROFILE: "validation", TITAN_BUILD_PROFILE: "validation",
    TITAN_ROCKS_ROOT: build.prefix, CCACHE_DISABLE: "1", TITAN_COMPILER_IO_PROCESS_FIXTURE: build.processFixture };
  delete env.TITAN_PREFIX;
  await auditModules(build, run, env);
  env.LUA_PATH_5_5 = await run(build.lua, ["-E", "-e", "io.write(package.path)"], { cwd: build.root, env, quiet: true });
  env.LUA_CPATH_5_5 = await run(build.lua, ["-E", "-e", "io.write(package.cpath)"], { cwd: build.root, env, quiet: true });
  const output = await run(build.executable, [], { cwd: build.root, env, timeout: options.timeout ?? 1200,
    log: path.join(build.buildDir, "logs", "run.log") });
  validateNativeOwners(output);
  const summary = output.match(/^Titan executable lines: (\d+)\/(\d+) \(([\d.]+)%\)$/m);
  assert.ok(summary && Number(summary[2]) > 0 && Number(summary[1]) <= Number(summary[2]), "coverage executable did not report valid Titan line totals");
  for (const filename of ["coverage.gcov", ...build.formats.map((format) => formatFiles[format])]) {
    assert.ok((await stat(path.join(build.reportDir, filename))).size > 0, `coverage executable did not produce ${filename}`);
  }
  return { covered: Number(summary[1]), total: Number(summary[2]), reportDir: build.reportDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    await ({ build: buildCoverage, run: runCoverage })[options.action](options);
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}
