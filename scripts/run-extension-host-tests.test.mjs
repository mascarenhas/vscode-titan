import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { terminateNativeServers } from "./run-extension-host-tests.mjs";

const proxy = fileURLToPath(new URL("./run-extension-host-tests.mjs", import.meta.url));

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

  assert.deepEqual(terminateNativeServers(root, "SIGKILL"), [restarted.pid]);
  await restartedClosed;
  assert.throws(() => process.kill(restarted.pid, 0), { code: "ESRCH" });
});
