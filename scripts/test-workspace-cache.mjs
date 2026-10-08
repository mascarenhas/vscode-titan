import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  FrameReader, collect, exitOf, frame, launch, makePhysicalTemporaryRoot,
  printedLuaPaths, request, structuredLogRecords, waitForIndexing, withTimeout,
  writeSavedGeneration
} from "./test-server-protocol.mjs";

if (!process.argv[2]) {
  console.error("usage: node scripts/test-workspace-cache.mjs PATH-TO-SERVER");
  process.exit(2);
}

const evidenceDirectory = process.env.TITAN_WORKSPACE_CACHE_EVIDENCE;
const root = await makePhysicalTemporaryRoot("vscode-titan-cache-");
let compilerRoot;
const sourceRoot = path.join(root, "src");
const folderRoot = path.join(sourceRoot, "mathlib");
const consumerFile = path.join(sourceRoot, "consumer.titan");
const providerFile = path.join(folderRoot, "mathlib.titan");
const headerFile = path.join(root, "include", "fixture.h");
const inheritedHeaderFile = path.join(root, "include", "inherited.h");
const configFile = path.join(root, "titan-config.lua");
const unmappedFile = path.join(root, "outside.titan");
const databaseFile = path.join(root, ".titan-ls", "index.sqlite3");
const uri = (filename) => pathToFileURL(filename).href;
const config = [
  'include = { "." }',
  'source_module_roots = { "src" }',
  'extra_ffi_include_dirs = { "include" }',
  ""
].join("\n");
const consumer = (value) => [
  'local provider = import "mathlib.titan"',
  'foreign import "fixture.h"',
  "function answer(): integer",
  "  local number: foreign fixture_int = provider.forty()",
  `  return number + provider.extra() + ffi.FIXTURE_CODE + ${value}`,
  "end",
  ""
].join("\n");
const providerUseColumn = consumer(0).split("\n")[3].indexOf("forty") + 1;
assert(providerUseColumn > 0);
const fixtureHeader = (declaration) => declaration +
  "enum fixture_code { FIXTURE_CODE = INHERITED_CODE + 1 };\n";
const inheritedHeader = (value) =>
  `enum inherited_code { INHERITED_CODE = ${value} };\n`;

async function withServer(label, body, environment = {}) {
  const child = launch(root, "trace", { TITAN_PREFIX: undefined, ...environment });
  const exit = exitOf(child);
  const stderr = collect(child.stderr);
  let logTail = "";
  let restorationLogError;
  const restoration = new Promise((resolve,reject) => {
    child.stderr.on("data", (chunk) => {
      try {
        logTail += chunk.toString("utf8");
        const lines = logTail.split("\n");
        logTail = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("titan-language-server ")) continue;
          const record = JSON.parse(line.slice("titan-language-server ".length));
          if (record.event === "cache.startup.phase" && record.phase === "project_restoration") {
            resolve(record);
          }
        }
      } catch (cause) {
        restorationLogError = cause;
        reject(cause);
      }
    });
  });
  restoration.catch(() => undefined);
  const responses = new FrameReader(child.stdout);
  let closed = false;
  let nextId = 10;
  const session = {
    child, responses,
    async restored() {
      if (restorationLogError) throw restorationLogError;
      const result = await withTimeout(restoration, "background manifest restoration", 30_000);
      if (restorationLogError) throw restorationLogError;
      return result;
    },
    async query(method, params) {
      const response = await request(child, responses, nextId++, method, params, 30_000);
      assert.equal(response.error, undefined, JSON.stringify(response.error));
      return response.result;
    }
  };
  try {
    const initialize = await request(child, responses, 1, "initialize", {}, 30_000);
    assert.equal(initialize.error, undefined);
    child.stdin.write(frame({jsonrpc: "2.0", method: "initialized", params: {}}));
    const ready = await waitForIndexing(responses);
    const result = await body(session, ready);
    await session.restored();
    const shutdown = await request(child, responses, 2, "shutdown", null, 30_000);
    assert.equal(shutdown.error, undefined);
    child.stdin.end(frame({jsonrpc: "2.0", method: "exit"}));
    assert.deepEqual(await withTimeout(exit, "cache-test server exit", 30_000),
      {code: 0, signal: null});
    closed = true;
    const records = structuredLogRecords(stderr());
    if (evidenceDirectory) {
      await mkdir(evidenceDirectory, {recursive: true});
      await writeFile(path.join(evidenceDirectory, `${label}.stderr.log`), stderr());
    }
    return {records, result};
  } catch (cause) {
    throw new Error(`${label}: ${cause.message}; stderr: ${stderr().toString("utf8")}`,
      {cause});
  } finally {
    if (!closed && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await withTimeout(exit, "failed cache-test server exit", 5_000);
    }
  }
}

async function assertProbeRecords(prefix) {
  const cacheRoot = path.join(prefix, "var", "cache", "titan-probes");
  const namespaces = await readdir(cacheRoot, { withFileTypes: true });
  let records = 0;
  for (const namespace of namespaces) {
    if (!namespace.isDirectory()) continue;
    const files = await readdir(path.join(cacheRoot, namespace.name));
    records += files.filter((filename) => filename.endsWith(".result")).length;
  }
  assert.ok(records > 0, `no C-probe records were written below ${prefix}`);
}

function assertProbePrefix(actual, expected) {
  assert.equal(typeof actual, "string", "server.start did not report probe_cache_prefix");
  // Titan's portable path spelling uses forward slashes on Windows. Native
  // normalization equates those separators while preserving POSIX backslashes.
  assert.equal(path.normalize(actual), path.normalize(expected),
    "server selected an unexpected compiler probe cache prefix");
}

async function featureSnapshot(session) {
  const position = {
    textDocument: {uri: uri(consumerFile)},
    position: {line: 3, character: providerUseColumn}
  };
  const definition = await session.query("textDocument/definition", position);
  const publications = session.responses.diagnosticPublications;
  const current = publications.filter((item) => item.uri === uri(consumerFile)).at(-1);
  assert.deepEqual(current?.diagnostics ?? [], [], JSON.stringify(current?.diagnostics));
  const warning = publications.filter((item) => item.uri === uri(unmappedFile)).at(-1);
  assert.ok(warning, "unmapped-source diagnostics were not published");
  assert.equal(warning.diagnostics.length, 1);
  assert.equal(warning.diagnostics[0].code, "unmapped-source");
  assert.deepEqual(definition, {
    uri: uri(providerFile),
    range: {start: {line: 0, character: 9}, end: {line: 0, character: 14}}
  });
  const references = await session.query("textDocument/references", {
    ...position, context: {includeDeclaration: true}
  });
  assert.equal(references.length, 2);
  assert.deepEqual(new Set(references.map((location) => location.uri)),
    new Set([uri(consumerFile), uri(providerFile)]));
  const hover = await session.query("textDocument/hover", position);
  assert.match(hover.contents.value, /forty/);
  assert.match(hover.contents.value, /integer/);
  const folding = await session.query("textDocument/foldingRange", {
    textDocument: {uri: uri(consumerFile)}
  });
  assert.ok(folding.some((range) => range.startLine === 2 && range.endLine === 4));
  return {definition, references, hover, folding, warning};
}

async function failedConsumerSnapshot(session) {
  assert.equal(await session.query("textDocument/hover", {
    textDocument: {uri: uri(consumerFile)}, position: {line: 3, character: providerUseColumn}
  }), null, "invalid configuration retained old consumer semantics");
  const failed = session.responses.diagnosticPublications.filter((item) =>
    item.uri === uri(consumerFile)).at(-1);
  assert.ok(failed?.diagnostics.some((item) => item.severity === 1),
    "configuration B did not exercise an authoritative compiler failure");
  return failed;
}

function initialRecords(records) {
  const start = records.findIndex((record) =>
    record.event === "indexing.chain.start" && record.reason === "initialized");
  assert.ok(start >= 0, "initial indexing chain was not recorded");
  const finish = records.findIndex((record, index) => index > start &&
    record.event === "indexing.chain.complete" && record.chain === records[start].chain);
  assert.ok(finish > start, "initial indexing chain did not finish");
  return {initial: records.slice(0, finish + 1), later: records.slice(finish + 1)};
}

function checkedModules(records) {
  return [...new Set(records.filter((record) =>
    record.event === "compiler.source_module.profile" &&
    (record.parse_cpu_ms > 0 || record.check_cpu_ms > 0)
  ).map((record) => record.module_name))].sort();
}

function cacheStats(records) {
  const stats = records.filter((record) => record.event === "compiler.cache.stats").at(-1);
  assert.ok(stats, "compiler cache statistics were not recorded");
  return stats;
}

function assertWarmInitial(records) {
  for (const event of ["compiler.analysis.start", "compiler.source_module.profile",
    "cache.projects.encode"]) {
    assert.equal(records.some((record) => record.event === event), false,
      `unchanged restart performed ${event}`);
  }
  assert.equal(records.some((record) => record.event === "cache.projects.restore"), false,
    "warm SQL readiness waited for project manifest restoration");
  assert.equal(records.some((record) => record.event === "cache.projects.restoration_start"), false,
    "project restoration started before the warm SQL view was ready");
  const inventory = records.find((record) => record.event === "cache.inventory.validation");
  assert.ok(inventory, "compiler inventory validation omitted its counters");
  assert.equal(inventory.reads, 0, "warm compiler inventory reread unchanged content");
  assert.equal(inventory.hashes, 0, "warm compiler inventory rehashed unchanged content");
  const scans = records.filter((record) => record.event === "project.scan.complete");
  assert.ok(scans.length > 0,"warm validation omitted source scan counters");
  for (const scan of scans) {
    for (const field of ["source_content_reads","source_content_hashes",
      "external_content_reads","external_content_hashes"]) {
      assert.equal(scan[field],0,`warm validation performed ${field}`);
    }
  }
  const stats = cacheStats(records);
  assert.equal(stats.header_misses, 0,
    "unchanged restart rebuilt a completed header graph");
  assert.equal(stats.conversion_misses, 0,
    "unchanged restart rebuilt an FFI conversion graph");
  assert.equal(stats.header_file_reads, 0, "warm header validation read unchanged content");
  assert.equal(stats.header_file_hashes, 0, "warm header validation hashed unchanged content");
  assert.equal(records.some((record) =>
    record.event === "compiler.c_header.phase" &&
    (record.phase === "preprocessing" || record.phase === "c_parse" ||
      (record.phase === "downstream_ffi_conversion" && record.outcome === "complete"))),
  false, "unchanged restart preprocessed, parsed, or converted a header");
  return stats;
}

async function luaModuleDirectory(searchPath, moduleName) {
  const relative = moduleName.replaceAll(".", "/");
  for (const template of searchPath.split(";")) {
    if (!template.includes("?")) continue;
    const candidate = path.resolve(root, template.replaceAll("?", relative));
    try {
      if ((await stat(candidate)).isFile()) return path.dirname(candidate);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
  }
  throw new Error(`cannot find compiler tree for ${moduleName} in ${searchPath}`);
}

function assertCold(records) {
  assert.ok(records.some((record) => record.event === "compiler.analysis.start"));
  assert.ok(checkedModules(records).includes("consumer"));
  assert.ok(records.filter((record) => record.event === "cache.projects.encode")
    .reduce((total, record) => total + record.modules, 0) >= 2);
}

try {
  await mkdir(folderRoot, {recursive: true});
  await mkdir(path.dirname(headerFile));
  await writeFile(configFile, config);
  await writeFile(unmappedFile, "function outside(): integer\n  return 0\nend\n");
  await writeFile(providerFile, "function forty(): integer\n  return 40\nend\n" +
    'foreign import "inherited.h"\n');
  await writeFile(path.join(folderRoot, "extra.titan"),
    "function extra(): integer\n  return 1\nend\n");
  await writeFile(consumerFile, consumer(1));
  await writeFile(headerFile, fixtureHeader("typedef int  fixture_int;\n"));
  await writeFile(inheritedHeaderFile, inheritedHeader(7));
  // An integral timestamp survives Node's Date conversion exactly. The later
  // edit deliberately preserves both this timestamp and the file's size.
  const headerTimestamp = new Date("2020-01-02T03:04:05Z");
  await utimes(headerFile, headerTimestamp, headerTimestamp);
  await utimes(inheritedHeaderFile, headerTimestamp, headerTimestamp);
  const headerBefore = await stat(headerFile);

  const cold = await withServer("cold", featureSnapshot);
  assertCold(cold.records);
  assert.ok(cacheStats(cold.records).header_misses > 0);
  assert.ok(cacheStats(cold.records).conversion_misses > 0);
  assert.ok((await stat(databaseFile)).size > 0);
  const defaultProbePrefix = path.dirname(databaseFile);
  assertProbePrefix(cold.records.find((record) => record.event === "server.start")
    ?.probe_cache_prefix, defaultProbePrefix);
  await assertProbeRecords(defaultProbePrefix);

  const warm = await withServer("warm-and-edit", async (session) => {
    assert.deepEqual(await featureSnapshot(session), cold.result);
    await writeSavedGeneration(session.responses, consumerFile, consumer(2));
    assert.deepEqual(await featureSnapshot(session), cold.result);
  });
  const warmPhases = initialRecords(warm.records);
  const warmInitialCache = assertWarmInitial(warmPhases.initial);
  assert.ok(warmPhases.later.some((record) =>
    record.event === "cache.projects.restore" && record.restored === 2),
  "background restoration did not restore unchanged dependencies before the first edit");
  assert.deepEqual(checkedModules(warmPhases.later), ["consumer"],
    "first body edit reparsed or rechecked an unchanged dependency");
  const firstEditEncodes = warmPhases.later.filter((record) =>
    record.event === "cache.projects.encode");
  assert.equal(firstEditEncodes.reduce((total, record) => total + record.modules, 0), 1,
    "first body edit re-encoded unchanged project payloads");
  assert.deepEqual(firstEditEncodes.flatMap((record) => record.module_names.sample),
    ["consumer"], "first body edit encoded the wrong project payload");
  assert.equal(firstEditEncodes.some((record) => record.module_names.truncated), false);
  assert.ok(cacheStats(warmPhases.later).header_hits > 0);
  assert.ok(cacheStats(warmPhases.later).conversion_hits > 0);
  for (const field of ["header_file_reads","header_file_hashes"]) {
    assert.equal(cacheStats(warm.records)[field],0,
      `restoration or importer-only editing performed ${field}`);
  }

  await writeFile(headerFile, fixtureHeader("typedef long fixture_int;\n"));
  await utimes(headerFile, headerTimestamp, headerTimestamp);
  const headerAfter = await stat(headerFile);
  assert.equal(headerAfter.size, headerBefore.size);
  assert.equal(headerAfter.mtimeMs, headerBefore.mtimeMs);
  const trustedHeader = await withServer("trusted-header-mtime", featureSnapshot);
  assert.deepEqual(trustedHeader.result, cold.result);
  assertWarmInitial(initialRecords(trustedHeader.records).initial);
  assert.equal(cacheStats(trustedHeader.records).header_file_reads,0);
  assert.equal(cacheStats(trustedHeader.records).header_file_hashes,0);
  assert.deepEqual(checkedModules(trustedHeader.records), [],
    "unchanged header timestamp caused a content check");
  await utimes(headerFile, headerTimestamp, new Date(headerTimestamp.getTime() + 1000));
  const explicitProbePrefix = path.join(root, ".titan-ls", "explicit-probe-prefix");
  const changedHeader = await withServer("changed-header", featureSnapshot,
    { TITAN_PREFIX: explicitProbePrefix });
  assert.deepEqual(changedHeader.result, cold.result);
  assert.ok(checkedModules(changedHeader.records).includes("consumer"));
  assert.ok(cacheStats(changedHeader.records).header_misses > 0,
    "changed-mtime header edit reused a stale preprocessor graph");
  assert.ok(cacheStats(changedHeader.records).conversion_misses > 0,
    "header type edit reused a stale FFI conversion");
  assertProbePrefix(changedHeader.records.find((record) => record.event === "server.start")
    ?.probe_cache_prefix, explicitProbePrefix);
  await assertProbeRecords(explicitProbePrefix);

  await writeFile(inheritedHeaderFile, inheritedHeader(9));
  await utimes(inheritedHeaderFile, headerTimestamp,
    new Date(headerTimestamp.getTime() + 1000));
  const changedInheritedHeader = await withServer("changed-inherited-header", featureSnapshot);
  assert.deepEqual(changedInheritedHeader.result, cold.result);
  assert.deepEqual(checkedModules(changedInheritedHeader.records), ["consumer", "mathlib"],
    "inherited C environment edit did not recheck its provider and consumer");
  assert.ok(cacheStats(changedInheritedHeader.records).header_misses > 0);
  assert.ok(cacheStats(changedInheritedHeader.records).conversion_misses > 0);
  const warmInheritedHeader = await withServer("warm-inherited-header", featureSnapshot);
  assert.deepEqual(warmInheritedHeader.result, cold.result);
  assertWarmInitial(initialRecords(warmInheritedHeader.records).initial);
  assert.deepEqual(checkedModules(warmInheritedHeader.records), [],
    "unchanged inherited C environment was rechecked after restart");

  const membershipFile = path.join(folderRoot, "membership.titan");
  await withServer("membership-and-recovery", async (session) => {
    await featureSnapshot(session);
    await writeSavedGeneration(session.responses, membershipFile,
      "function added_member(): integer\n  return 3\nend\n");
    const addedHover = await session.query("textDocument/hover", {
      textDocument: {uri: uri(membershipFile)}, position: {line: 0, character: 12}
    });
    assert.match(addedHover.contents.value, /added_member/);
    let epoch = session.responses.lastIndexingEpoch;
    await rm(membershipFile);
    await waitForIndexing(session.responses, "ready", 1, epoch + 1);
    assert.equal(await session.query("textDocument/hover", {
      textDocument: {uri: uri(membershipFile)}, position: {line: 0, character: 12}
    }), null);
    await featureSnapshot(session);
    await writeSavedGeneration(session.responses, configFile,
      "this is invalid Lua\n", "failed");
    await writeSavedGeneration(session.responses, configFile, config);
    await featureSnapshot(session);
  });

  // A completed publication must carry the configuration that produced it.
  // Restore the original configuration while the process is stopped so startup
  // cannot rely on a watcher having observed the transition back from B to A.
  await writeFile(headerFile, fixtureHeader([
    "#ifdef FIXTURE_POINTER",
    "typedef const char *fixture_int;",
    "#else",
    "typedef long fixture_int;",
    "#endif",
    ""
  ].join("\n")));
  const changedConfig = await withServer("changed-config", async (session) => {
    await featureSnapshot(session);
    await writeSavedGeneration(session.responses, configFile,
      config + 'extra_ffi_cppflags = "-DFIXTURE_POINTER"\n');
    return failedConsumerSnapshot(session);
  });
  const publishedConfigurationB = await readFile(databaseFile);
  const unchangedConfig = await withServer("unchanged-config", failedConsumerSnapshot);
  assert.deepEqual(unchangedConfig.result, changedConfig.result);
  assert.equal(unchangedConfig.records.some((record) =>
    record.event === "compiler.analysis.start"), false,
  "unchanged restart rechecked a published configuration failure");
  // Test the original B publication directly; the preceding restart must not
  // repair or replace its compatibility metadata before the A validation.
  await writeFile(databaseFile, publishedConfigurationB);
  await writeFile(configFile, config);
  await utimes(consumerFile, headerTimestamp, headerTimestamp);
  const restoredConfig = await withServer("restored-config", featureSnapshot);
  assert.deepEqual(restoredConfig.result, cold.result);
  assert.ok(checkedModules(restoredConfig.records).includes("consumer"),
    "restart reused a completed graph from a different semantic configuration");

  const sourceBefore = await stat(consumerFile);
  await writeFile(consumerFile, consumer(3));
  await utimes(consumerFile, headerTimestamp, headerTimestamp);
  const sourceAfter = await stat(consumerFile);
  assert.equal(sourceAfter.size, sourceBefore.size);
  assert.equal(sourceAfter.mtimeMs, sourceBefore.mtimeMs);
  const preservedSource = await withServer("preserved-mtime-source", featureSnapshot);
  assert.deepEqual(preservedSource.result, cold.result);
  assertWarmInitial(initialRecords(preservedSource.records).initial);
  assert.deepEqual(checkedModules(preservedSource.records), [],
    "unchanged source timestamp caused a content check");
  await utimes(consumerFile, headerTimestamp, new Date(headerTimestamp.getTime() + 1000));
  const changedSource = await withServer("changed-mtime-source", featureSnapshot);
  assert.deepEqual(changedSource.result, cold.result);
  assert.deepEqual(checkedModules(changedSource.records), ["consumer"],
    "changed-mtime source edit did not recheck its module");

  const shadowHeader = path.join(sourceRoot, "fixture.h");
  await writeFile(shadowHeader, "typedef const char *fixture_int;\n");
  const shadow = await withServer("header-search-shadow", failedConsumerSnapshot);
  assert.ok(checkedModules(shadow.records).includes("consumer"),
    "new earlier include candidate did not invalidate the persisted header search");
  assert.ok(cacheStats(shadow.records).header_misses > 0);
  await rm(shadowHeader);
  const unshadowed = await withServer("removed-header-shadow", featureSnapshot);
  assert.deepEqual(unshadowed.result, cold.result);
  assert.ok(checkedModules(unshadowed.records).includes("consumer"));

  // Corrupt only an opaque compiler payload. SQLite, the dependency metadata,
  // and the preceding semantic revision remain valid for bounded recovery.
  for (const [label, damagedPayload] of [
    ["corrupt-project-payload", Buffer.from("invalid compiler graph payload")],
    ["text-project-payload", "invalid SQLite payload storage type"]
  ]) {
    const database = new DatabaseSync(databaseFile);
    try {
      assert.equal(database.prepare(
        "UPDATE main.project_snapshots SET payload=? WHERE module=?"
      ).run(damagedPayload, Buffer.from("consumer")).changes, 1);
    } finally {
      database.close();
    }
    const payload = await withServer(label, async (session, ready) => {
      assert.deepEqual(await featureSnapshot(session), cold.result,
        "valid SQL features were unavailable before corrupt graph recovery");
      await session.restored();
      await waitForIndexing(session.responses, "ready", 1, ready.epoch + 1);
      return featureSnapshot(session);
    });
    assert.deepEqual(payload.result, cold.result);
    assert.deepEqual(checkedModules(payload.records), ["consumer"]);
    assert.ok(payload.records.some((record) => record.event === "cache.project.miss"));
    assert.equal(payload.records.some((record) =>
      record.event === "cache.memory_fallback"), false);
  }

  const artifacts = new DatabaseSync(databaseFile);
  try {
    for (const table of ["header_graphs", "ffi_conversion_snapshots"]) {
      assert.ok(artifacts.prepare(`UPDATE main.${table} SET payload=?`).run(
        "invalid SQLite payload storage type").changes > 0);
    }
  } finally {
    artifacts.close();
  }
  await writeFile(consumerFile, consumer(4));
  const artifactTypes = await withServer("text-header-and-ffi-payloads", featureSnapshot);
  assert.deepEqual(artifactTypes.result, cold.result);
  assert.deepEqual(checkedModules(artifactTypes.records), ["consumer"]);
  assert.ok(cacheStats(artifactTypes.records).header_misses > 0);
  assert.ok(cacheStats(artifactTypes.records).conversion_misses > 0);
  assert.equal(artifactTypes.records.some((record) =>
    record.event === "cache.memory_fallback"), false);

  await writeFile(databaseFile, "deliberately corrupt disposable cache\n");
  const corrupt = await withServer("corrupt-rebuild", featureSnapshot);
  assert.deepEqual(corrupt.result, cold.result);
  assertCold(corrupt.records);
  assert.equal(corrupt.records.some((record) =>
    record.event === "cache.memory_fallback"), false,
  "corrupt cache was not rebuilt on disk");

  const incompatible = await readFile(databaseFile);
  assert.equal(incompatible.subarray(0, 16).toString("binary"), "SQLite format 3\0");
  incompatible.writeUInt32BE(99, 60); // SQLite database header user_version.
  await writeFile(databaseFile, incompatible);
  const schema = await withServer("incompatible-rebuild", featureSnapshot);
  assert.deepEqual(schema.result, cold.result);
  assertCold(schema.records);
  assert.equal(schema.records.some((record) =>
    record.event === "cache.memory_fallback"), false);

  // Exercise the actual compiler-content inventory across process restarts.
  // Both complete Lua trees are private copies; dependencies still resolve
  // through the original complete source/native search paths.
  const printedPaths = await printedLuaPaths(process.env);
  const luaPath = /^package\.path=(.*)$/m.exec(printedPaths)?.[1];
  const nativePath = /^package\.cpath=(.*)$/m.exec(printedPaths)?.[1];
  assert.ok(luaPath && nativePath, "native server did not report complete Lua paths");
  compilerRoot = await makePhysicalTemporaryRoot("vscode-titan-cache-compiler-");
  for (const moduleName of ["titan-compiler.driver", "c-parser.cdriver"]) {
    const source = await luaModuleDirectory(luaPath, moduleName);
    await cp(source, path.join(compilerRoot, moduleName.split(".")[0]), {
      recursive: true, force: false, errorOnExist: true
    });
  }
  const copiedEnvironment = {
    TITAN_LS_LUA_PATH: `${compilerRoot}/?.lua;${compilerRoot}/?/init.lua;${luaPath}`,
    TITAN_LS_LUA_CPATH: nativePath
  };
  const copiedDriver = path.join(compilerRoot, "titan-compiler", "driver.lua");
  const originalDriver = await readFile(copiedDriver);
  const suffix = (version) => Buffer.from(`\n-- workspace cache compiler identity ${version}\n`);
  await writeFile(copiedDriver, Buffer.concat([originalDriver, suffix("A")]));
  await utimes(copiedDriver, headerTimestamp, headerTimestamp);
  const compilerBefore = await stat(copiedDriver);
  const compilerCold = await withServer("compiler-copy-cold", featureSnapshot,
    copiedEnvironment);
  assert.deepEqual(compilerCold.result, cold.result);
  assertCold(compilerCold.records);
  const compilerWarm = await withServer("compiler-copy-warm", featureSnapshot,
    copiedEnvironment);
  assert.deepEqual(compilerWarm.result, cold.result);
  const compilerWarmCache = assertWarmInitial(initialRecords(compilerWarm.records).initial);
  assert.equal(cacheStats(compilerWarm.records).header_file_reads,0);
  assert.equal(cacheStats(compilerWarm.records).header_file_hashes,0);
  await writeFile(copiedDriver, Buffer.concat([originalDriver, suffix("B")]));
  await utimes(copiedDriver, headerTimestamp, headerTimestamp);
  const compilerAfter = await stat(copiedDriver);
  assert.equal(compilerAfter.size, compilerBefore.size);
  assert.equal(compilerAfter.mtimeMs, compilerBefore.mtimeMs);
  const trustedCompiler = await withServer("trusted-compiler-mtime", featureSnapshot,
    copiedEnvironment);
  assertWarmInitial(initialRecords(trustedCompiler.records).initial);
  assert.deepEqual(checkedModules(trustedCompiler.records), [],
    "unchanged compiler timestamp triggered content validation");
  await utimes(copiedDriver, headerTimestamp, new Date(headerTimestamp.getTime() + 1000));
  const compilerChanged = await withServer("compiler-content-change", featureSnapshot,
    copiedEnvironment);
  assert.deepEqual(compilerChanged.result, cold.result);
  assertCold(compilerChanged.records);
  assert.deepEqual(checkedModules(compilerChanged.records), ["consumer", "mathlib"],
    "changed-mtime compiler change reused a checked project graph");

  const docProvider = path.join(sourceRoot, "docprovider.titan");
  const docConsumer = path.join(sourceRoot, "docconsumer.titan");
  const documentedSource = (summary) => `--- ${summary} private count.\n` +
    "-- @usage functions.md#named-calls\nlocal function hidden(): integer return 1 end\n";
  await writeFile(docProvider, documentedSource("Before"));
  await writeFile(docConsumer, 'local docs = import "docprovider.titan"\n' +
    'function read(): integer return docs.hidden() end\n');
  const documentedPosition = {textDocument: {uri: uri(docConsumer)},
    position: {line: 1, character: 39}};
  const docEdited = await withServer("saved-private-documentation-edit", async (session) => {
    const before = await session.query("textDocument/hover", documentedPosition);
    assert.match(before.contents.value, /Before private count/);
    await writeSavedGeneration(session.responses, docProvider, documentedSource("Updated"));
    const after = await session.query("textDocument/hover", documentedPosition);
    assert.match(after.contents.value, /Updated private count/,
      "doc-only source import edit retained stale dependent hover");
    assert.doesNotMatch(after.contents.value, /Before private count/);
    return after;
  });
  const docWarm = await withServer("warm-private-documentation", async (session) =>
    session.query("textDocument/hover", documentedPosition));
  assert.deepEqual(docWarm.result, docEdited.result,
    "private declaration documentation changed across warm restart");
  assertWarmInitial(initialRecords(docWarm.records).initial);
  assert.deepEqual(checkedModules(docWarm.records), [],
    "warm documentation lookup rechecked source modules");
  await rm(docConsumer);
  await rm(docProvider);

  await rm(path.dirname(databaseFile), {recursive: true});
  await writeFile(path.dirname(databaseFile), "persistence intentionally unavailable\n");
  const fallback = await withServer("memory-fallback", featureSnapshot);
  assert.deepEqual(fallback.result, cold.result);
  assert.ok(fallback.records.some((record) => record.event === "cache.memory_fallback"));
  assertCold(fallback.records);

  const summary = {
    cold_checked: checkedModules(cold.records),
    cold_indexing_cpu_ms: initialRecords(cold.records).initial.at(-1).cpu_ms,
    warm_indexing_cpu_ms: warmPhases.initial.at(-1).cpu_ms,
    warm_restoration: warmPhases.later.filter((record) =>
      record.event === "cache.projects.restore"),
    warm_startup_phases: warmPhases.initial.filter((record) =>
      record.event === "cache.startup.phase"),
    warm_source_profiles: 0,
    warm_reencoded_modules: 0,
    warm_initial_cache: warmInitialCache,
    first_edit_checked: checkedModules(warmPhases.later),
    first_edit_encoded: firstEditEncodes,
    first_edit_cache: cacheStats(warmPhases.later),
    changed_header_cache: cacheStats(changedHeader.records),
    compiler_identity: {
      warm_initial_cache: compilerWarmCache,
      changed_checked: checkedModules(compilerChanged.records),
      preserved_size: compilerAfter.size,
      preserved_mtime_ms: compilerAfter.mtimeMs
    },
    verified: ["feature replay", "folder membership", "failure recovery",
      "configuration publication identity", "compiler content identity",
      "unchanged-mtime source/header/compiler trust", "changed-mtime source/header/compiler invalidation",
      "ordered inherited C environment restart and header invalidation",
      "SQL readiness before background restoration", "include-search shadowing", "corrupt project payload",
      "invalid SQLite payload storage types",
      "corrupt rebuild", "incompatible rebuild", "memory fallback"]
  };
  if (evidenceDirectory) {
    await writeFile(path.join(evidenceDirectory, "summary.json"),
      JSON.stringify(summary, null, 2) + "\n");
  }
  console.log("native workspace-cache restart transcript passed");
} finally {
  await rm(root, {recursive: true, force: true});
  if (compilerRoot) await rm(compilerRoot, {recursive: true, force: true});
}
