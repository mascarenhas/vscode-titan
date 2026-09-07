#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import {
  access, copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { finished } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { aggregateColdProfile } from "./benchmark-server.mjs";
import { FrameReader, exitOf, frame, withTimeout } from "./test-server-protocol.mjs";

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREFIX = "titan-language-server ";
const CACHE_FILES = ["index.sqlite3", "index.sqlite3-wal", "index.sqlite3-shm", "index.sqlite3-journal"];
const round = (number) => Math.round(number * 1000) / 1000;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function usage() {
  return `Usage: node scripts/benchmark-workspace-cache.mjs [options]
  --server PATH       Native executable (default: bin/titan-language-server)
  --root PATH         Idle workspace to measure (default: this repository)
  --file PATH         Query and comment-edit target, relative to root
  --module NAME       Expected module for the source edit (default: server.compiler_io)
  --header PATH       Repository header to comment-edit before a third process
  --marker TEXT       Unique source text containing --symbol
  --symbol TEXT       Symbol inside the marker
  --output PATH       New evidence directory (required)
  --timeout-ms N      Deadline per startup/edit (default: 1800000)
  --queries N         Samples per feature and phase (default: 5)
  --python PATH       Python 3 for exact timestamp restore and read-only SQL
  --keep-database     Retain the measured database in the evidence directory
  --help              Show this help

Runs cold startup, unchanged restart, one saved source comment edit, and
startup after a header comment edit with its original mtime preserved.
Temporarily moves aside an existing .titan-ls and restores it afterward.
Restores the target's original bytes and nanosecond atime/mtime in finally.
Do not run concurrently with another server or source edits in that workspace.
Trace logging is always enabled; OS page caches are not flushed.`;
}

function parseArguments(arguments_) {
  const options = {
    server: path.join(REPOSITORY, "bin/titan-language-server"), root: REPOSITORY,
    file: "src/server/compiler_io.titan", moduleName: "server.compiler_io",
    marker: "return same_lstat_identity(left as LstatIdentity, right as LstatIdentity)",
    symbol: "same_lstat_identity", header: "src/server/compiler_io_clock.h",
    timeoutMs: 1_800_000, queries: 5, python: "python3",
    keepDatabase: false
  };
  const fields = new Map([
    ["--server", "server"], ["--root", "root"], ["--file", "file"], ["--header", "header"],
    ["--module", "moduleName"],
    ["--marker", "marker"], ["--symbol", "symbol"], ["--output", "output"],
    ["--timeout-ms", "timeoutMs"], ["--queries", "queries"], ["--python", "python"]
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    if (flag === "--help") return { help: true };
    if (flag === "--keep-database") { options.keepDatabase = true; continue; }
    const field = fields.get(flag);
    assert.ok(field, `unknown argument: ${flag}`);
    assert.ok(index + 1 < arguments_.length, `${flag} requires a value`);
    options[field] = arguments_[++index];
  }
  assert.ok(options.output, "--output is required; evidence must have a durable destination");
  for (const field of ["timeoutMs", "queries"]) {
    options[field] = Number(options[field]);
    assert.ok(Number.isSafeInteger(options[field]) && options[field] > 0,
      `${field} must be a positive integer`);
  }
  options.server = path.resolve(options.server);
  options.root = path.resolve(options.root);
  options.output = path.resolve(options.output);
  assert.ok(options.marker.length > 0 && options.symbol.length > 0 && options.moduleName.length > 0,
    "marker, symbol, and module name must be nonempty");
  return options;
}

function python(options, source, arguments_ = []) {
  const result = spawnSync(options.python, ["-E", "-c", source, ...arguments_], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024
  });
  assert.equal(result.status, 0,
    `Python helper failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

async function exists(filename) {
  try { return await lstat(filename); }
  catch (cause) { if (cause.code === "ENOENT") return undefined; throw cause; }
}

function isWithin(directory, filename) {
  const relative = path.relative(directory, filename);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function futureRealpath(filename) {
  const missing = [];
  let existing = filename;
  while (!(await exists(existing))) {
    missing.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(await realpath(existing), ...missing);
}

async function savedInput(root, configured, subject) {
  const filename = path.resolve(root, configured);
  assert.ok(filename !== root && isWithin(root, filename), `${subject} must be beneath the workspace root`);
  assert.ok(!isWithin(path.join(root, ".titan-ls"), filename), `${subject} must be outside .titan-ls`);
  assert.equal(await realpath(filename), filename, `${subject} may not traverse symlinks`);
  const metadata = await stat(filename, { bigint: true });
  assert.ok(metadata.isFile(), `${subject} must be a regular file`);
  const original = await readFile(filename);
  return { filename, original, metadata };
}

function restoreTimes(options, input) {
  python(options, "import os,sys; os.utime(sys.argv[1], ns=(int(sys.argv[2]),int(sys.argv[3])))",
    [input.filename, String(input.metadata.atimeNs), String(input.metadata.mtimeNs)]);
}

function inputEvidence(input) {
  return { filename: input.filename, sha256: digest(input.original), editedSha256: digest(input.edited),
    atimeNs: String(input.metadata.atimeNs), mtimeNs: String(input.metadata.mtimeNs), mode: Number(input.metadata.mode) };
}

function checkoutState(root) {
  const run = (arguments_) => {
    const result = spawnSync("git", ["--no-optional-locks", "-C", root, ...arguments_], { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trimEnd() : null;
  };
  return { head: run(["rev-parse", "HEAD"]), status: run(["status", "--short"]) };
}

async function restoreInput(options, input, subject, backupName) {
  const current = await readFile(input.filename);
  assert.ok(current.equals(input.original) || current.equals(input.edited),
    `${subject} changed independently; original bytes retained in ${backupName}, refusing to overwrite concurrent edits`);
  if (!current.equals(input.original)) await writeFile(input.filename, input.original);
  restoreTimes(options, input);
  const restored = await stat(input.filename, { bigint: true });
  assert.equal(restored.mtimeNs, input.metadata.mtimeNs, `${subject} mtime restoration failed`);
  assert.equal(restored.atimeNs, input.metadata.atimeNs, `${subject} atime restoration failed`);
}

function interrupted(options) {
  if (options.control?.interruption) throw options.control.interruption;
}

async function validate(options) {
  assert.equal(process.platform, "linux", "this resource benchmark requires Linux /proc");
  options.root = await realpath(options.root);
  options.server = await realpath(options.server);
  options.output = await futureRealpath(options.output);
  await access(options.server, constants.X_OK);
  assert.equal(await exists(options.output), undefined, "--output must not already exist");
  assert.ok(options.file.endsWith(".titan"), "query target must be a .titan file");
  const { filename, metadata, original } = await savedInput(options.root, options.file, "source target");
  const header = await savedInput(options.root, options.header, "header target");
  assert.notEqual(filename, header.filename, "source and header targets must differ");
  const source = original.toString("utf8");
  assert.ok(Buffer.from(source).equals(original), "target must contain valid UTF-8");
  const marker = source.indexOf(options.marker);
  assert.ok(marker >= 0 && source.indexOf(options.marker, marker + 1) < 0,
    "marker must occur exactly once in the target");
  const within = options.marker.indexOf(options.symbol);
  assert.ok(within >= 0, "symbol must occur inside marker");
  const before = source.slice(0, marker + within);
  const line = before.split("\n").length - 1;
  const character = before.length - before.lastIndexOf("\n") - 1;
  const cache = path.join(options.root, ".titan-ls");
  assert.ok(!isWithin(cache, options.output), "evidence output must be outside .titan-ls");
  const cacheMetadata = await exists(cache);
  assert.ok(cacheMetadata === undefined || cacheMetadata.isDirectory(),
    ".titan-ls must be absent or a direct directory");
  python(options, "import os, sqlite3; assert hasattr(os.stat_result, 'st_mtime_ns')");
  const tickResult = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
  const ticks = Number(tickResult.stdout?.trim());
  assert.ok(tickResult.status === 0 && Number.isSafeInteger(ticks) && ticks > 0,
    "cannot determine Linux process clock frequency");
  const serverMetadata = await stat(options.server, { bigint: true });
  return { filename, original, metadata, header, cache, cacheMetadata, ticks, serverMetadata,
    uri: pathToFileURL(filename).href, position: { line, character } };
}

async function sample(pid, ticks) {
  const [record, status] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8"), readFile(`/proc/${pid}/status`, "utf8")
  ]);
  const fields = record.slice(record.lastIndexOf(")") + 1).trim().split(/\s+/);
  const numbers = [11, 12, 13, 14].map((index) => Number(fields[index]));
  const peak = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
  assert.ok(numbers.every(Number.isFinite) && peak, "incomplete /proc resource sample");
  return {
    childCpuMs: round((numbers[0] + numbers[1]) * 1000 / ticks),
    reapedDescendantCpuMs: round((numbers[2] + numbers[3]) * 1000 / ticks),
    peakRssKiB: Number(peak[1])
  };
}

function difference(after, before) {
  return { childCpuMs: round(after.childCpuMs - before.childCpuMs),
    reapedDescendantCpuMs: round(after.reapedDescendantCpuMs - before.reapedDescendantCpuMs),
    peakRssKiB: after.peakRssKiB };
}

async function cacheSizes(directory) {
  const files = {};
  for (const name of CACHE_FILES) {
    const metadata = await exists(path.join(directory, name));
    files[name] = { exists: metadata !== undefined, bytes: metadata?.size ?? 0 };
  }
  return { files, totalBytes: Object.values(files).reduce((sum, file) => sum + file.bytes, 0) };
}

class Session {
  constructor(child, timeoutMs) {
    this.child = child;
    this.reader = new FrameReader(child.stdout);
    this.timeoutMs = timeoutMs;
    this.id = 0;
    this.statuses = [];
    this.diagnostics = new Map();
    this.stdinError = undefined;
    child.stdin.on("error", (cause) => { this.stdinError = cause; });
  }

  send(method, params, id) {
    if (this.stdinError) throw this.stdinError;
    assert.ok(this.child.stdin.writable && !this.child.stdin.destroyed, "server stdin is closed");
    this.child.stdin.write(frame({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }));
  }

  async next(deadline) {
    const remaining = deadline - performance.now();
    assert.ok(remaining > 0, "benchmark phase exceeded its deadline");
    const message = await this.reader.read(remaining);
    assert.equal(message.jsonrpc, "2.0");
    if (message.method === "titan/indexingStatus") {
      this.statuses.push({ ...message.params, receivedAt: performance.now() });
    } else if (message.method === "textDocument/publishDiagnostics") {
      this.diagnostics.set(message.params.uri, message.params.diagnostics);
    }
    return message;
  }

  async request(method, params) {
    const id = ++this.id;
    const started = performance.now();
    this.send(method, params, id);
    while (true) {
      const response = await this.next(started + this.timeoutMs);
      if (response.id === undefined) continue;
      assert.equal(response.id, id, "unexpected response identifier");
      assert.equal(response.error, undefined, JSON.stringify(response.error));
      assert.ok("result" in response, "response omitted its result");
      return { result: response.result, latencyMs: round(performance.now() - started) };
    }
  }

  async ready(started, minimumEpoch = 0) {
    while (true) {
      const message = await this.next(started + this.timeoutMs);
      assert.equal(message.id, undefined, "unexpected response while awaiting readiness");
      if (message.method !== "titan/indexingStatus") continue;
      const status = message.params;
      if (status.epoch < minimumEpoch || status.state === "indexing") continue;
      assert.equal(status.state, "ready", `indexing failed: ${status.message}`);
      assert.ok(Number.isSafeInteger(status.generation), "ready status omitted its generation");
      return { ...status, wallMs: round(performance.now() - started) };
    }
  }
}

async function queries(session, target, count) {
  const result = {};
  for (const operation of ["hover", "definition", "references", "foldingRange"]) {
    const params = { textDocument: { uri: target.uri } };
    if (operation !== "foldingRange") params.position = target.position;
    if (operation === "references") params.context = { includeDeclaration: true };
    const samples = [];
    let responseDigest;
    let firstResult;
    for (let index = 0; index < count; index += 1) {
      const response = await session.request(`textDocument/${operation}`, params);
      assert.notEqual(response.result, null, `${operation} returned no data at benchmark target`);
      if (operation === "hover") assert.ok(response.result.contents, "hover omitted its contents");
      if (operation === "definition") {
        const location = Array.isArray(response.result) ? response.result[0] : response.result;
        assert.equal(typeof location?.uri, "string", "definition returned no location");
      }
      if (operation === "references") {
        assert.ok(Array.isArray(response.result) && response.result.length > 0, "references returned no locations");
      }
      if (operation === "foldingRange") assert.ok(Array.isArray(response.result), "folding returned no range array");
      const hash = digest(JSON.stringify(response.result));
      if (responseDigest !== undefined) assert.equal(hash, responseDigest, `${operation} changed during unchanged queries`);
      responseDigest = hash;
      firstResult = response.result;
      samples.push(response.latencyMs);
    }
    const sorted = [...samples].sort((left, right) => left - right);
    result[operation] = { samplesMs: samples, minimumMs: sorted[0],
      medianMs: sorted[Math.floor(sorted.length / 2)], maximumMs: sorted.at(-1),
      resultSha256: responseDigest, result: firstResult };
  }
  return result;
}

function recordsFromLog(contents) {
  return contents.split("\n").filter((line) => line.startsWith(PREFIX))
    .map((line) => JSON.parse(line.slice(PREFIX.length)));
}

function workSummary(records) {
  const profiles = records.filter((record) => record.event === "compiler.source_module.profile");
  // Cached dependency visits also emit profiles, with zero parse/check CPU.
  // Keep those visits visible without calling them source analysis work.
  const parsed = profiles.filter((record) => record.parse_cpu_ms > 0);
  const checked = profiles.filter((record) => record.check_cpu_ms > 0);
  const phases = records.filter((record) => record.event === "compiler.c_header.phase");
  const latest = records.filter((record) => record.event === "compiler.cache.stats").at(-1);
  const outcomeCounts = {};
  for (const record of phases) {
    const key = `${record.phase}:${record.outcome}`;
    outcomeCounts[key] = (outcomeCounts[key] ?? 0) + 1;
  }
  const parseCpuMs = profiles.reduce((sum, record) => sum + record.parse_cpu_ms, 0);
  const checkCpuMs = profiles.reduce((sum, record) => sum + record.check_cpu_ms, 0);
  return {
    analysisCalls: records.filter((record) => record.event === "compiler.analysis.start").length,
    sourceProfileCalls: profiles.length,
    sourceModules: [...new Set(profiles.map((record) => record.module_name))].sort(),
    sourceParseCalls: parsed.length,
    sourceCheckCalls: checked.length,
    parsedSourceModules: [...new Set(parsed.map((record) => record.module_name))].sort(),
    checkedSourceModules: [...new Set(checked.map((record) => record.module_name))].sort(),
    parseCpuMs: round(parseCpuMs), checkCpuMs: round(checkCpuMs),
    preprocessingCalls: phases.filter((record) => record.phase === "preprocessing").length,
    headerParseCalls: phases.filter((record) => record.phase === "c_parse").length,
    ffiConversionCalls: phases.filter((record) => record.phase === "downstream_ffi_conversion" && record.outcome === "complete").length,
    ffiReplayHits: phases.filter((record) => record.phase === "downstream_ffi_conversion" && record.outcome === "cache_hit").length,
    headerPhaseOutcomes: outcomeCounts,
    cacheStats: latest ?? null,
    hydratedProjects: records.filter((record) => record.event === "cache.projects.hydrate"),
    encodedProjects: records.filter((record) => record.event === "cache.projects.encode"),
    startupPhases: records.filter((record) => record.event === "cache.startup.phase"),
    sourceScans: records.filter((record) => record.event === "project.scan.complete"),
    fallbackEvents: records.filter((record) => record.event === "cache.memory_fallback"),
    compilerProfile: aggregateColdProfile(records) ?? null
  };
}

function assertWarmReuse(work) {
  for (const name of ["analysisCalls", "sourceProfileCalls", "sourceParseCalls", "sourceCheckCalls",
    "preprocessingCalls", "headerParseCalls", "ffiConversionCalls", "ffiReplayHits"]) {
    assert.equal(work[name], 0, `unchanged restart performed ${name}`);
  }
  assert.ok(work.cacheStats, "unchanged restart omitted compiler cache counters");
  for (const name of ["header_misses", "conversion_lookups", "conversion_hits", "conversion_misses"]) {
    assert.equal(work.cacheStats[name], 0, `unchanged restart reported ${name}`);
  }
  assert.equal(work.encodedProjects.reduce((sum, record) => sum + record.modules, 0), 0,
    "unchanged restart re-encoded project payloads");
}

function assertImporterReuse(work, moduleName) {
  assert.equal(work.analysisCalls, 1, "source comment edit started more than one compiler analysis");
  assert.equal(work.sourceParseCalls, 1, "source comment edit did not parse exactly its own module");
  assert.equal(work.sourceCheckCalls, 1, "source comment edit did not check exactly its own module");
  assert.deepEqual(work.parsedSourceModules, [moduleName], "source edit parsed another module");
  assert.deepEqual(work.checkedSourceModules, [moduleName], "source edit checked another module");
  for (const name of ["preprocessingCalls", "headerParseCalls", "ffiConversionCalls"]) {
    assert.equal(work[name], 0, `source comment edit performed ${name}`);
  }
  assert.ok(work.ffiReplayHits > 0, "source comment edit did not replay a persisted FFI conversion");
  assert.ok(work.cacheStats, "source comment edit omitted compiler cache counters");
  assert.equal(work.cacheStats.header_misses, 0, "source comment edit missed its cached header graph");
  assert.equal(work.cacheStats.conversion_misses, 0, "source comment edit missed its cached FFI conversion");
  assert.equal(work.encodedProjects.reduce((sum, record) => sum + record.modules, 0), 1,
    "source comment edit did not encode exactly one project payload");
  const encodedNames = [];
  for (const record of work.encodedProjects) {
    assert.ok(record.module_names && !record.module_names.truncated,
      "project encoding omitted the complete module-name evidence");
    assert.equal(record.module_names.count, record.modules,
      "project encoding module-name count disagrees with its payload count");
    assert.equal(record.module_names.sample.length, record.modules,
      "project encoding module-name evidence is incomplete");
    encodedNames.push(...record.module_names.sample);
  }
  assert.deepEqual(encodedNames, [moduleName], "source edit encoded a different project module");
}

function assertHeaderInvalidation(work, moduleName) {
  assert.ok(work.checkedSourceModules.includes(moduleName),
    "header comment edit did not recheck its importing project module");
  for (const name of ["preprocessingCalls", "headerParseCalls", "ffiConversionCalls"]) {
    assert.ok(work[name] > 0, `header comment edit did not perform ${name}`);
  }
}

function splitInitialChain(records) {
  const start = records.find((record) => record.event === "indexing.chain.start" && record.reason === "initialized");
  assert.ok(start, "missing initial indexing chain log");
  const end = records.findIndex((record) => record.event === "indexing.chain.complete" && record.chain === start.chain);
  assert.ok(end >= 0, "missing completed initial indexing chain log");
  return { initial: records.slice(0, end + 1), later: records.slice(end + 1) };
}

async function stop(child, outcome) {
  if (child.exitCode !== null || child.signalCode !== null) return outcome;
  child.stdin.destroy();
  child.kill("SIGTERM");
  try { return await withTimeout(outcome, "server termination", 5_000); }
  catch { child.kill("SIGKILL"); return withTimeout(outcome, "killed server exit", 5_000); }
}

function diagnostics(session) {
  return [...session.diagnostics].map(([uri, items]) => ({ uri, diagnostics: items }));
}

function assertNoErrorDiagnostics(session) {
  const errors = [...session.diagnostics.values()].flat()
    .filter((item) => item.severity === undefined || item.severity === 1);
  assert.equal(errors.length, 0,
    `workspace published ${errors.length} error diagnostics; see the partial session evidence`);
}

async function runSession(options, target, label, probeIdentity, edit) {
  interrupted(options);
  const executable = await stat(options.server, { bigint: true });
  for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
    assert.equal(executable[field], target.serverMetadata[field],
      "native executable changed during the benchmark; rebuild before measuring");
  }
  const logFile = path.join(options.output, `${label}.stderr.log`);
  const log = createWriteStream(logFile, { flags: "wx" });
  const logged = finished(log);
  // Observe failures immediately even while a long indexing phase is active.
  logged.catch(() => undefined);
  const started = performance.now();
  const luaRoot = path.join(REPOSITORY, ".titan", "share", "lua", "5.5");
  const child = spawn(options.server, [], {
    cwd: options.root,
    env: { ...process.env,
      TITAN_LS_LUA_PATH: process.env.TITAN_LS_LUA_PATH ?? `${luaRoot}/?.lua;${luaRoot}/?/init.lua`,
      TITAN_LS_LUA_CPATH: process.env.TITAN_LS_LUA_CPATH ?? path.join(REPOSITORY, ".titan/lib/lua/5.5/?.so"),
      TITAN_PROBE_CACHE_IDENTITY: probeIdentity, TITAN_LANGUAGE_SERVER_LOG_LEVEL: "trace" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const outcome = exitOf(child);
  outcome.catch(() => undefined);
  options.control.child = child;
  child.stderr.pipe(log);
  const session = new Session(child, options.timeoutMs);
  let clean = false;
  const measurements = {};
  try {
    await withTimeout(new Promise((resolve, reject) => {
      child.once("spawn", resolve); child.once("error", reject);
    }), "native process spawn", options.timeoutMs);
    const initialize = await session.request("initialize", {
      processId: process.pid, rootPath: options.root, rootUri: pathToFileURL(options.root).href,
      capabilities: { general: { positionEncodings: ["utf-16"] } },
      workspaceFolders: [{ uri: pathToFileURL(options.root).href, name: path.basename(options.root) }]
    });
    assert.equal(initialize.result.capabilities.positionEncoding, "utf-16");
    const initializedAt = performance.now();
    const initializedResources = await sample(child.pid, target.ticks);
    measurements.launchToInitialize = { wallMs: round(initializedAt - started), ...initializedResources };
    const indexingStarted = performance.now();
    session.send("initialized", {});
    const ready = await session.ready(indexingStarted);
    const readyResources = await sample(child.pid, target.ticks);
    measurements.initialIndex = { ...ready, ...difference(readyResources, initializedResources),
      launchToReadyWallMs: round(indexingStarted - started + ready.wallMs), cache: await cacheSizes(target.cache) };
    assertNoErrorDiagnostics(session);
    const queryStatusCount = session.statuses.length;
    measurements.features = await queries(session, target, options.queries);
    assert.equal(session.statuses.length, queryStatusCount, "unchanged queries triggered indexing");
    measurements.diagnostics = diagnostics(session);
    if (edit) {
      interrupted(options);
      assert.ok((await readFile(target.filename)).equals(target.original),
        "target changed independently before the saved edit; refusing to overwrite it");
      const beforeEdit = await sample(child.pid, target.ticks);
      const editStarted = performance.now();
      interrupted(options);
      await writeFile(target.filename, target.edited);
      const editedReady = await session.ready(editStarted, ready.epoch + 1);
      const afterEdit = await sample(child.pid, target.ticks);
      measurements.savedEdit = { ...editedReady, ...difference(afterEdit, beforeEdit),
        cache: await cacheSizes(target.cache) };
      assertNoErrorDiagnostics(session);
      const editedQueryStatuses = session.statuses.length;
      measurements.savedEdit.features = await queries(session, target, options.queries);
      assert.equal(session.statuses.length, editedQueryStatuses, "queries after the saved edit triggered indexing");
      for (const operation of Object.keys(measurements.features)) {
        assert.equal(measurements.savedEdit.features[operation].resultSha256,
          measurements.features[operation].resultSha256, `comment edit changed ${operation} result`);
      }
    }
    await session.request("shutdown", null);
    session.send("exit");
    child.stdin.end();
    assert.deepEqual(await withTimeout(outcome, "clean native server exit", 30_000), { code: 0, signal: null });
    clean = true;
  } catch (cause) {
    measurements.error = cause.stack ?? String(cause);
    throw cause;
  } finally {
    if (!clean) await stop(child, outcome).catch(() => undefined);
    options.control.child = undefined;
    await logged;
    measurements.completed = clean;
    measurements.diagnostics = diagnostics(session);
    await writeFile(path.join(options.output, `${label}.partial.json`), JSON.stringify(measurements, null, 2) + "\n");
  }
  const records = recordsFromLog(await readFile(logFile, "utf8"));
  const split = splitInitialChain(records);
  measurements.initialWork = workSummary(split.initial);
  if (edit) measurements.savedEdit.work = workSummary(split.later);
  measurements.cacheAfterShutdown = await cacheSizes(target.cache);
  await writeFile(path.join(options.output, `${label}.json`), JSON.stringify(measurements, null, 2) + "\n");
  assert.equal(measurements.initialWork.fallbackEvents.length, 0,
    "server used an in-memory fallback; a file-backed cache benchmark is unavailable");
  assert.ok(measurements.cacheAfterShutdown.files["index.sqlite3"].exists,
    "server did not leave a workspace database after shutdown");
  return measurements;
}

function inspectSqlite(options, target) {
  return JSON.parse(python(options, String.raw`
import json, sqlite3, sys
from pathlib import Path
connection = sqlite3.connect(Path(sys.argv[1]).resolve().as_uri() + '?mode=ro', uri=True)
connection.execute('PRAGMA query_only=ON')
queries = [
 ('occurrence_at', 'SELECT * FROM main.semantic_occurrences WHERE filename=? AND start_line=? AND start_character<=? AND finish_character>? ORDER BY start_character DESC LIMIT 1', [sys.argv[2].encode(), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[4])]),
 ('definition', 'SELECT * FROM main.semantic_occurrences WHERE declaration_id=? AND role IN (0,1)', [b'benchmark-symbol']),
 ('references', 'SELECT * FROM main.semantic_occurrences WHERE declaration_id=? ORDER BY filename,byte_start', [b'benchmark-symbol']),
 ('reverse_imports', 'SELECT importer FROM main.graph_imports WHERE imported=?', ['benchmark-module']),
 ('dirty_projects', 'SELECT name FROM main.graph_modules WHERE provenance=0 AND state=0', []),
]
tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
result = {'sqliteVersion': sqlite3.sqlite_version,
 'inspectionEngine': 'Python sqlite3, read-only after server shutdown',
 'databaseIntegrity': connection.execute('PRAGMA quick_check').fetchall(),
 'pageCount': connection.execute('PRAGMA page_count').fetchone()[0],
 'pageSize': connection.execute('PRAGMA page_size').fetchone()[0],
 'freelistCount': connection.execute('PRAGMA freelist_count').fetchone()[0],
 'tableRows': {name: connection.execute('SELECT COUNT(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0] for name in tables},
 'queries': [{'name': name, 'sql': sql, 'plan': connection.execute('EXPLAIN QUERY PLAN ' + sql, params).fetchall()} for name, sql, params in queries]}
connection.close()
print(json.dumps(result))
`, [path.join(target.cache, "index.sqlite3"), target.filename,
    String(target.position.line), String(target.position.character)]));
}

async function benchmark(options) {
  const target = await validate(options);
  const token = randomUUID();
  const probeIdentity = `workspace-cache-benchmark-${token}`;
  const backup = path.join(options.root, `.titan-ls-benchmark-backup-${token}`);
  target.edited = Buffer.concat([target.original, Buffer.from(`\n-- workspace cache benchmark ${token}\n`)]);
  target.header.edited = Buffer.concat([target.header.original,
    Buffer.from(`\n/* workspace cache benchmark ${token} */\n`)]);
  await mkdir(options.output, { recursive: true });
  await writeFile(path.join(options.output, "source-original.bin"), target.original, { flag: "wx" });
  await writeFile(path.join(options.output, "header-original.bin"), target.header.original, { flag: "wx" });
  const configPath = path.join(options.root, "titan-config.lua");
  const configBytes = await exists(configPath) ? await readFile(configPath) : undefined;
  if (configBytes !== undefined) {
    await writeFile(path.join(options.output, "workspace-config.lua"), configBytes, { flag: "wx" });
  }
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), completed: false,
    server: options.server, serverSha256: digest(await readFile(options.server)),
    workspace: options.root, target: { file: options.file, moduleName: options.moduleName,
      symbol: options.symbol, position: target.position },
    host: { platform: process.platform, release: os.release(), architecture: process.arch,
      cpuModel: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(),
      node: process.version, clockTicksPerSecond: target.ticks },
    checkout: checkoutState(options.root),
    setup: { logLevel: "trace", probeIdentity, queriesPerFeature: options.queries,
      timeoutMs: options.timeoutMs, osPageCacheFlushed: false, source: inputEvidence(target),
      header: inputEvidence(target.header),
      inheritedProbeCacheDisable: process.env.TITAN_PROBE_CACHE_DISABLE ?? null,
      luaPathOverride: process.env.TITAN_LS_LUA_PATH ?? null,
      luaCpathOverride: process.env.TITAN_LS_LUA_CPATH ?? null,
      projectConfig: { path: configPath, exists: configBytes !== undefined,
        sha256: configBytes === undefined ? null : digest(configBytes) },
      previousCachePresent: target.cacheMetadata !== undefined, previousCacheBackup: backup } };
  await writeFile(path.join(options.output, "setup.json"), JSON.stringify(report, null, 2) + "\n");
  let movedCache = false;
  let ownsCache = false;
  let failure;
  options.control = {};
  const interrupt = (signal) => {
    options.control.interruption ??= new Error(`benchmark interrupted by ${signal}`);
    options.control.child?.kill("SIGTERM");
  };
  const sigint = () => interrupt("SIGINT");
  const sigterm = () => interrupt("SIGTERM");
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  try {
    interrupted(options);
    if (target.cacheMetadata) { await rename(target.cache, backup); movedCache = true; }
    ownsCache = true;
    report.cold = await runSession(options, target, "cold", probeIdentity, false);
    report.restart = await runSession(options, target, "restart-and-edit", probeIdentity, true);
    report.reuseAssertions = { unchangedRestart: false, sparseImporter: false, changedHeader: false };
    assertWarmReuse(report.restart.initialWork);
    report.reuseAssertions.unchangedRestart = true;
    assertImporterReuse(report.restart.savedEdit.work, options.moduleName);
    report.reuseAssertions.sparseImporter = true;
    interrupted(options);
    assert.ok((await readFile(target.header.filename)).equals(target.header.original),
      "header changed independently before its comment edit; refusing to overwrite it");
    const headerMutationStarted = performance.now();
    interrupted(options);
    await writeFile(target.header.filename, target.header.edited);
    restoreTimes(options, target.header);
    const headerMutationWallMs = round(performance.now() - headerMutationStarted);
    report.headerChange = await runSession(options, target, "changed-header", probeIdentity, false);
    report.headerChange.mutation = { wallMs: headerMutationWallMs, mtimePreserved: true,
      originalBytes: target.header.original.length, changedBytes: target.header.edited.length,
      scenario: "header-only bytes changed while the server was closed; preceding saved source edit retained" };
    assertHeaderInvalidation(report.headerChange.initialWork, options.moduleName);
    report.reuseAssertions.changedHeader = true;
    const restartWork = report.restart.initialWork;
    const editWork = report.restart.savedEdit.work;
    report.cacheBehavior = {
      restartAvoidedSourceAnalysis: restartWork.analysisCalls === 0 && restartWork.sourceProfileCalls === 0,
      restartReencodedProjects: restartWork.encodedProjects.reduce((sum, record) => sum + record.modules, 0),
      savedEditProfileVisitedModules: editWork.sourceModules,
      savedEditParsedModules: editWork.parsedSourceModules,
      savedEditCheckedModules: editWork.checkedSourceModules,
      savedEditAvoidedHeaderPreprocessAndParse: editWork.preprocessingCalls === 0 && editWork.headerParseCalls === 0,
      savedEditFfiReplayHits: editWork.ffiReplayHits,
      savedEditFfiConversionCalls: editWork.ffiConversionCalls,
      headerChangeProfileVisitedModules: report.headerChange.initialWork.sourceModules,
      headerChangeParsedModules: report.headerChange.initialWork.parsedSourceModules,
      headerChangeCheckedModules: report.headerChange.initialWork.checkedSourceModules,
      headerChangePreprocessingCalls: report.headerChange.initialWork.preprocessingCalls,
      headerChangeFfiConversionCalls: report.headerChange.initialWork.ffiConversionCalls
    };
    for (const operation of Object.keys(report.cold.features)) {
      assert.equal(report.restart.features[operation].resultSha256,
        report.cold.features[operation].resultSha256, `restart changed ${operation} result`);
      assert.equal(report.headerChange.features[operation].resultSha256,
        report.cold.features[operation].resultSha256, `header comment edit changed ${operation} result`);
    }
    interrupted(options);
    report.sqlite = inspectSqlite(options, target);
    await writeFile(path.join(options.output, "sqlite-inspection.json"), JSON.stringify(report.sqlite, null, 2) + "\n");
    report.completed = true;
  } catch (cause) {
    failure = options.control.interruption ?? cause;
    report.error = failure.stack ?? String(failure);
  } finally {
    const restorationErrors = [];
    if (options.keepDatabase && ownsCache) {
      try {
        await mkdir(path.join(options.output, "cache"));
        for (const filename of CACHE_FILES) {
          const source = path.join(target.cache, filename);
          if (await exists(source)) await copyFile(source, path.join(options.output, "cache", filename));
        }
        report.databaseRetained = true;
      } catch (cause) {
        report.databaseRetained = false;
        report.completed = false;
        report.evidenceError = cause.stack ?? String(cause);
        failure ??= cause;
      }
    }
    try {
      await restoreInput(options, target, "source", "source-original.bin");
      report.sourceRestored = true;
    } catch (cause) {
      report.sourceRestored = false;
      restorationErrors.push(cause.stack ?? String(cause));
      failure ??= cause;
    }
    try {
      await restoreInput(options, target.header, "header", "header-original.bin");
      report.headerRestored = true;
    } catch (cause) {
      report.headerRestored = false;
      restorationErrors.push(cause.stack ?? String(cause));
      failure ??= cause;
    }
    // Cache restoration is independent of a source conflict or timestamp error.
    // A concurrent source edit must not strand the pre-existing cache backup.
    try {
      if (ownsCache) await rm(target.cache, { recursive: true, force: true });
      if (movedCache) await rename(backup, target.cache);
      report.cacheRestored = true;
    } catch (cause) {
      report.cacheRestored = false;
      restorationErrors.push(cause.stack ?? String(cause));
      failure ??= cause;
    }
    report.restored = report.sourceRestored && report.headerRestored && report.cacheRestored;
    if (restorationErrors.length > 0) report.restorationErrors = restorationErrors;
    report.completed = report.completed && report.restored;
    report.finishedAt = new Date().toISOString();
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
    await writeFile(path.join(options.output, "summary.json"), JSON.stringify(report, null, 2) + "\n");
  }
  if (failure) throw new Error(`benchmark failed; retained evidence at ${options.output}: ${failure.message}`, { cause: failure });
  return report;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) { process.stdout.write(usage() + "\n"); return; }
    const report = await benchmark(options);
    process.stdout.write(JSON.stringify({ evidence: options.output, completed: report.completed,
      coldWallMs: report.cold.initialIndex.launchToReadyWallMs,
      restartWallMs: report.restart.initialIndex.launchToReadyWallMs,
      savedEditWallMs: report.restart.savedEdit.wallMs,
      changedHeaderWallMs: report.headerChange.initialIndex.launchToReadyWallMs }) + "\n");
  } catch (cause) {
    process.stderr.write(JSON.stringify({ error: cause.message }) + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

export { assertHeaderInvalidation, assertImporterReuse, assertWarmReuse, parseArguments, recordsFromLog, workSummary };
