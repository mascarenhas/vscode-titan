import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function lifecycleEvents(directory, workspace) {
  let contents;
  try { contents = readFileSync(path.join(directory, `${workspace}.jsonl`), "utf8"); }
  catch (cause) {
    if (cause.code !== "ENOENT") throw cause;
    return [];
  }
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function terminateNativeServers(directory, signal) {
  const pending = [];
  for (const workspace of ["alpha", "beta"]) {
    const active = new Set();
    for (const event of lifecycleEvents(directory, workspace)) {
      if (event.event === "spawn") active.add(event.pid);
      else if (event.event === "close") active.delete(event.pid);
    }
    for (const pid of active) {
      try {
        process.kill(pid, signal);
        pending.push(pid);
      } catch (cause) { if (cause.code !== "ESRCH") throw cause; }
    }
  }
  return pending;
}

async function awaitProcessExit(pid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (cause) {
      if (cause.code === "ESRCH") return;
      throw cause;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`native Extension Host server ${pid} survived failed-run cleanup`);
}

// The Extension Host cannot access LanguageClient's owned ChildProcess. Keep a
// small stdio-transparent parent so its test can await the native child's close,
// including libgcov's exit-time flush, before VS Code closes its process tree.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly && process.argv[2] === "--native-server") {
  const [server, receipt, ...args] = process.argv.slice(3);
  assert.ok(server && receipt, "native server proxy requires executable and receipt");
  const child = spawn(server, args, { stdio: "inherit" });
  child.once("spawn", () => appendFileSync(receipt, JSON.stringify({
    event: "spawn", pid: child.pid, server, cwd: process.cwd()
  }) + "\n"));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.once("error", (cause) => {
    console.error(cause);
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    appendFileSync(receipt, JSON.stringify({
      event: "close", pid: child.pid, code, signal
    }) + "\n");
    process.exitCode = code ?? 1;
  });
} else if (invokedDirectly) {
  const options = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    assert.ok(["--server", "--prefix"].includes(name) && value && !options.has(name),
      "usage: node scripts/run-extension-host-tests.mjs --server SERVER --prefix SDK");
    options.set(name, path.resolve(value));
  }
  assert.ok(options.has("--server") && options.has("--prefix"),
    "prepared Extension Host tests require --server and --prefix");
  const prefix = options.get("--prefix");
  const lifecycle = await mkdtemp(path.join(tmpdir(), "vscode-titan-native-lifecycle-"));
  const child = spawn(process.execPath, [
    path.join(repository, "node_modules", "@vscode", "test-cli", "out", "bin.mjs")
  ], {
    cwd: repository,
    stdio: "inherit",
    env: {
      ...process.env,
      npm_node_execpath: process.execPath,
      TITAN_LSP_TEST_SERVER: options.get("--server"),
      TITAN_LSP_TEST_LUA_PATH: [
        path.join(prefix, "share", "lua", "5.5", "?.lua"),
        path.join(prefix, "share", "lua", "5.5", "?", "init.lua")
      ].join(";"),
      TITAN_LSP_TEST_LUA_CPATH: path.join(prefix, "lib", "lua", "5.5",
        process.platform === "win32" ? "?.dll" : "?.so"),
      TITAN_LSP_TEST_LIFECYCLE: lifecycle
    }
  });
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      // Retire measured children immediately even if an Electron descendant
      // outlives test-cli, before the coverage supervisor escalates its group.
      terminateNativeServers(lifecycle, signal);
      child.kill(signal);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  let completed = false;
  try {
    const [code, signal] = await once(child, "close");
    assert.deepEqual({ code, signal }, { code: 0, signal: null },
      "prepared Extension Host tests failed");
    for (const workspace of ["alpha", "beta"]) {
      const events = lifecycleEvents(lifecycle, workspace);
      assert.equal(events.length, 2, `${workspace}: native lifecycle receipt is incomplete`);
      assert.equal(events[0].event, "spawn");
      assert.equal(events[0].server, options.get("--server"));
      assert.deepEqual(events[1], {
        event: "close", pid: events[0].pid, code: 0, signal: null
      }, `${workspace}: native server did not exit gracefully`);
      console.log(JSON.stringify({ workspace, nativeServerLifecycle: events }));
    }
    completed = true;
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    // Failure cleanup is not successful measurement. Reap any native child
    // still listed by its proxy before the supervising coverage run completes.
    await Promise.all(terminateNativeServers(lifecycle, "SIGKILL").map(awaitProcessExit));
    if (completed) await rm(lifecycle, { recursive: true, force: true });
    else console.error(`Native lifecycle evidence retained at ${lifecycle}`);
  }
}
