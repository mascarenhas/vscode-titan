import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { serverTestShards } from "./run-server-tests.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));

// Explicit production ownership keeps an unimported module in the denominator.
// New sources must be classified here rather than silently omitted by a filter.
export const productionModules = [
  "server.application", "server.compiler_bridge", "server.compiler_io", "server.compiler_scheduler",
  "server.completion_discovery", "server.completion_service", "server.completion_store", "server.completion_types",
  "server.content_identity", "server.coordinator", "server.diagnostics", "server.dispatcher",
  "server.document_buffers", "server.documentation", "server.embedded_interfaces", "server.framing",
  "server.header_store", "server.indexing_status", "server.lifecycle", "server.logging", "server.lsp_types",
  "server.lua_paths", "server.project_config", "server.project_discovery", "server.project_graph",
  "server.project_loader", "server.project_metadata", "server.project_service", "server.project_watcher",
  "server.protocol", "server.published_diagnostics", "server.response_queue", "server.semantic_features",
  "server.semantic_index", "server.source_text", "server.wire", "server.workspace_cache", "server.workspace_store",
  "titan_language_server"
];
const testModules = serverTestShards.flat();
const helperModules = ["server.tests", "server.test_links", "server.test_paths", "server.test_runtime", "server.test_service"];
const allRunNames = ["native", "server-protocol", "workspace-cache", "completion-protocol", "extension-host"];
const scriptInputs = [
  "Makefile", "scripts/server-coverage.mjs", "scripts/run-server-tests.mjs",
  "scripts/test-server-protocol.mjs", "scripts/test-workspace-cache.mjs", "scripts/test-completion-protocol.mjs",
  "scripts/generate-embedded-interfaces.lua", "scripts/run-extension-host-tests.mjs", "src/test/suite/extension.test.ts",
  ".vscode-test.js", "package.json", "package-lock.json", "dist/extension.js",
  "node_modules/@vscode/test-cli/out/bin.mjs"
];
const moduleFile = (name) => name.replaceAll(".", "/") + ".titan";
const json = async (filename) => JSON.parse(await readFile(filename, "utf8"));
const save = (filename, value) => writeFile(filename, JSON.stringify(value, null, 2) + "\n");
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

async function files(root, relative = "", excludedDirectories = []) {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (entry.isDirectory() && (entry.name === ".titan-ls" || excludedDirectories.includes(entry.name))) continue;
    const filename = path.join(relative, entry.name);
    assert.ok(!entry.isSymbolicLink(), `coverage input must be a regular file or directory: ${filename}`);
    if (entry.isDirectory()) result.push(...await files(root, filename, excludedDirectories));
    else if (entry.isFile()) result.push(filename);
  }
  return result.sort();
}

export function validateSourceInventory(sourceFiles) {
  const expected = [...productionModules, ...testModules, ...helperModules].map(moduleFile).sort();
  assert.equal(new Set(expected).size, expected.length, "coverage source classifications overlap");
  assert.deepEqual(sourceFiles.filter((name) => name.endsWith(".titan")).sort(), expected,
    "coverage source inventory changed: classify every new/removed production, test, or helper module explicitly");
  return productionModules;
}

function cleanEnvironment(environment) {
  const result = { ...environment };
  for (const name of ["LUA_PATH", "LUA_CPATH", "LUA_PATH_5_5", "LUA_CPATH_5_5", "TITAN_SOURCE_PATH",
    "TITAN_PATH", "TITAN_PATH_0_6", "GCOV_PREFIX", "GCOV_PREFIX_STRIP", "TITAN_FILTER"]) delete result[name];
  return result;
}

// Each coverage run supervises the native process, or a joined protocol script.
// In particular, never insert the detached two-shard launcher underneath it.
export async function execute(command, args, { cwd, env, log, quiet = false, signal, delegateCleanup = false } = {}) {
  const canceled = (origin) => {
    const error = new Error(`${path.basename(command)} canceled (${origin})`);
    error.exitCode = origin === "SIGTERM" ? 143 : 130;
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
    // titan-coverage run owns a separate native process group. Let its SIGINT
    // handler finish its bounded group cleanup and write an incomplete receipt.
    signalOwned(delegateCleanup ? "SIGINT" : "SIGTERM");
    escalation = setTimeout(() => signalOwned("SIGKILL"), delegateCleanup ? 6_000 : 2_000);
  };
  const onInterrupt = () => stop("SIGINT");
  const onTerminate = () => stop("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  signal?.addEventListener("abort", onInterrupt, { once: true });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
    chunks.push(chunk);
    if (!quiet) (stream === child.stdout ? process.stdout : process.stderr).write(chunk);
  });
  try {
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const stdout = Buffer.concat(chunks).toString("utf8");
    if (log) await writeFile(log, stdout);
    if (interrupted) throw canceled(interrupted);
    if (status.code !== 0) {
      const error = new Error(`${path.basename(command)} failed (${status.code ?? status.signal})${log ? `; see ${log}` : ""}`);
      error.exitCode = status.code ?? 1;
      throw error;
    }
    if (grouped && child.pid !== undefined) {
      let descendants = false;
      try { process.kill(-child.pid, 0); descendants = true; }
      catch (error) { if (error.code !== "ESRCH") throw error; }
      assert.ok(!descendants, `${path.basename(command)} exited with surviving subprocesses`);
    }
    return stdout;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    signal?.removeEventListener("abort", onInterrupt);
    clearTimeout(escalation);
    // The leader may have exited before a descendant. Retirement still owns
    // that whole group, including children which ignored the first signal.
    signalOwned("SIGKILL");
  }
}

export function parseArguments(args, environment = process.env) {
  const [action, ...rest] = args;
  assert.ok(["build", "run", "report"].includes(action), "usage: server-coverage.mjs build|run|report --prefix SDK --build-dir DIR [options]");
  const options = { action, prefix: environment.TITAN_PREFIX, cc: environment.CC ?? "gcc", gcov: environment.GCOV ?? "gcov",
    gcovr: environment.GCOVR ?? "gcovr", timeout: 1200, scope: "all", repository };
  const names = new Map(["prefix", "build-dir", "native-dir", "run-dir", "report-dir", "cc", "gcov", "gcovr", "timeout", "scope"]
    .map((name) => [`--${name}`, name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]));
  for (let index = 0; index < rest.length; index += 2) {
    const key = names.get(rest[index]);
    assert.ok(key && rest[index + 1] !== undefined && !rest[index + 1].startsWith("--"), `invalid coverage option: ${rest[index]}`);
    options[key] = rest[index + 1];
  }
  for (const key of ["prefix", "buildDir", ...(action === "build" ? ["nativeDir"] : ["runDir"]), ...(action === "report" ? ["reportDir"] : [])]) {
    assert.ok(options[key], `--${key.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase())} is required`);
    options[key] = path.resolve(options[key]);
  }
  options.timeout = Number(options.timeout);
  assert.ok(Number.isFinite(options.timeout) && options.timeout > 0, "--timeout must be positive seconds");
  assert.ok(["all", "native"].includes(options.scope), "--scope must be all or native");
  return options;
}

async function hashInputs(filenames) {
  const result = [];
  for (const filename of [...new Set(filenames)].sort()) {
    assert.ok((await stat(filename)).isFile(), `coverage input is not a file: ${filename}`);
    result.push({ path: filename, sha256: createHash("sha256").update(await readFile(filename)).digest("hex") });
  }
  return result;
}

async function verifyInputs(inputs) {
  assert.deepEqual(await hashInputs(inputs.map((input) => input.path)), inputs,
    "coverage build inputs changed; choose a fresh build directory and rebuild");
}

async function runtimeModuleFiles(prefix) {
  const inventory = [];
  for (const directory of ["share/lua/5.5", "lib/lua/5.5", "lib/luarocks/rocks-5.5/titan/0.6.0-1/bin"]) {
    const root = path.join(prefix, directory);
    inventory.push(...(await files(root)).map((name) => path.join(root, name)));
  }
  return inventory.sort();
}

async function compiledTestFiles(root) {
  const directory = path.join(root, "dist-test");
  return (await files(directory)).filter((name) => name.endsWith(".js"))
    .map((name) => path.join(directory, name));
}

async function fixtureFiles(root) {
  const directory = path.join(root, "test/fixtures");
  return (await files(directory, "", [".titan-lsp-test"]))
    .map((name) => path.join(directory, name));
}

export async function buildCoverage(options, { run = execute, environment = process.env } = {}) {
  assert.ok(process.platform === "linux" || process.platform === "darwin", "native coverage supports GCC Linux/macOS only");
  const root = await realpath(options.repository);
  const prefix = await realpath(options.prefix);
  const sourceRoot = path.join(root, "src");
  const sourceFiles = await files(sourceRoot);
  validateSourceInventory(sourceFiles);
  const copied = sourceFiles.filter((name) => name.endsWith(".titan") || /\.[ch]$/.test(name) && !/\.(ffi|titan)\.h$/.test(name));
  const nativeFiles = ["compiler_io_clock.o", "embedded_interfaces_native.o", "compiler_io_process_fixture"]
    .map((name) => path.join(options.nativeDir, name));
  const provider = path.join(prefix, "lib/titan/0.6/titan.a");
  const tools = Object.fromEntries(["titanc", "titan-coverage", "lua"].map((name) => [name, path.join(prefix, "bin", name)]));
  for (const filename of [...nativeFiles, provider, ...Object.values(tools)]) assert.ok((await stat(filename)).isFile(), `missing coverage build input: ${filename}`);
  const toolRealpaths = await Promise.all(Object.values(tools).map((filename) => realpath(filename)));
  // mkdir without recursive refuses accidental reuse of a sealed graph.
  await mkdir(path.dirname(options.buildDir), { recursive: true });
  await mkdir(options.buildDir);
  const buildDir = await realpath(options.buildDir);
  await mkdir(path.join(buildDir, "logs"));
  const env = cleanEnvironment(environment);
  Object.assign(env, {
    BUILD_PROFILE: "validation", TITAN_BUILD_PROFILE: "validation", CC: options.cc, CCACHE_DISABLE: "1",
    TITAN_ROCKS_ROOT: prefix, TITAN_PATH_0_6: path.join(prefix, "lib/titan/0.6"), TITAN_PATH: path.join(prefix, "lib/titan/0.6"),
    GCOV_PREFIX: path.join(buildDir, "preparation-counters"), GCOV_PREFIX_STRIP: "0",
    TITAN_EXTRA_CPPFLAGS: env.TITAN_EXTRA_CPPFLAGS || env.VSCODE_TITAN_OPENSSL_CPPFLAGS || "",
    TITAN_EXTRA_LDFLAGS: [env.TITAN_EXTRA_LDFLAGS, process.platform === "darwin" ? "-Wl,-export_dynamic" : "-Wl,-E",
      ...nativeFiles.slice(0, 2).map(quote), quote(provider), env.VSCODE_TITAN_OPENSSL_LDFLAGS].filter(Boolean).join(" ")
  });
  const stages = [];
  const manifests = [];
  const images = [];
  const targets = [["tests", "server.tests", ["--test", "--no-uv-bootstrap"]],
    ["server", "titan_language_server", ["--static"]]];
  for (const [name] of targets) {
    const stage = path.join(buildDir, `${name}-source`);
    await mkdir(stage);
    for (const relative of copied) {
      const destination = path.join(stage, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(sourceRoot, relative), destination);
      stages.push(destination);
    }
  }
  const fixtures = await fixtureFiles(root);
  const extensionTests = await compiledTestFiles(root);
  const runtimeModules = await runtimeModuleFiles(prefix);
  const extensionSources = sourceFiles.filter((name) => name.startsWith("extension/") && name.endsWith(".ts"))
    .map((name) => path.join(sourceRoot, name));
  const inputs = await hashInputs([...copied.map((name) => path.join(sourceRoot, name)), ...stages,
    ...nativeFiles, provider, path.join(options.nativeDir, "embedded_interfaces_native.c"),
    ...fixtures, ...extensionTests, ...extensionSources, ...runtimeModules, ...Object.values(tools),
    ...toolRealpaths,
    process.execPath, ...scriptInputs.map((name) => path.join(root, name))]);
  for (const [name, module, mode] of targets) {
    const stage = path.join(buildDir, `${name}-source`);
    const image = path.join(buildDir, `${name}-image`);
    await run(tools.titanc, [...mode, "--source-first", "-j2", "--coverage", image,
      "--coverage-root", root, "--coverage-source-map", `${stage}=${sourceRoot}`, "--coverage-gcov", options.gcov,
      ...productionModules.flatMap((selected) => ["--coverage-module", selected]), "--tree", stage, module],
    { cwd: root, env, log: path.join(buildDir, "logs", `${name}-build.log`) });
    manifests.push(path.join(image, "build.json"));
    images.push(path.join(image, "bin", ...module.split(".")));
  }
  await verifyInputs(inputs);
  for (let index = 0; index < manifests.length; index++) {
    await run(tools["titan-coverage"], ["seal", "--manifest", manifests[index], "--cc", options.cc, "--gcov", options.gcov,
      ...inputs.flatMap((input) => ["--unmeasured-input", input.path])],
    { cwd: root, env, log: path.join(buildDir, "logs", `${index === 0 ? "tests" : "server"}-seal.log`) });
  }
  await verifyInputs(inputs);
  // Fixture compiler children receive caller flags, never the server's final
  // native payload/archive inputs: those belong only to the two image links.
  const runtimeEnvironment = Object.fromEntries(["AR", "RANLIB", "TITAN_EXTRA_CPPFLAGS",
    "TITAN_EXTRA_CFLAGS", "TITAN_EXTRA_LDFLAGS", "VSCODE_TITAN_OPENSSL_CPPFLAGS", "VSCODE_TITAN_OPENSSL_LDFLAGS"]
    .map((name) => [name, environment[name] ?? ""]));
  runtimeEnvironment.CC = options.cc;
  if (!runtimeEnvironment.AR) runtimeEnvironment.AR = "ar";
  if (!runtimeEnvironment.RANLIB) runtimeEnvironment.RANLIB = "ranlib";
  const receipt = { version: 1, root, prefix, buildDir, manifests, images, inputs, nativeFiles, fixtures, extensionTests, runtimeModules,
    productionModules, tools, toolRealpaths, runtimeEnvironment };
  await save(path.join(buildDir, "coverage-build.json"), receipt);
  return receipt;
}

async function loadBuild(options) {
  const build = await json(path.join(options.buildDir, "coverage-build.json"));
  assert.equal(build.prefix, await realpath(options.prefix), "coverage prefix differs from the sealed build");
  assert.equal(build.buildDir, await realpath(options.buildDir), "coverage build directory moved");
  assert.deepEqual(await Promise.all(Object.values(build.tools).map((filename) => realpath(filename))), build.toolRealpaths,
    "selected SDK tool paths changed; rebuild coverage");
  validateSourceInventory(await files(path.join(build.root, "src")));
  assert.deepEqual(await fixtureFiles(build.root), build.fixtures,
    "coverage fixture inventory changed; rebuild coverage");
  const extensionTests = await compiledTestFiles(build.root);
  assert.deepEqual(extensionTests, build.extensionTests, "Extension Host test inventory changed; rebuild coverage");
  assert.deepEqual(await runtimeModuleFiles(build.prefix), build.runtimeModules,
    "selected SDK runtime module inventory changed; rebuild coverage");
  await verifyInputs(build.inputs);
  return build;
}

export function validateNativeOwners(output) {
  const observed = [...new Set([...output.matchAll(/^\[ RUN\s+\] (server\.[A-Za-z_][A-Za-z_0-9]*)\./gm)].map((match) => match[1]))].sort();
  assert.deepEqual(observed, [...testModules].sort(), "coverage native aggregate did not execute every test owner");
}

export async function runCoverage(options, { run = execute, environment = process.env } = {}) {
  const build = await loadBuild(options);
  await mkdir(path.dirname(options.runDir), { recursive: true });
  await mkdir(options.runDir);
  const runDir = await realpath(options.runDir);
  const env = { ...cleanEnvironment(environment), ...build.runtimeEnvironment, BUILD_PROFILE: "validation", TITAN_BUILD_PROFILE: "validation",
    TITAN_ROCKS_ROOT: build.prefix, CCACHE_DISABLE: "1", TITAN_COMPILER_IO_PROCESS_FIXTURE: build.nativeFiles[2] };
  delete env.TITAN_PREFIX;
  env.LUA_PATH_5_5 = await run(build.tools.lua, ["-E", "-e", "io.write(package.path)"], { cwd: build.root, env, quiet: true });
  env.LUA_CPATH_5_5 = await run(build.tools.lua, ["-E", "-e", "io.write(package.cpath)"], { cwd: build.root, env, quiet: true });
  env.TITAN_LS_LUA_PATH = path.join(build.prefix, "share/lua/5.5/?.lua") + ";" + path.join(build.prefix, "share/lua/5.5/?/init.lua");
  env.TITAN_LS_LUA_CPATH = path.join(build.prefix, "lib/lua/5.5/?.so");
  const steps = [
    { name: "native", manifest: build.manifests[0], command: [build.images[0]] },
    ...["server-protocol", "workspace-cache", "completion-protocol"].map((name) => ({ name,
      manifest: build.manifests[1], command: [process.execPath, path.join(build.root, `scripts/test-${name}.mjs`), build.images[1]] })),
    { name: "extension-host", manifest: build.manifests[1], command: [process.execPath,
      path.join(build.root, "scripts/run-extension-host-tests.mjs"), "--server", build.images[1], "--prefix", build.prefix] }
  ];
  const runs = [];
  for (const step of options.scope === "native" ? steps.slice(0, 1) : steps) {
    const directory = path.join(runDir, step.name);
    const output = await run(build.tools["titan-coverage"], ["run", "--manifest", step.manifest, "--run", directory,
      "--timeout", String(options.timeout), "--", ...step.command],
    { cwd: build.root, env, log: path.join(runDir, `${step.name}.log`), delegateCleanup: true });
    const receipt = await json(path.join(directory, "run.json"));
    assert.equal(receipt.state, "complete", `coverage ${step.name} collection incomplete: ${JSON.stringify(receipt)}`);
    assert.equal(receipt.exit_status, 0, `coverage ${step.name} tests failed`);
    if (step.name === "native") validateNativeOwners(output);
    runs.push(directory);
  }
  await verifyInputs(build.inputs);
  await save(path.join(runDir, "coverage-runs.json"), { version: 1, buildDir: build.buildDir, scope: options.scope ?? "all", runs });
  return runs;
}

export async function reportCoverage(options, { run = execute, environment = process.env } = {}) {
  const build = await loadBuild(options);
  const receipt = await json(path.join(options.runDir, "coverage-runs.json"));
  assert.equal(receipt.buildDir, build.buildDir, "coverage runs belong to a different build");
  if (options.scope !== "native") assert.deepEqual(receipt.runs.map((directory) => path.basename(directory)), allRunNames,
    "all-scope coverage requires native, protocol, workspace-cache, completion, and Extension Host runs");
  const runs = options.scope === "native" ? receipt.runs.filter((directory) => path.basename(directory) === "native") : receipt.runs;
  assert.ok(runs.length, "coverage report has no selected runs");
  for (const directory of runs) {
    const runReceipt = await json(path.join(directory, "run.json"));
    assert.equal(runReceipt.state, "complete", `coverage collection incomplete: ${directory}`);
    assert.equal(runReceipt.exit_status, 0, `coverage tests failed: ${directory}`);
  }
  // Upstream verifies identical source/tool/platform/compiler provenance, then
  // sums compatible test/server line traces without dropping notes-only lines.
  const manifests = options.scope === "native" ? build.manifests.slice(0, 1) : build.manifests;
  await run(build.tools["titan-coverage"], ["report", ...manifests.flatMap((manifest) => ["--manifest", manifest]),
    ...runs.flatMap((directory) => ["--run", directory]), "--output", options.reportDir, "--gcovr", options.gcovr],
  { cwd: build.root, env: cleanEnvironment(environment) });
  const summary = await json(path.join(options.reportDir, "summary.json"));
  assert.equal(summary.complete, true, "coverage report collection incomplete");
  assert.equal(summary.tests_passed, true, "coverage report contains failed tests");
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    await ({ build: buildCoverage, run: runCoverage, report: reportCoverage })[options.action](options);
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}
