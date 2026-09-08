import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { terminateProcessGroup } from '../process-group.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tree = path.join(here, 'fixtures/process-tree.mjs');
const harness = path.join(here, '../profile-native-cold.mjs');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

async function bounded(promise, milliseconds = 6000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('test process deadline exceeded')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function readPids(filename) {
  const deadline = performance.now() + 3000;
  while (true) {
    try { return JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      assert(performance.now() < deadline, 'fake worker did not start');
      await delay(10);
    }
  }
}

function killIfPresent(pid) {
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'titan-native-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function profileFake(t, mode, failCleanup = false, interrupt = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'titan-native-cleanup-'));
  const root = path.join(directory, 'workspace');
  const cache = path.join(root, '.titan-ls');
  const output = path.join(directory, 'evidence');
  const pidFile = path.join(directory, 'pids.json');
  await mkdir(cache, { recursive: true });
  await writeFile(path.join(cache, 'original-user-cache'), 'preserved\n');
  await writeFile(path.join(root, 'source.titan'), 'target()\n');
  await writeFile(path.join(root, 'titan-config.lua'), '-- fake server fixture\n');
  const server = path.join(directory, 'fake-server');
  await writeFile(server, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(tree)} ${quote(mode)} ${quote(pidFile)}\n`);
  await chmod(server, 0o755);
  let prefix = [];
  if (failCleanup) {
    const preloader = path.join(directory, 'deny-group-signals.mjs');
    await writeFile(preloader, `const original = process.kill;\nprocess.kill = function(pid, signal) {\n` +
      `  if (pid < 0) throw Object.assign(new Error('fixture group signal denied'), { code: 'EPERM' });\n` +
      `  return original.call(this, pid, signal);\n};\n`);
    prefix = ['--import', preloader];
  }
  const env = { ...process.env, PROFILE_TEST_CACHE: cache };
  delete env.TITAN_PROBE_CACHE_DISABLE;
  delete env.TITAN_FFI_PROFILE_DIR;
  const child = spawn(process.execPath, [...prefix, harness,
    '--server', server, '--root', root, '--output', output,
    '--rocks-root', directory, '--compiler', directory, '--clock-dir', directory,
    '--file', 'source.titan', '--marker', 'target()', '--symbol', 'target',
    '--timeout-ms', interrupt ? '7200000' : '3000'],
  { stdio: ['ignore', 'pipe', 'pipe'], env });
  let stderr = '';
  child.stdout.resume(); child.stderr.on('data', data => { stderr += data; });
  const closed = once(child, 'close');
  let pids;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    try { pids ??= JSON.parse(await readFile(pidFile, 'utf8')); } catch {}
    killIfPresent(pids?.leader);
    if (pids?.leader) await terminateProcessGroup(pids.leader, { termMs: 500, killMs: 2000, pollMs: 10 });
    await rm(directory, { recursive: true, force: true });
  });
  pids = await readPids(pidFile);
  const interruptStart = performance.now();
  if (interrupt) child.kill('SIGTERM');
  const [code] = await bounded(closed);
  const afterInterruptMs = performance.now() - interruptStart;
  assert.notEqual(code, 0, 'the fake server deliberately fails LSP initialization');
  const summary = JSON.parse(await readFile(path.join(output, 'summary.json'), 'utf8'));
  return { root, cache, output, pids, summary, stderr, afterInterruptMs };
}

for (const mode of ['running', 'exited']) {
  test(`harness stops writer group before restoration with ${mode} leader`, { timeout: 10_000 }, async t => {
    const result = await profileFake(t, mode);
    assert.equal(result.summary.processGroupCleanup.stopped, true, result.stderr);
    assert.equal(result.summary.cacheRestorationDeferred, undefined);
    assert.equal(result.summary.originalCachePresenceRestored, true);
    assert.equal(await readFile(path.join(result.cache, 'original-user-cache'), 'utf8'), 'preserved\n');
    assert.equal(typeof await readFile(path.join(result.output, 'database/worker-alive'), 'utf8'), 'string');
    await delay(50);
    await assert.rejects(readFile(path.join(result.cache, 'worker-alive')), { code: 'ENOENT' });
    assert.throws(() => process.kill(-result.pids.leader, 0), { code: 'ESRCH' });
  });
}

test('TERM-resistant group escalates to KILL within the deadline', { timeout: 5000 }, async t => {
  const directory = await temporary(t);
  const pidFile = path.join(directory, 'pids.json');
  const child = spawn(process.execPath, [tree, 'running', pidFile, 'ignore'], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore'],
  });
  const closed = once(child, 'close');
  t.after(() => killIfPresent(child.pid));
  await readPids(pidFile);
  const start = performance.now();
  const result = await terminateProcessGroup(child.pid, { termMs: 100, killMs: 2000, pollMs: 10 });
  await bounded(closed);
  assert.equal(result.escalated, true);
  assert.equal(result.stopped, true);
  assert(performance.now() - start < 3000);
  assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' });
  assert.equal((await terminateProcessGroup(child.pid)).escalated, false, 'an absent group is already stopped');
});

test('persistent group liveness causes a bounded cleanup failure', async t => {
  const signals = [];
  t.mock.method(process, 'kill', (pid, signal) => { assert.equal(pid, -999999); signals.push(signal); return true; });
  const start = performance.now();
  await assert.rejects(terminateProcessGroup(999999, { termMs: 20, killMs: 20, pollMs: 2 }), /still exists/);
  assert(signals.includes('SIGTERM') && signals.includes('SIGKILL'));
  assert(performance.now() - start < 1000);
});

async function assertRetained(result) {
  assert.equal(result.summary.complete, false);
  assert.equal(result.summary.cacheRestorationDeferred, true);
  assert.equal(result.summary.originalCachePresenceRestored, false);
  assert.equal(result.summary.cacheRetainedAt, result.cache);
  assert.match(result.summary.originalCacheRetainedAt, /[.]titan-ls[.]profile-backup-/);
  assert.equal(await readFile(path.join(result.summary.originalCacheRetainedAt, 'original-user-cache'), 'utf8'), 'preserved\n');
  await assert.rejects(readFile(path.join(result.cache, 'original-user-cache')), { code: 'ENOENT' });
  assert.equal(typeof await readFile(path.join(result.cache, 'worker-alive'), 'utf8'), 'string');
  assert.doesNotThrow(() => process.kill(-result.pids.leader, 0));
  assert(result.summary.cleanupErrors.some(error => error.includes('fixture group signal denied')));
}

test('failed group cleanup retains the experimental cache and original backup', { timeout: 10_000 }, async t => {
  await assertRetained(await profileFake(t, 'exited', true));
});

test('interrupt aborts an open protocol wait despite failed group signaling', { timeout: 10_000 }, async t => {
  const result = await profileFake(t, 'open', true, true);
  await assertRetained(result);
  assert.equal(result.summary.interrupted, true);
  assert.match(result.summary.error, /profiling interrupted/);
  assert(result.afterInterruptMs < 3000, 'signal must abort the two-hour protocol wait and its timer');
});
