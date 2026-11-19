import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { terminateNativeServers } from "./run-extension-host-tests.mjs";
import { prepareExtensionHostWorkspace } from "./extension-host-workspace.mjs";

const proxy = fileURLToPath(new URL("./run-extension-host-tests.mjs", import.meta.url));
const repository = path.dirname(path.dirname(proxy));

test("direct test-cli config prepares and cleans a private workspace", async (context) => {
  const temp = await mkdtemp(path.join(await realpath(tmpdir()), "titan host café "));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const child = spawn(process.execPath, [
    path.join(repository, "node_modules", "@vscode", "test-cli", "out", "bin.mjs"),
    "--list-configuration"
  ], {
    cwd: repository,
    env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const closed = once(child, "close");
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  assert.deepEqual(await closed, [0, null], stderr);
  const [{ config, extensionDevelopmentPath }] = JSON.parse(stdout);
  const windows = process.platform === "win32";
  const workspace = windows
    ? config.launchArgs.at(-1).slice(1, -1)
    : config.workspaceFolder;
  const directory = path.dirname(workspace);
  assert.equal(path.dirname(directory), temp);
  assert.equal(path.basename(workspace), "multiroot.code-workspace");
  const profile = path.join(directory, "user-data");
  assert.ok(config.launchArgs.includes(windows
    ? `--user-data-dir="${profile}"`
    : `--user-data-dir=${profile}`));
  const extensions = path.join(directory, "extensions");
  assert.ok(config.launchArgs.includes(windows
    ? `--extensions-dir="${extensions}"`
    : `--extensions-dir=${extensions}`));
  if (windows) assert.equal(config.launchArgs.at(-1), `"${workspace}"`);
  assert.deepEqual(extensionDevelopmentPath, [repository]);
  await assert.rejects(stat(directory), { code: "ENOENT" });
});

test("an abandoned Extension Host workspace cannot change a later run", async (context) => {
  const fixtures = fileURLToPath(new URL("../test/fixtures/", import.meta.url));
  const sources = ["fake-lsp-server.cjs", ...["workspace", "workspace-beta"]
    .flatMap((root) => ["sample.titan", "titan-config.lua"]
      .map((filename) => path.join(root, filename)))];
  const templateBytes = await Promise.all(sources.map((name) =>
    readFile(path.join(fixtures, name))));
  const first = await prepareExtensionHostWorkspace();
  context.after(() => rm(first.directory, { recursive: true, force: true }));

  const readFolders = async ({ workspace }) =>
    JSON.parse(await readFile(workspace, "utf8")).folders;
  const settings = (root) => path.join(root, ".vscode", "settings.json");
  const dirtySettings = JSON.stringify({
    "titan.languageServer.arguments": ["--fixture-token", "abandoned"]
  }) + "\n";
  for (const folder of await readFolders(first)) {
    await writeFile(settings(path.join(first.directory, folder.path)), dirtySettings);
  }
  const firstMarker = path.join(first.directory, "workspace", ".titan-lsp-test", "events.jsonl");
  await mkdir(path.dirname(firstMarker), { recursive: true });
  await writeFile(firstMarker, '{"event":"initialize","fixtureToken":"stale"}\n');
  const firstCache = path.join(first.directory, "workspace", ".titan-ls");
  await mkdir(firstCache);
  await writeFile(path.join(firstCache, "index.sqlite3"), "old cache");

  const second = await prepareExtensionHostWorkspace();
  context.after(() => rm(second.directory, { recursive: true, force: true }));
  assert.notEqual(first.directory, second.directory);
  const folders = await readFolders(second);
  assert.deepEqual(folders, [
    { name: "alpha", path: "workspace" },
    { name: "beta", path: "workspace-beta" }
  ]);
  assert.deepEqual(await Promise.all(sources.map((name) =>
    readFile(path.join(fixtures, name)))), templateBytes);
  for (const folder of folders) {
    const root = path.join(second.directory, folder.path);
    const args = JSON.parse(await readFile(settings(root), "utf8"))["titan.languageServer.arguments"];
    assert.deepEqual(args, [
      "../fake-lsp-server.cjs", ".titan-lsp-test/events.jsonl", "--fixture-token", folder.name
    ]);
    assert.deepEqual(await readFile(path.resolve(root, args[0])),
      await readFile(path.join(fixtures, "fake-lsp-server.cjs")));
    for (const name of ["sample.titan", "titan-config.lua"]) {
      assert.deepEqual(await readFile(path.join(root, name)),
        await readFile(path.join(fixtures, folder.path, name)));
    }
    await assert.rejects(readFile(path.resolve(root, args[1])), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(root, ".titan-ls", "index.sqlite3")), { code: "ENOENT" });
    assert.equal(await readFile(settings(path.join(first.directory, folder.path)), "utf8"),
      dirtySettings);
  }
  assert.match(await readFile(firstMarker, "utf8"), /"fixtureToken":"stale"/);
  assert.equal(await readFile(path.join(firstCache, "index.sqlite3"), "utf8"), "old cache");
});

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
  const [restartedCode, restartedSignal] = await restartedClosed;
  assert.equal(process.platform === "win32" ? restartedCode !== null : restartedSignal === "SIGKILL", true);
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
    const [code, signal] = await nativeClosed;
    assert.equal(process.platform === "win32" ? code !== null : signal === "SIGKILL", true);
    const diagnostics = stderr.split("\n").filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    assert.deepEqual(diagnostics.find((entry) => entry.workspace === valid).nativeServerLifecycle, [event]);
    assert.equal(typeof diagnostics.find((entry) => entry.workspace === malformed).nativeServerLifecycleError, "string");
  });
}
