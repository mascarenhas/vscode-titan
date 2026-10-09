import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { serverTestShards } from "./run-server-tests.mjs";
import { buildCoverage, execute, parseArguments, productionModules, reportCoverage, runCoverage,
  validateNativeOwners, validateSourceInventory } from "./server-coverage.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const ownersOutput = () => serverTestShards.flat().map((name) => `[ RUN      ] ${name}.test_case`).join("\n");

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vscode-titan-coverage-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const options = { repository: path.join(root, "repository"), prefix: path.join(root, "sdk"),
    nativeDir: path.join(root, "native"), buildDir: path.join(root, "build"), runDir: path.join(root, "runs"),
    reportDir: path.join(root, "report"), cc: "gcc-14", gcov: "gcov-14", gcovr: "private-gcovr", timeout: 30, scope: "all" };
  const put = async (filename, contents = "fixture\n") => {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, contents);
  };
  for (const name of [...productionModules, ...serverTestShards.flat(), "server.tests", "server.test_links",
    "server.test_paths", "server.test_runtime", "server.test_service"]) {
    await put(path.join(options.repository, "src", name.replaceAll(".", "/") + ".titan"), "-- build orchestration fixture\n");
  }
  for (const name of ["compiler_io_clock.h", "compiler_io_clock.c", "embedded_interfaces_native.h"])
    await put(path.join(options.repository, "src/server", name));
  for (const name of ["Makefile", "scripts/server-coverage.mjs", "scripts/run-server-tests.mjs",
    "scripts/test-server-protocol.mjs", "scripts/test-workspace-cache.mjs", "scripts/test-completion-protocol.mjs",
    "scripts/generate-embedded-interfaces.lua", "test/fixtures/compiler-io-process.c", "scripts/run-extension-host-tests.mjs",
    "src/test/suite/extension.test.ts", ".vscode-test.js", "package.json", "package-lock.json", "dist/extension.js",
    "dist-test/src/test/suite/extension.test.js", "dist-test/src/extension/clientConfig.js", "node_modules/@vscode/test-cli/out/bin.mjs"])
    await put(path.join(options.repository, name));
  for (const name of ["compiler_io_clock.o", "embedded_interfaces_native.o", "embedded_interfaces_native.c", "compiler_io_process_fixture"])
    await put(path.join(options.nativeDir, name));
  for (const name of ["titanc", "titan-coverage", "lua"]) await put(path.join(options.prefix, "bin", name));
  await put(path.join(options.prefix, "lib/titan/0.6/titan.a"));
  await put(path.join(options.prefix, "share/lua/5.5/titan-compiler/driver.lua"));
  await put(path.join(options.prefix, "lib/lua/5.5/lfs.so"));
  await put(path.join(options.prefix, "lib/luarocks/rocks-5.5/titan/0.6.0-1/bin/titanc"));
  await put(path.join(options.prefix, "lib/luarocks/rocks-5.5/titan/0.6.0-1/bin/titan-coverage"));
  const calls = [];
  const run = async (command, args, execution) => {
    calls.push({ command, args, execution });
    if (path.basename(command) === "lua") return args[2].includes("cpath") ? "selected-cpath" : "selected-path";
    if (path.basename(command) === "titanc") {
      const image = args[args.indexOf("--coverage") + 1];
      await put(path.join(image, "build.json"), "{}\n");
      return "compiled";
    }
    if (args[0] === "run") {
      const directory = args[args.indexOf("--run") + 1];
      await put(path.join(directory, "run.json"), JSON.stringify({ state: "complete", exit_status: 0 }));
      return ownersOutput();
    }
    if (args[0] === "report") {
      const directory = args[args.indexOf("--output") + 1];
      await mkdir(directory);
      await put(path.join(directory, "summary.json"), JSON.stringify({ complete: true, tests_passed: true }));
    }
    return "sealed";
  };
  const environment = { TITAN_EXTRA_CPPFLAGS: "-DSOURCE_FLAG=1", VSCODE_TITAN_OPENSSL_CPPFLAGS: "-DSSL_FLAG=1",
    VSCODE_TITAN_OPENSSL_LDFLAGS: "-lssl -lcrypto", LUA_PATH: "ambient-path", TITAN_PATH: "ambient-provider",
    GCOV_PREFIX: "ambient-counter-directory", TITAN_FILTER: "drop-most-tests" };
  return { root, options, calls, run, environment, put };
}

test("complete production source inventory includes entry and modules without direct test owners", async () => {
  const sourceFiles = [];
  const visit = async (directory, relative = "") => {
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(directory, name);
      else sourceFiles.push(name);
    }
  };
  await visit(path.join(repository, "src"));
  assert.equal(validateSourceInventory(sourceFiles).length, 39);
  assert.ok(productionModules.includes("titan_language_server"));
  assert.ok(productionModules.includes("server.response_queue"));
  assert.throws(() => validateSourceInventory([...sourceFiles, "server/unimported.titan"]), /inventory changed/);
  assert.throws(() => validateSourceInventory(sourceFiles.filter((name) => name !== "server/response_queue.titan")), /inventory changed/);
});

test("options select an explicit prefix and reject unsupported or incomplete commands", () => {
  const parsed = parseArguments(["run", "--build-dir", "/tmp/build", "--run-dir", "/tmp/run", "--scope", "native"],
    { TITAN_PREFIX: "/tmp/selected-sdk", CC: "gcc-14", GCOV: "gcov-14" });
  assert.equal(parsed.prefix, "/tmp/selected-sdk");
  assert.equal(parsed.scope, "native");
  assert.throws(() => parseArguments(["build", "--prefix", "/tmp/sdk", "--build-dir", "/tmp/build"]), /native-dir is required/);
  assert.throws(() => parseArguments(["run", "--prefix", "/tmp/sdk", "--build-dir", "/tmp/build", "--run-dir", "/tmp/run", "--timeout", "0"]), /positive seconds/);
  assert.throws(() => parseArguments(["report", "--unknown", "x"]), /invalid coverage option/);
});

test("real subprocess failures preserve their status and complete diagnostic log", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vscode-titan-coverage-exec-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const log = path.join(root, "failed.log");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  await assert.rejects(execute(process.execPath, ["-e", "console.log('child output'); console.error('child error'); process.exitCode = 17"],
    { cwd: root, env, quiet: true, log }), (error) => error.exitCode === 17);
  const output = await readFile(log, "utf8");
  assert.match(output, /child output/);
  assert.match(output, /child error/);
});

async function waitForFile(filename) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const contents = await readFile(filename, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (contents) return contents;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`subprocess never became ready: ${filename}`);
}

test("cancellation rejects a zero-exit leader and retires its signal-ignoring descendant", {
  skip: process.platform === "win32" ? "POSIX process groups" : false, timeout: 10_000
}, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vscode-titan-coverage-cancel-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const ready = path.join(root, "ready.json");
  const nativeReady = path.join(root, "descendant.ready");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const controller = new AbortController();
  const running = execute(process.execPath, ["-e", `
    const {spawn}=require('node:child_process');
    const fs=require('node:fs');
    process.on('SIGTERM',()=>process.exit(0));
    const descendant=spawn(process.execPath,['-e',${JSON.stringify(`
      process.on('SIGTERM',()=>{});
      require('node:fs').writeFileSync(${JSON.stringify(nativeReady)},'ready');
      setInterval(()=>{},1000);
    `)}],{stdio:'ignore'});
    const timer=setInterval(()=>{
      if(fs.existsSync(${JSON.stringify(nativeReady)})) {
        fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({leader:process.pid,descendant:descendant.pid}));
        clearInterval(timer);
      }
    },10);
  `], { cwd: root, env, signal: controller.signal, quiet: true });
  const outcome = running.catch((error) => error);
  const pids = JSON.parse(await waitForFile(ready));
  context.after(() => {
    try { process.kill(-pids.leader, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  });
  controller.abort();
  const error = await outcome;
  assert.match(error.message, /canceled/);
  assert.equal(error.exitCode, 130, "a zero child exit after cancellation must still fail");
  assert.throws(() => process.kill(pids.leader, 0), { code: "ESRCH" });
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const status = spawnSync("ps", ["-o", "stat=", "-p", String(pids.descendant)], { encoding: "utf8" }).stdout.trim();
    if (!status || status.startsWith("Z")) return; // an adopted zombie cannot execute or write counters
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("signal-ignoring compiler descendant survived owned process-group cleanup");
});

test("cancellation lets the upstream run supervisor handle SIGINT and still rejects its zero exit", {
  skip: process.platform === "win32" ? "POSIX signals" : false, timeout: 10_000
}, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vscode-titan-coverage-delegate-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const ready = path.join(root, "ready");
  const receipt = path.join(root, "signal");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const controller = new AbortController();
  const running = execute(process.execPath, ["-e", `
    const fs=require('node:fs');
    process.on('SIGINT',()=>{fs.writeFileSync(${JSON.stringify(receipt)},'SIGINT');process.exit(0);});
    fs.writeFileSync(${JSON.stringify(ready)},'ready');
    setInterval(()=>{},1000);
  `], { cwd: root, env, signal: controller.signal, delegateCleanup: true, quiet: true });
  const outcome = running.catch((error) => error);
  await waitForFile(ready);
  controller.abort();
  assert.match((await outcome).message, /canceled/);
  assert.equal(await readFile(receipt, "utf8"), "SIGINT");
});

test("cancellation escalates when the owned command ignores SIGTERM", {
  skip: process.platform === "win32" ? "POSIX signals" : false, timeout: 8_000
}, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vscode-titan-coverage-escalate-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const ready = path.join(root, "ready");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const controller = new AbortController();
  const running = execute(process.execPath, ["-e", `
    process.on('SIGTERM',()=>{});
    require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));
    setInterval(()=>{},1000);
  `], { cwd: root, env, signal: controller.signal, quiet: true });
  const outcome = running.catch((error) => error);
  const pid = Number(await waitForFile(ready));
  context.after(() => {
    try { process.kill(-pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  });
  controller.abort();
  assert.match((await outcome).message, /canceled/);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("build isolates both images, maps every selected source, and binds support sources before compile", async (context) => {
  const { options, calls, run, environment } = await fixture(context);
  const build = await buildCoverage(options, { run, environment });
  const compilations = calls.filter((call) => path.basename(call.command) === "titanc");
  assert.equal(compilations.length, 2);
  for (const call of compilations) {
    assert.equal(call.args.filter((arg) => arg === "--coverage-module").length, 39);
    assert.ok(call.args.includes("titan_language_server"));
    assert.ok(!call.args.includes("--incremental"));
    assert.equal(call.execution.env.TITAN_BUILD_PROFILE, "validation");
    assert.equal(call.execution.env.LUA_PATH, undefined);
    assert.notEqual(call.execution.env.GCOV_PREFIX, environment.GCOV_PREFIX);
    assert.equal(call.execution.env.TITAN_FILTER, undefined);
    assert.equal(call.execution.env.TITAN_EXTRA_CPPFLAGS, "-DSOURCE_FLAG=1");
    assert.ok(call.execution.env.TITAN_EXTRA_LDFLAGS.endsWith("-lssl -lcrypto"));
  }
  assert.ok(compilations[0].args.includes("--no-uv-bootstrap"));
  assert.ok(compilations[1].args.includes("--static"));
  assert.notEqual(compilations[0].args[compilations[0].args.indexOf("--coverage-source-map") + 1],
    compilations[1].args[compilations[1].args.indexOf("--coverage-source-map") + 1]);
  const seals = calls.filter((call) => call.args[0] === "seal");
  assert.equal(seals.length, 2);
  for (const call of seals) {
    assert.ok(call.args.includes(path.join(options.repository, "src/server/compiler_io_clock.c")));
    assert.ok(call.args.includes(path.join(options.repository, "src/server/test_runtime.titan")));
    assert.ok(call.args.includes(path.join(options.nativeDir, "embedded_interfaces_native.c")));
    assert.ok(call.args.includes(path.join(options.repository, "test/fixtures/compiler-io-process.c")));
    assert.ok(call.args.includes(path.join(options.repository, "dist-test/src/extension/clientConfig.js")));
    assert.ok(call.args.includes(path.join(options.prefix, "share/lua/5.5/titan-compiler/driver.lua")));
    assert.ok(call.args.includes(path.join(options.prefix, "lib/lua/5.5/lfs.so")));
    assert.ok(call.args.includes(path.join(options.prefix, "lib/titan/0.6/titan.a")));
    for (const name of ["titanc", "titan-coverage", "lua"]) assert.ok(call.args.includes(path.join(options.prefix, "bin", name)));
  }
  assert.equal(build.images[0], path.join(options.buildDir, "tests-image/bin/server/tests"));
  await assert.rejects(buildCoverage(options, { run, environment }), { code: "EEXIST" });
});

test("a support source changed during compilation cannot be sealed as the compiled input", async (context) => {
  const { options, run, environment, put } = await fixture(context);
  const changing = async (command, args, execution) => {
    const result = await run(command, args, execution);
    if (path.basename(command) === "titanc") await put(path.join(options.repository, "src/server/test_runtime.titan"), "-- changed\n");
    return result;
  };
  await assert.rejects(buildCoverage(options, { run: changing, environment }), /build inputs changed/);
});

test("runs the complete aggregate directly and joined protocol scripts with fresh counter roots", async (context) => {
  const { options, calls, run, environment } = await fixture(context);
  await buildCoverage(options, { run, environment });
  const directories = await runCoverage(options, { run, environment });
  assert.deepEqual(directories.map((directory) => path.basename(directory)), ["native", "server-protocol", "workspace-cache", "completion-protocol", "extension-host"]);
  const executions = calls.filter((call) => call.args[0] === "run");
  assert.equal(executions.length, 5);
  assert.equal(executions[0].args.at(-1), path.join(options.buildDir, "tests-image/bin/server/tests"));
  assert.ok(executions.every((call) => !call.args.some((arg) => arg.includes("run-server-tests.mjs"))));
  assert.equal(executions[0].execution.env.TITAN_PATH, undefined);
  assert.equal(executions[0].execution.env.GCOV_PREFIX, undefined);
  assert.equal(executions[0].execution.env.LUA_PATH_5_5, "selected-path");
  assert.equal(executions[0].execution.env.LUA_CPATH_5_5, "selected-cpath");
  assert.equal(executions[0].execution.env.TITAN_EXTRA_LDFLAGS, "");
  assert.ok(!executions[0].execution.env.TITAN_EXTRA_LDFLAGS.includes("compiler_io_clock.o"));
  await assert.rejects(runCoverage(options, { run, environment }), { code: "EEXIST" });
});

test("incomplete collection fails even when upstream run returns a zero test status", async (context) => {
  const { options, run, environment, put } = await fixture(context);
  await buildCoverage(options, { run, environment });
  const incomplete = async (command, args, execution) => {
    const output = await run(command, args, execution);
    if (args[0] === "run") await put(path.join(args[args.indexOf("--run") + 1], "run.json"),
      JSON.stringify({ state: "incomplete", exit_status: 0, missing_counters: ["missing.gcda"] }));
    return output;
  };
  await assert.rejects(runCoverage(options, { run: incomplete, environment }), /collection incomplete/);
  await assert.rejects(readFile(path.join(options.runDir, "coverage-runs.json")), { code: "ENOENT" });
});

test("a successful zero-owner run is rejected and a child failure remains the primary error", async (context) => {
  validateNativeOwners(ownersOutput());
  assert.throws(() => validateNativeOwners("[ PASSED ] 0 tests"), /every test owner/);
  const { options, run, environment } = await fixture(context);
  await buildCoverage(options, { run, environment });
  const failure = new Error("native child exited 17");
  failure.exitCode = 17;
  await assert.rejects(runCoverage(options, { environment, run: (command, args, execution) => {
    if (args[0] === "run") throw failure;
    return run(command, args, execution);
  } }), (error) => error === failure);
});

test("report retains both manifests and provides a separate native-only baseline", async (context) => {
  const { options, calls, run, environment } = await fixture(context);
  await buildCoverage(options, { run, environment });
  await runCoverage(options, { run, environment });
  await reportCoverage(options, { run, environment });
  let report = calls.filter((call) => call.args[0] === "report").at(-1);
  assert.equal(report.args.filter((arg) => arg === "--manifest").length, 2);
  assert.equal(report.args.filter((arg) => arg === "--run").length, 5);
  assert.ok(!report.args.includes("--allow-incomplete"));
  await reportCoverage({ ...options, scope: "native", reportDir: options.reportDir + "-native" }, { run, environment });
  report = calls.filter((call) => call.args[0] === "report").at(-1);
  assert.equal(report.args.filter((arg) => arg === "--manifest").length, 1);
  assert.equal(report.args.filter((arg) => arg === "--run").length, 1);
});

test("edits to unmeasured helper sources invalidate run and report", async (context) => {
  const { options, run, environment, put } = await fixture(context);
  await buildCoverage(options, { run, environment });
  await put(path.join(options.repository, "src/server/test_service.titan"), "-- changed after build\n");
  await assert.rejects(runCoverage(options, { run, environment }), /build inputs changed/);
  await assert.rejects(reportCoverage(options, { run, environment }), /build inputs changed/);
});

test("fixture runtime markers may change while original fixture sources remain sealed", async (context) => {
  const { options, calls, run, environment, put } = await fixture(context);
  const source = path.join(options.repository, "test/fixtures/project/main.titan");
  const marker = path.join(options.repository, "test/fixtures/project/.titan-lsp-test/events.jsonl");
  const cache = path.join(options.repository, "test/fixtures/project/.titan-ls/cache.json");
  await put(source, "-- original fixture source\n");
  await put(marker, "old marker\n");
  await put(cache, "old cache\n");
  await buildCoverage(options, { run, environment });
  for (const seal of calls.filter((call) => call.args[0] === "seal")) {
    assert.ok(seal.args.includes(source));
    assert.ok(!seal.args.includes(marker));
    assert.ok(!seal.args.includes(cache));
  }
  await put(marker, "new marker\n");
  await put(cache, "new cache\n");
  await put(path.join(path.dirname(marker), "new-runtime-output.json"));
  await runCoverage({ ...options, scope: "native" }, { run, environment });
  await reportCoverage({ ...options, scope: "native" }, { run, environment });
  await put(source, "-- changed fixture source\n");
  await assert.rejects(runCoverage({ ...options, runDir: options.runDir + "-changed" }, { run, environment }), /build inputs changed/);
  await assert.rejects(reportCoverage(options, { run, environment }), /build inputs changed/);
});

for (const change of ["added", "removed"]) {
  test(`fixture inventory rejects ${change} sources after sealing`, async (context) => {
    const { options, run, environment, put } = await fixture(context);
    const source = path.join(options.repository, "test/fixtures/project/main.titan");
    await put(source, "-- original fixture source\n");
    await buildCoverage(options, { run, environment });
    await runCoverage({ ...options, scope: "native" }, { run, environment });
    if (change === "added") await put(path.join(path.dirname(source), "extra.titan"));
    else await rm(source);
    await assert.rejects(runCoverage({ ...options, runDir: options.runDir + "-changed" }, { run, environment }), /fixture inventory changed/);
    await assert.rejects(reportCoverage({ ...options, scope: "native" }, { run, environment }), /fixture inventory changed/);
  });
}

test("new unmeasured test inputs cannot enter a sealed run and native-only runs cannot claim all-scope coverage", async (context) => {
  const { options, run, environment, put } = await fixture(context);
  await buildCoverage(options, { run, environment });
  await runCoverage({ ...options, scope: "native" }, { run, environment });
  await assert.rejects(reportCoverage(options, { run, environment }), /all-scope coverage requires/);
  await put(path.join(options.repository, "dist-test/src/test/suite/added.test.js"));
  await assert.rejects(runCoverage({ ...options, runDir: options.runDir + "-new" }, { run, environment }), /test inventory changed/);
});

for (const change of ["modified-lua", "modified-native", "provider", "added", "removed", "tool-titanc", "tool-titan-coverage", "tool-lua", "frontend"]) {
  test(`selected runtime compiler modules reject ${change} inputs after sealing`, async (context) => {
    const { options, run, environment, put } = await fixture(context);
    await buildCoverage(options, { run, environment });
    if (change === "modified-lua") await put(path.join(options.prefix, "share/lua/5.5/titan-compiler/driver.lua"), "changed Lua\n");
    if (change === "modified-native") await put(path.join(options.prefix, "lib/lua/5.5/lfs.so"), "changed native module\n");
    if (change === "provider") await put(path.join(options.prefix, "lib/titan/0.6/titan.a"), "changed static provider\n");
    if (change === "added") await put(path.join(options.prefix, "share/lua/5.5/added.lua"));
    if (change === "removed") await rm(path.join(options.prefix, "lib/lua/5.5/lfs.so"));
    if (change.startsWith("tool-")) await put(path.join(options.prefix, "bin", change.slice(5)), "changed tool\n");
    if (change === "frontend") await put(path.join(options.prefix, "lib/luarocks/rocks-5.5/titan/0.6.0-1/bin/titanc"), "changed frontend\n");
    const expected = /build inputs changed|runtime module inventory changed/;
    await assert.rejects(runCoverage(options, { run, environment }), expected);
    await assert.rejects(reportCoverage(options, { run, environment }), expected);
  });
}
