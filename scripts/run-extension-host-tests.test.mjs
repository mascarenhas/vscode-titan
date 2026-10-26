import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { terminateNativeServers } from "./run-extension-host-tests.mjs";

const proxy = fileURLToPath(new URL("./run-extension-host-tests.mjs", import.meta.url));

async function failedHost(context, root, receipts) {
  root = await realpath(root);
  const runner = path.join(root, "scripts", "run-extension-host-tests.mjs");
  const testCli = path.join(root, "node_modules", "@vscode", "test-cli", "out", "bin.mjs");
  await mkdir(path.dirname(runner), { recursive: true });
  await mkdir(path.dirname(testCli), { recursive: true });
  await copyFile(proxy, runner);
  await writeFile(testCli, `import {writeFileSync} from 'node:fs';
    import * as path from 'node:path';
    const directory = process.env.TITAN_LSP_TEST_LIFECYCLE;
    for (const [workspace, contents] of Object.entries(${JSON.stringify(receipts)})) {
      writeFileSync(path.join(directory, workspace + '.jsonl'), contents);
    }
    process.exitCode = 7;`);
  const child = spawn(process.execPath, [runner, "--server", process.execPath, "--prefix", root], {
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, TMPDIR: root, TMP: root, TEMP: root },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const closed = once(child, "close");
  context.after(async () => { child.kill("SIGKILL"); await closed; });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return { status: await closed, stdout, stderr };
}

for (const code of [0, 7]) {
  test(`native proxy preserves stdio and joins exit ${code}`, async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "titan-host-proxy-test-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const receipt = path.join(root, "lifecycle.jsonl");
    const child = spawn(process.execPath, [proxy, "--native-server", process.execPath, receipt,
      "-e", 'process.stdin.setEncoding("utf8");let input="";' +
      'process.stdin.on("data", chunk => { input += chunk; });' +
      'process.stdin.on("end", () => {' +
      'process.stdout.write(process.env.TITAN_PROXY_TEST_TOKEN + input);' +
      `process.stderr.write("native-stderr");process.exitCode=${code};});`], {
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, TITAN_PROXY_TEST_TOKEN: "inherited" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const closed = once(child, "close");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.end("-stdin");
    assert.deepEqual(await closed, [code, null]);
    assert.equal(stdout, "inherited-stdin");
    assert.equal(stderr, "native-stderr");
    const events = (await readFile(receipt, "utf8")).trimEnd().split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 2);
    assert.equal(events[0].event, "spawn");
    assert.equal(events[0].server, process.execPath);
    assert.deepEqual(events[1], { event: "close", pid: events[0].pid, code, signal: null });
    assert.throws(() => process.kill(events[0].pid, 0), { code: "ESRCH" });
  });
}

test("native proxy forwards termination and records abnormal native exit", {
  skip: process.platform === "win32" ? "Windows does not deliver catchable SIGTERM" : false,
  timeout: 10_000
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "titan-host-proxy-signal-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const receipt = path.join(root, "lifecycle.jsonl");
  const child = spawn(process.execPath, [proxy, "--native-server", process.execPath, receipt,
    "-e", 'process.stdout.write("ready");setInterval(() => {}, 1000);'], {
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    stdio: ["pipe", "pipe", "pipe"]
  });
  context.after(() => child.kill("SIGKILL"));
  const closed = once(child, "close");
  const ready = once(child.stdout, "data");
  child.stdin.end();
  assert.equal((await ready)[0].toString(), "ready");
  child.kill("SIGTERM");
  assert.deepEqual(await closed, [1, null]);
  const events = (await readFile(receipt, "utf8")).trimEnd().split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(events[1], {
    event: "close", pid: events[0].pid, code: null, signal: "SIGTERM"
  });
  assert.throws(() => process.kill(events[0].pid, 0), { code: "ESRCH" });
});

test("failed-run cleanup retires a restarted native server after an earlier close", {
  timeout: 10_000
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "titan-host-restart-cleanup-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const receipt = path.join(root, "alpha.jsonl");
  const env = { ...process.env, NODE_TEST_CONTEXT: undefined };
  const first = spawn(process.execPath, ["-e", "process.exitCode=7"], { env, stdio: "ignore" });
  const firstClosed = once(first, "close");
  await once(first, "spawn");
  await appendFile(receipt, JSON.stringify({ event: "spawn", pid: first.pid }) + "\n");
  const [code, signal] = await firstClosed;
  assert.equal(code, 7);
  await appendFile(receipt, JSON.stringify({ event: "close", pid: first.pid, code, signal }) + "\n");

  const restarted = spawn(process.execPath, ["-e",
    'process.stdout.write("ready");setInterval(() => {}, 1000);'], {
    env, stdio: ["ignore", "pipe", "ignore"]
  });
  const restartedClosed = once(restarted, "close");
  context.after(async () => {
    restarted.kill("SIGKILL");
    await restartedClosed;
  });
  assert.equal((await once(restarted.stdout, "data"))[0].toString(), "ready");
  await appendFile(receipt, JSON.stringify({ event: "spawn", pid: restarted.pid }) + "\n");

  assert.deepEqual(terminateNativeServers(root, "SIGKILL"), { pending: [restarted.pid], errors: [] });
  await restartedClosed;
  assert.throws(() => process.kill(restarted.pid, 0), { code: "ESRCH" });
});

for (const betaReceipt of ["missing", "malformed"]) {
  test(`failed-run diagnostics preserve the original error with a ${betaReceipt} receipt`, async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "titan-host-failure-evidence-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const events = [
      { event: "spawn", pid: 1234, server: process.execPath, cwd: root },
      { event: "close", pid: 1234, code: null, signal: "SIGTERM" }
    ];
    const receipts = { alpha: events.map((event) => JSON.stringify(event)).join("\n") + "\n" };
    if (betaReceipt === "malformed") receipts.beta = "{unfinished receipt\n";
    const { status, stdout, stderr } = await failedHost(context, root, receipts);
    assert.deepEqual(status, [1, null]);
    assert.equal(stdout, "");
    assert.match(stderr, /AssertionError \[ERR_ASSERTION\]: prepared Extension Host tests failed/);
    assert.match(stderr, /actual: \{ code: 7, signal: null \}/);
    const diagnostics = stderr.split("\n").filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    assert.equal(diagnostics.length, 2);
    assert.deepEqual(diagnostics[0], { workspace: "alpha", nativeServerLifecycle: events });
    assert.equal(diagnostics[1].workspace, "beta");
    assert.deepEqual(diagnostics[1].nativeServerLifecycle, []);
    if (betaReceipt === "malformed") {
      assert.equal(typeof diagnostics[1].nativeServerLifecycleError, "string");
      assert.ok(diagnostics[1].nativeServerLifecycleError.length > 0);
      assert.match(stderr, /Native server cleanup failed: AggregateError/);
    } else {
      assert.equal(diagnostics[1].nativeServerLifecycleError, undefined);
    }
  });
}

for (const malformed of ["alpha", "beta"]) {
  test(`failed-run cleanup joins a valid child despite a malformed ${malformed} receipt`, {
    timeout: 15_000
  }, async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "titan-host-broken-receipt-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const native = spawn(process.execPath, ["-e",
      'process.stdout.write("ready");setInterval(() => {}, 1000);'], {
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      stdio: ["ignore", "pipe", "ignore"]
    });
    const nativeClosed = once(native, "close");
    context.after(async () => { native.kill("SIGKILL"); await nativeClosed; });
    assert.equal((await once(native.stdout, "data"))[0].toString(), "ready");
    const valid = malformed === "alpha" ? "beta" : "alpha";
    const event = { event: "spawn", pid: native.pid, server: process.execPath, cwd: root };
    const { status, stderr } = await failedHost(context, root, {
      [malformed]: "{unfinished receipt\n",
      [valid]: JSON.stringify(event) + "\n"
    });
    assert.deepEqual(status, [1, null]);
    assert.match(stderr, /AssertionError \[ERR_ASSERTION\]: prepared Extension Host tests failed/);
    assert.match(stderr, /Native server cleanup failed: AggregateError/);
    assert.throws(() => process.kill(native.pid, 0), { code: "ESRCH" },
      "the runner must finish retiring the valid child before exposing the receipt error");
    const [code, signal] = await nativeClosed;
    assert.equal(process.platform === "win32" ? code !== null : signal === "SIGKILL", true);
    const diagnostics = stderr.split("\n").filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    assert.deepEqual(diagnostics.find((entry) => entry.workspace === valid).nativeServerLifecycle, [event]);
    assert.equal(typeof diagnostics.find((entry) => entry.workspace === malformed).nativeServerLifecycleError, "string");
  });
}
