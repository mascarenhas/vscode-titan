import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { serverTestShards } from "./run-server-tests.mjs";
import { buildCoverage, discoverProductionModules, execute, parseArguments, runCoverage, validateNativeOwners } from "./server-coverage.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const ownersOutput = () => serverTestShards.flat().map((name) => `[ RUN      ] ${name}.test_case`).join("\n");

async function fixture(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "vscode-titan-coverage-test-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const options = { repository: path.join(root, "repository"), prefix: path.join(root, "sdk"),
    nativeDir: path.join(root, "native"), buildDir: path.join(root, "build"), reportDir: path.join(root, "report"),
    cc: "gcc-14", gcov: "gcov-14", gcovr: "private-gcovr", formats: [], timeout: 30 };
  const put = async (filename, contents = "fixture\n") => {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, contents);
  };
  for (const name of ["server/used.titan", "server/unimported.titan", "titan_language_server.titan", "server/tests.titan",
    "server/used_test.titan", "server/test_paths.titan", "server/clock.h", "server/clock.c", "server/clock.ffi.h", "server/clock.o",
    "server/.coverage/stale.titan"]) await put(path.join(options.repository, "src", name));
  await put(path.join(options.repository, "src/server/compiler_io_clock.c"));
  for (const name of ["embedded_interfaces_native.c", "compiler_io_process_fixture", "router_worker_fixture"])
    await put(path.join(options.nativeDir, name));
  for (const name of ["titanc", "lua"]) await put(path.join(options.prefix, "bin", name));
  await put(path.join(options.prefix, "lib/titan/0.6/titan.a"));
  const calls = [];
  const run = async (command, args, execution) => {
    calls.push({ command, args, execution });
    if (path.basename(command) === "titanc") {
      const stage = args[args.indexOf("--tree") + 1];
      const selected = args.flatMap((arg, index) => arg === "--coverage-module" ? [args[index + 1]] : []);
      for (const name of selected) {
        const main = path.join(args[args.indexOf("--output") + 1], name.replaceAll(".", "/") + ".titan");
        const stem = path.join(path.dirname(main), ".coverage", path.basename(main, ".titan"));
        for (const extension of [".o", ".gcno", ".c"]) await put(stem + extension);
      }
      await put(path.join(execution.cwd, "server/tests"));
      return "compiled\n";
    }
    if (path.basename(command) === "lua") {
      if (args[1] === "-e") return args[2].includes("cpath") ? "selected-cpath" : "selected-path";
      const names = [];
      for (let index = 2; index < args.length; index += 4 + Number(args[index + 3])) names.push(args[index]);
      return names.join("\n") + "\n";
    }
    if (command === path.join(options.buildDir, "server/tests")) {
      await put(path.join(options.reportDir, "coverage.gcov"), "native gcov output\n");
      for (const [format, filename] of Object.entries({ html: "coverage.html", lcov: "coverage.info", cobertura: "coverage.xml" })) {
        if (options.formats.includes(format)) await put(path.join(options.reportDir, filename));
      }
      return ownersOutput() + "\nTitan executable lines: 12/20 (60.0%)\nCoverage report: " + path.join(options.reportDir, "coverage.gcov") + "\n";
    }
    assert.fail(`unexpected command: ${command} ${args.join(" ")}`);
  };
  options.cflags = ["-DSSL_FLAG=1"];
  options.ldflags = ["-lssl", "-lcrypto"];
  const environment = { TITAN_EXTRA_CPPFLAGS: "-DSOURCE_FLAG=1", TITAN_EXTRA_LDFLAGS: "-lcaller", LUA_PATH: "ambient-path", TITAN_PATH: "ambient-provider",
    TITAN_PREFIX: "ambient-sdk-prefix", TITAN_ROOT: "ambient-sdk",
    GCOV_PREFIX: "ambient-counter-directory", TITAN_FILTER: "drop-most-tests" };
  return { root, options, calls, run, environment, put };
}

async function sourceFiles(directory, relative = "") {
  const result = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const filename = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(directory, filename));
    else result.push(filename);
  }
  return result;
}

test("authored production discovery includes current entry, unused modules, and new modules automatically", async () => {
  const authored = await sourceFiles(path.join(repository, "src"));
  const names = discoverProductionModules(authored).map((module) => module.name);
  assert.ok(names.includes("titan_language_server"));
  assert.ok(names.includes("server.response_queue"));
  assert.ok(!names.some((name) => name.endsWith("_test") || name === "server.tests" || name.startsWith("server.test_")));
  assert.ok(discoverProductionModules([...authored, "server/future_unused.titan"]).some((module) => module.name === "server.future_unused"));
});

test("discovery reserves exact test naming and ignores only generated .coverage trees", () => {
  const modules = discoverProductionModules(["tests.titan", "test_helper.titan", "thing_test.titan", "testable.titan", "contest.titan",
    "server/test.titan", "server/tests_more.titan", "server/.coverage/generated.titan", "server/.scratch/authored.titan"]);
  assert.deepEqual(modules.map((module) => module.name), ["contest", "server..scratch.authored", "server.test", "server.tests_more", "testable"]);
  assert.throws(() => discoverProductionModules(["tests.titan", "test_helper.titan"]), /no production/);
});

test("folder mains own all immediate contributors and shadow flat alternatives", () => {
  const modules = discoverProductionModules(["server/parser.titan", "server/parser/parser.titan", "server/parser/tokens.titan",
    "server/parser/contributor_test.titan", "server/parser/deep/node.titan", "server/test_support/test_support.titan",
    "server/test_support/helpers.titan", "entry.titan"]);
  assert.deepEqual(modules, [
    { name: "entry", main: "entry.titan", sources: ["entry.titan"] },
    { name: "server.parser", main: "server/parser/parser.titan", sources: ["server/parser/contributor_test.titan", "server/parser/parser.titan", "server/parser/tokens.titan"] },
    { name: "server.parser.deep.node", main: "server/parser/deep/node.titan", sources: ["server/parser/deep/node.titan"] }
  ]);
});

test("build options select explicit SDK/toolchain and optional formats; run needs only build and timeout", () => {
  const parsed = parseArguments(["build", "--build-dir", "/tmp/build", "--native-dir", "/tmp/native", "--format", "html", "--format", "lcov", "--format", "html"],
    { TITAN_PREFIX: "/tmp/sdk", CC: "gcc-14", GCOV: "gcov-14" });
  assert.equal(parsed.prefix, "/tmp/sdk");
  assert.equal(parsed.reportDir, "/tmp/build/report");
  assert.deepEqual(parsed.formats, ["html", "lcov"]);
  assert.equal(parsed.cc, "gcc-14");
  const run = parseArguments(["run", "--build-dir", "/tmp/build", "--timeout", "45"], {});
  assert.equal(run.timeout, 45);
  assert.throws(() => parseArguments(["report"]), /build\|run/);
  assert.throws(() => parseArguments(["build", "--prefix", "/tmp/sdk", "--build-dir", "/tmp/build"]), /native-dir is required/);
  assert.throws(() => parseArguments(["build", "--prefix", "/tmp/sdk", "--build-dir", "/tmp/build", "--native-dir", "/tmp/native", "--format", "json"]), /format must be/);
  assert.throws(() => parseArguments(["run", "--build-dir", "/tmp/build", "--timeout", "0"]), /positive seconds/);
  assert.throws(() => parseArguments(["run", "--build-dir", "/tmp/build", "--scope", "all"]), /invalid coverage option/);
});

test("single direct test build roots every discovered production module and isolates source-adjacent artifacts", async (context) => {
  const { options, calls, run, environment } = await fixture(context);
  const build = await buildCoverage(options, { run, environment });
  const compilations = calls.filter((call) => path.basename(call.command) === "titanc");
  assert.equal(compilations.length, 1);
  const { args, execution } = compilations[0];
  const selected = args.flatMap((arg, index) => arg === "--coverage-module" ? [args[index + 1]] : []);
  assert.deepEqual(selected, ["server.unimported", "server.used", "titan_language_server"]);
  assert.deepEqual(args.slice(args.indexOf("--tree") + 2), ["server.tests", ...selected]);
  assert.ok(args.includes("--static") && args.includes("--test") && args.includes("--coverage") && args.includes("--no-uv-bootstrap"));
  assert.ok(!args.includes("--coverage-source-map") && !args.includes("--coverage-gcovr") && args.includes("--incremental"));
  assert.equal(execution.cwd, options.buildDir);
  assert.equal(execution.env.TITAN_BUILD_PROFILE, "validation");
  assert.equal(execution.env.TITAN_ROOT, options.prefix);
  assert.equal(execution.env.TITAN_PREFIX, path.join(options.buildDir, "compiler-cache"));
  assert.equal(environment.TITAN_PREFIX, "ambient-sdk-prefix");
  assert.equal(environment.TITAN_ROOT, "ambient-sdk");
  for (const name of ["LUA_PATH", "GCOV_PREFIX", "GCOV_PREFIX_STRIP", "TITAN_FILTER"]) assert.equal(execution.env[name], undefined);
  assert.equal(execution.env.TITAN_EXTRA_CPPFLAGS, "-DSOURCE_FLAG=1");
  assert.deepEqual(args.flatMap((arg, index) => arg === "--c-source" ? [args[index + 1]] : []),
    [path.join(options.repository, "src/server/compiler_io_clock.c"), path.join(options.nativeDir, "embedded_interfaces_native.c")]);
  assert(args.includes("--ldflag=" + path.join(options.prefix, "lib/titan/0.6/titan.a")));
  assert.equal(execution.env.TITAN_EXTRA_LDFLAGS, "-lcaller");
  assert.equal(build.runtimeEnvironment.TITAN_EXTRA_LDFLAGS, "-lcaller", "fixture child builds do not receive final-image payload flags");
  assert.equal(build.executable, path.join(options.buildDir, "server/tests"));
  assert.equal(await readFile(path.join(options.buildDir, "src/server/clock.c"), "utf8"), "fixture\n");
  await assert.rejects(stat(path.join(options.buildDir, "src/server/clock.ffi.h")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(options.buildDir, "src/server/clock.o")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(options.buildDir, "src/server/.coverage/stale.titan")), { code: "ENOENT" });
  assert.ok(calls.every((call) => path.basename(call.command) !== "titan-coverage"));
  await assert.rejects(buildCoverage(options, { run, environment }), { code: "EEXIST" });
});

test("optional richer formats are passed to the compiler only when requested", async (context) => {
  const { options, calls, run, environment } = await fixture(context);
  options.formats = ["html", "lcov", "cobertura"];
  await buildCoverage(options, { run, environment });
  const { args } = calls.find((call) => path.basename(call.command) === "titanc");
  assert.deepEqual(args.flatMap((arg, index) => arg === "--coverage-format" ? [args[index + 1]] : []), options.formats);
  assert.equal(args[args.indexOf("--coverage-gcovr") + 1], "private-gcovr");
  await runCoverage(options, { run, environment });
});

test("metadata inventory audit rejects omitted production coverage and absent notes before execution", async (context) => {
  const { options, calls, run, environment } = await fixture(context);
  await assert.rejects(buildCoverage(options, { environment, run: async (command, args, execution) => {
    const output = await run(command, args, execution);
    return path.basename(args[1] ?? "") === "inspect-coverage.lua" ? output.replace("server.unimported\n", "") : output;
  } }), /inventory audit incomplete/);
  assert.equal(calls.filter((call) => call.command.endsWith("/server/tests")).length, 0);
  const other = { ...options, buildDir: options.buildDir + "-other" };
  const build = await buildCoverage(other, { run, environment });
  await rm(build.modules[0].object.replace(/\.o$/, ".gcno"));
  await assert.rejects(runCoverage(other, { run, environment }), { code: "ENOENT" });
});

test("colocated test exclusion from compiler metadata propagates a useful build failure", async (context) => {
  const { options, run, environment } = await fixture(context);
  const failure = new Error("server.unimported: production module was not instrumented (colocated test_ functions are excluded)");
  await assert.rejects(buildCoverage(options, { environment, run: (command, args, execution) => {
    if (path.basename(args[1] ?? "") === "inspect-coverage.lua") throw failure;
    return run(command, args, execution);
  } }), (error) => error === failure);
  await assert.rejects(stat(path.join(options.buildDir, "coverage-build.json")), { code: "ENOENT" });
});

test("direct execution uses selected runtime paths, ignores ambient filters, and reports producer totals", async (context) => {
  const { options, calls, run, environment } = await fixture(context);
  await buildCoverage(options, { run, environment });
  assert.deepEqual(await runCoverage(options, { run, environment }), { covered: 12, total: 20, reportDir: options.reportDir });
  const invocation = calls.find((call) => call.command.endsWith("/server/tests"));
  assert.deepEqual(invocation.args, []);
  assert.equal(invocation.execution.timeout, 30);
  assert.equal(invocation.execution.cwd, options.repository);
  assert.equal(invocation.execution.env.LUA_PATH_5_5, "selected-path");
  assert.equal(invocation.execution.env.LUA_CPATH_5_5, "selected-cpath");
  assert.equal(invocation.execution.env.TITAN_ROOT, options.prefix);
  assert.equal(invocation.execution.env.TITAN_PREFIX, path.join(options.buildDir, "compiler-cache"));
  assert.equal(environment.TITAN_PREFIX, "ambient-sdk-prefix");
  assert.equal(environment.TITAN_ROOT, "ambient-sdk");
  assert.equal(invocation.execution.env.TITAN_COMPILER_IO_PROCESS_FIXTURE, path.join(options.nativeDir, "compiler_io_process_fixture"));
  assert.equal(invocation.execution.env.TITAN_EXTRA_LDFLAGS, "-lcaller");
  assert.equal(invocation.execution.env.TITAN_FILTER, undefined);
  assert.equal(invocation.execution.env.GCOV_PREFIX, undefined);
  await runCoverage(options, { run, environment }); // direct executable resets its own counters on each run
});

test("failed rerun removes old owned reports, retains unrelated files, and preserves the test failure", async (context) => {
  const { options, run, environment, put } = await fixture(context);
  await buildCoverage(options, { run, environment });
  await runCoverage(options, { run, environment });
  await put(path.join(options.reportDir, "coverage.html"), "stale richer report");
  await put(path.join(options.reportDir, "unrelated.txt"), "keep");
  const failure = Object.assign(new Error("native tests failed"), { exitCode: 9 });
  await assert.rejects(runCoverage(options, { environment, run: (command, args, execution) => {
    if (command.endsWith("/server/tests")) throw failure;
    return run(command, args, execution);
  } }), (error) => error === failure);
  await assert.rejects(stat(path.join(options.reportDir, "coverage.gcov")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(options.reportDir, "coverage.html")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(options.reportDir, "unrelated.txt"), "utf8"), "keep");
});

test("incomplete test-owner execution, missing totals, and absent report reject successful child status", async (context) => {
  const { options, run, environment } = await fixture(context);
  await buildCoverage(options, { run, environment });
  await assert.rejects(runCoverage(options, { environment, run: async (command, args, execution) => {
    const output = await run(command, args, execution);
    return command.endsWith("/server/tests") ? output.replace(/^\[ RUN[^\n]+\n/, "") : output;
  } }), /every test owner/);
  await assert.rejects(runCoverage(options, { environment, run: async (command, args, execution) => {
    const output = await run(command, args, execution);
    return command.endsWith("/server/tests") ? ownersOutput() : output;
  } }), /valid Titan line totals/);
  await assert.rejects(runCoverage(options, { environment, run: async (command, args, execution) => {
    const output = await run(command, args, execution);
    if (command.endsWith("/server/tests")) await rm(path.join(options.reportDir, "coverage.gcov"));
    return output;
  } }), { code: "ENOENT" });
});

test("a failed rerun inventory audit also clears the preceding successful report", async (context) => {
  const { options, run, environment } = await fixture(context);
  const build = await buildCoverage(options, { run, environment });
  await runCoverage(options, { run, environment });
  await rm(build.modules[0].object.replace(/\.o$/, ".gcno"));
  await assert.rejects(runCoverage(options, { run, environment }), { code: "ENOENT" });
  await assert.rejects(stat(path.join(options.reportDir, "coverage.gcov")), { code: "ENOENT" });
});

test("native owner audit requires the unfiltered aggregate", () => {
  validateNativeOwners(ownersOutput());
  assert.throws(() => validateNativeOwners("[ RUN      ] server.source_text_test.test_case"), /every test owner/);
});

async function waitForFile(filename) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const contents = await readFile(filename, "utf8").catch((error) => { if (error.code !== "ENOENT") throw error; });
    if (contents) return contents;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`subprocess never became ready: ${filename}`);
}

async function processFixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vscode-titan-coverage-process-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return { root, env };
}

function retire(context, pid) {
  context.after(() => {
    try { process.kill(-pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  });
}

async function assertRetired(pid) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const status = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    if (!status || status.startsWith("Z")) return; // adopted zombies cannot write counters
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`owned subprocess survived cleanup: ${pid}`);
}

test("real subprocess failure preserves exit status and pipe-backed diagnostic output", async (context) => {
  const { root, env } = await processFixture(context);
  const log = path.join(root, "failed.log");
  await assert.rejects(execute(process.execPath, ["-e", "console.log('child output'); console.error('child error'); process.exitCode = 17"],
    { cwd: root, env, quiet: true, log }), (error) => error.exitCode === 17 && /child error/.test(error.message));
  assert.match(await readFile(log, "utf8"), /child output[\s\S]*child error/);
});

test("cancellation rejects a zero-exit leader and retires its signal-ignoring descendant", {
  skip: process.platform === "win32" ? "POSIX process groups" : false, timeout: 10_000
}, async (context) => {
  const { root, env } = await processFixture(context);
  const ready = path.join(root, "ready.json");
  const descendantReady = path.join(root, "descendant.ready");
  const controller = new AbortController();
  const running = execute(process.execPath, ["-e", `
    const {spawn}=require('node:child_process'), fs=require('node:fs');
    process.on('SIGTERM',()=>process.exit(0));
    const child=spawn(process.execPath,['-e',${JSON.stringify(`process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(descendantReady)},'ready');setInterval(()=>{},1000);`)}],{stdio:'ignore'});
    const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(descendantReady)})){fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({leader:process.pid,child:child.pid}));clearInterval(timer);}},10);
  `], { cwd: root, env, signal: controller.signal, quiet: true });
  const outcome = running.catch((error) => error);
  const pids = JSON.parse(await waitForFile(ready));
  retire(context, pids.leader);
  controller.abort();
  const error = await outcome;
  assert.equal(error.exitCode, 130);
  assert.match(error.message, /canceled/);
  assert.throws(() => process.kill(pids.leader, 0), { code: "ESRCH" });
  await assertRetired(pids.child);
});

test("direct-run timeout escalates against a command ignoring SIGTERM", {
  skip: process.platform === "win32" ? "POSIX signals" : false, timeout: 8_000
}, async (context) => {
  const { root, env } = await processFixture(context);
  const ready = path.join(root, "ready");
  const running = execute(process.execPath, ["-e", `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`],
    { cwd: root, env, quiet: true, timeout: 1 });
  const outcome = running.catch((error) => error);
  const pid = Number(await waitForFile(ready));
  retire(context, pid);
  const error = await outcome;
  assert.equal(error.exitCode, 124);
  assert.match(error.message, /timed out/);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("a zero-exit leader with a live same-group descendant fails and retires the descendant", {
  skip: process.platform === "win32" ? "POSIX process groups" : false, timeout: 8_000
}, async (context) => {
  const { root, env } = await processFixture(context);
  const ready = path.join(root, "ready");
  const running = execute(process.execPath, ["-e", `
    const {spawn}=require('node:child_process'),fs=require('node:fs');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({leader:process.pid,child:child.pid}));
    child.unref();
  `], { cwd: root, env, quiet: true });
  const outcome = running.catch((error) => error);
  const pids = JSON.parse(await waitForFile(ready));
  retire(context, pids.leader);
  assert.match((await outcome).message, /surviving subprocesses/);
  await assertRetired(pids.child);
});
