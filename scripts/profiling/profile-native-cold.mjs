#!/usr/bin/env node
// Cold-to-READY only: no source/header edits and no warm restart.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { finished } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { FrameReader, exitOf, frame, withTimeout } from '../test-server-protocol.mjs';
import { terminateProcessGroup } from './process-group.mjs';

const arguments_ = process.argv.slice(2);
const options = { timeoutMs: 7_200_000, file: 'titan/sqlite3/sqlite3.titan',
  marker: 'check_result(packet, "prepare")', symbol: 'check_result' };
const fields = new Map([['--server', 'server'], ['--root', 'root'], ['--output', 'output'],
  ['--rocks-root', 'rocksRoot'], ['--compiler', 'compiler'], ['--clock-dir', 'clockDir'],
  ['--file', 'file'], ['--marker', 'marker'], ['--symbol', 'symbol'], ['--timeout-ms', 'timeoutMs']]);
for (let i = 0; i < arguments_.length; i += 2) {
  assert(fields.has(arguments_[i]) && arguments_[i + 1], 'unknown/missing option');
  options[fields.get(arguments_[i])] = arguments_[i + 1];
}
for (const key of ['server', 'root', 'output', 'rocksRoot', 'compiler', 'clockDir']) {
  assert(options[key], `${key} is required`); options[key] = path.resolve(options[key]);
}
options.timeoutMs = Number(options.timeoutMs);
assert(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0);
assert.notEqual(process.env.TITAN_PROBE_CACHE_DISABLE, '1', 'use a fresh cache, not disabled in-run reuse');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function exists(filename) {
  try { return await lstat(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
assert(!(await exists(options.output)), 'output must be a new evidence directory');
assert(options.output !== path.join(options.root, '.titan-ls') &&
  !options.output.startsWith(path.join(options.root, '.titan-ls') + path.sep));
await mkdir(options.output, { recursive: true });
const token = randomUUID();
const cache = path.join(options.root, '.titan-ls');
const backup = path.join(options.root, `.titan-ls.profile-backup-${token}`);
const markerFile = path.join(cache, 'profile-owner.json');
const originalCache = await exists(cache);
assert(!originalCache?.isSymbolicLink(), 'workspace cache must not be a symlink');
const sourcePath = path.resolve(options.root, options.file);
const sourceBefore = await readFile(sourcePath);
const configPath = path.join(options.root, 'titan-config.lua');
const configBefore = await readFile(configPath);
const source = sourceBefore.toString('utf8');
const offset = source.indexOf(options.marker);
assert(offset >= 0 && source.indexOf(options.marker, offset + 1) < 0, 'marker must be unique');
const symbolOffset = offset + options.marker.indexOf(options.symbol);
assert(symbolOffset >= offset, 'symbol must be in marker');
const before = source.slice(0, symbolOffset);
const position = { line: before.split('\n').length - 1, character: before.length - before.lastIndexOf('\n') - 1 };
const uri = pathToFileURL(sourcePath).href;
const luaRoot = path.join(options.rocksRoot, 'share/lua/5.5');
const environment = { ...process.env, TITAN_PREFIX: path.join(options.output, 'probe-prefix'),
  TITAN_ROCKS_ROOT: options.rocksRoot, TITAN_FFI_PROFILE_DIR: path.join(options.output, 'compiler'),
  TITAN_LS_LUA_PATH: `${options.compiler}/?.lua;${options.compiler}/?/init.lua;${luaRoot}/?.lua;${luaRoot}/?/init.lua`,
  TITAN_LS_LUA_CPATH: `${options.clockDir}/?.so;${options.rocksRoot}/lib/lua/5.5/?.so`,
  TITAN_LANGUAGE_SERVER_LOG_LEVEL: 'trace' };
delete environment.TITAN_PROBE_CACHE_IDENTITY;
const ticks = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim());
assert(Number.isFinite(ticks) && ticks > 0);
async function sample(pid) {
  const [record, status] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile(`/proc/${pid}/status`, 'utf8')]);
  const fields = record.slice(record.lastIndexOf(')') + 1).trim().split(/\s+/);
  return { serverProcessCpuMs: (Number(fields[11]) + Number(fields[12])) * 1000 / ticks,
    reapedCompilerDescendantCpuMs: (Number(fields[13]) + Number(fields[14])) * 1000 / ticks,
    peakRssKiB: Number(/^VmHWM:\s+(\d+)\s+kB$/m.exec(status)?.[1]) };
}
const setup = { options, token, sourceSha256: hash(sourceBefore), configSha256: hash(configBefore),
  serverSha256: hash(await readFile(options.server)), originalCachePresent: !!originalCache,
  environment: Object.fromEntries(Object.entries(environment).filter(([key]) => key.startsWith('TITAN_') ||
    ['PATH', 'CC', 'CCACHE_DISABLE', 'CCACHE_DIR', 'CCACHE_BASEDIR', 'CCACHE_NOHASHDIR'].includes(key))),
  clocksPerSecond: ticks, startedAt: new Date().toISOString(),
  workload: 'one cold native startup, saved-file feature queries, clean shutdown; no edits or restarts' };
await writeFile(path.join(options.output, 'setup.json'), JSON.stringify(setup, null, 2) + '\n');
const results = { complete: false, statuses: [], diagnostics: {}, features: {} };
let child, outcome, log, logDone, termination, failure, backedUp = false, ownsCache = false;
let rejectProtocol;
const protocolInterrupted = new Promise((_, reject) => { rejectProtocol = reject; });
// Signals can arrive before the first read. Observe rejection immediately;
// each protocol wait still races the original promise and receives the error.
void protocolInterrupted.catch(() => undefined);
async function terminate() {
  if (!child?.pid) return;
  termination ??= terminateProcessGroup(child.pid);
  results.processGroupCleanup = await termination;
}
const interrupt = () => { results.interrupted = true;
  rejectProtocol(new Error('profiling interrupted'));
  void terminate().catch(error => {
  results.terminationError = error.stack ?? String(error);
}); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
try {
  if (originalCache) { await rename(cache, backup); backedUp = true; }
  await mkdir(cache); ownsCache = true;
  await writeFile(markerFile, JSON.stringify({ token }));
  assert(!results.interrupted, 'profiling interrupted before launch');
  log = createWriteStream(path.join(options.output, 'server.stderr.log'));
  const launched = performance.now();
  child = spawn(options.server, [], { cwd: options.root, env: environment,
    stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  outcome = exitOf(child);
  // Attach handlers immediately; the eventual awaited outcome still carries
  // the failure, while a spawn/pipe error cannot bypass the cleanup block.
  void outcome.catch(() => undefined);
  child.stdin.on('error', error => { results.stdinError = error.message; });
  child.stderr.pipe(log); logDone = finished(log);
  void logDone.catch(() => undefined);
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve); child.once('error', reject);
  });
  const reader = new FrameReader(child.stdout);
  let id = 0;
  function send(method, params, requestId) {
    child.stdin.write(frame({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }),
      ...(requestId === undefined ? {} : { id: requestId }) }));
  }
  async function next(deadline) {
    const remaining = deadline - performance.now();
    assert(remaining > 0, 'profiling deadline exceeded');
    const message = await Promise.race([reader.read(remaining), protocolInterrupted]);
    if (message.method === 'titan/indexingStatus') results.statuses.push({ ...message.params, atMs: performance.now() - launched });
    if (message.method === 'textDocument/publishDiagnostics') results.diagnostics[message.params.uri] = message.params.diagnostics;
    return message;
  }
  async function request(method, params) {
    const requestId = ++id, start = performance.now(); send(method, params, requestId);
    while (true) {
      const message = await next(start + options.timeoutMs);
      if (message.id === requestId) { assert.equal(message.error, undefined, JSON.stringify(message.error)); return { result: message.result, wallMs: performance.now() - start }; }
    }
  }
  results.initialize = await request('initialize', { processId: process.pid, rootUri: pathToFileURL(options.root).href,
    capabilities: { general: { positionEncodings: ['utf-16'] } },
    workspaceFolders: [{ uri: pathToFileURL(options.root).href, name: path.basename(options.root) }] });
  const initialSample = await sample(child.pid);
  const initialized = performance.now(); send('initialized', {});
  while (true) {
    const message = await next(initialized + options.timeoutMs);
    if (message.method !== 'titan/indexingStatus' || message.params.state === 'indexing') continue;
    assert.equal(message.params.state, 'ready', JSON.stringify(message.params)); break;
  }
  results.ready = { launchWallMs: performance.now() - launched, indexingWallMs: performance.now() - initialized,
    before: initialSample, after: await sample(child.pid) };
  for (const operation of ['hover', 'definition', 'references', 'foldingRange']) {
    const params = { textDocument: { uri }, ...(operation === 'foldingRange' ? {} : { position }),
      ...(operation === 'references' ? { context: { includeDeclaration: true } } : {}) };
    results.features[operation] = await request(`textDocument/${operation}`, params);
  }
  assert(results.features.hover.result, 'hover must resolve');
  assert(results.features.definition.result, 'definition must resolve');
  assert(results.features.references.result.length > 0, 'references must resolve');
  assert(Array.isArray(results.features.foldingRange.result), 'folds must be returned');
  assert(Object.values(results.diagnostics).flat().length === 0, 'profile workspace has diagnostics');
  results.afterQueries = await sample(child.pid);
  await request('shutdown', null); send('exit'); child.stdin.end();
  assert.deepEqual(await withTimeout(outcome, 'clean profile shutdown', 30_000), { code: 0, signal: null });
  await withTimeout(logDone, 'profile stderr log drain', 10_000);
  results.complete = true;
} catch (error) {
  failure = error; results.error = error.stack ?? String(error);
} finally {
  const cleanupErrors = [];
  let processCleanupSafe = false;
  async function cleanup(operation) {
    try { await operation(); } catch (error) { cleanupErrors.push(error); }
  }
  try {
    await cleanup(async () => {
      await terminate();
      if (outcome) await withTimeout(outcome, 'profile server stream closure', 10_000);
      if (logDone) await withTimeout(logDone, 'profile stderr log drain', 10_000);
      processCleanupSafe = true;
    });
    if (!processCleanupSafe) {
      results.cacheRestorationDeferred = true;
      if (ownsCache) results.cacheRetainedAt = cache;
      if (backedUp) results.originalCacheRetainedAt = backup;
      // Failed termination or undrained inherited pipes leave writer safety
      // uncertain. Preserve both directories and release our own pipe handles.
      // Destroying stdout also settles the losing protocol read and its timer.
      child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy();
      log?.destroy(); child?.unref();
    }
    await cleanup(async () => {
      if (!ownsCache || !processCleanupSafe) return;
      assert.equal(JSON.parse(await readFile(markerFile, 'utf8')).token, token, 'cache ownership changed');
      const destination = path.join(options.output, 'database');
      try { await rename(cache, destination); }
      catch (error) {
        if (error.code === 'EXDEV') {
          try { await cp(cache, destination, { recursive: true, preserveTimestamps: true }); await rm(cache, { recursive: true }); return; }
          catch (copyError) { error = copyError; }
        }
        // Preserve the owned failed-run cache beside the workspace so restoring
        // the original directory does not depend on artifact-destination I/O.
        const recovery = path.join(options.root, `.titan-ls.failed-profile-${token}`);
        await rename(cache, recovery); results.failedCacheRetainedAt = recovery;
        throw error;
      }
    });
  } finally {
    await cleanup(async () => {
      if (!backedUp || !processCleanupSafe) return;
      assert(!(await exists(cache)), 'cannot restore backup over a cache whose ownership changed');
      await rename(backup, cache);
    });
    await cleanup(async () => { results.originalSourcePreserved = hash(await readFile(sourcePath)) === setup.sourceSha256; });
    await cleanup(async () => { results.originalConfigPreserved = hash(await readFile(configPath)) === setup.configSha256; });
    await cleanup(async () => {
      results.originalCachePresenceRestored = !results.cacheRestorationDeferred &&
        !!(await exists(cache)) === !!originalCache;
    });
    if (!results.originalSourcePreserved || !results.originalConfigPreserved || !results.originalCachePresenceRestored) {
      cleanupErrors.push(new Error('workspace source, configuration, or cache presence was not preserved'));
    }
    if (cleanupErrors.length) {
      results.complete = false;
      results.cleanupErrors = cleanupErrors.map(error => error.stack ?? String(error));
      failure ??= new AggregateError(cleanupErrors, 'profiling cleanup failed');
    }
    try { await writeFile(path.join(options.output, 'summary.json'), JSON.stringify(results, null, 2) + '\n'); }
    finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
  }
}
if (failure) throw failure;
assert(results.originalSourcePreserved && results.originalConfigPreserved && results.originalCachePresenceRestored);
console.log(JSON.stringify({ complete: results.complete, ready: results.ready, evidence: options.output }, null, 2));
