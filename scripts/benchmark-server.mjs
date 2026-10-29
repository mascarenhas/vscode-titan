#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compilerDiscoveryEnvironment, resolveTitanSdk } from "./titan-sdk.mjs";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const TERMINATION_GRACE_MS = 2_000;
const INDEXING_STATUS_METHOD = "titan/indexingStatus";
const BENCHMARK_FILE = "src/server/application.titan";
const BENCHMARK_MARKER = 'self:start_refresh(false, "semantic_request")';
const BENCHMARK_SYMBOL = "start_refresh";
const LOG_LEVELS = new Set(["off", "error", "info", "debug", "trace"]);
const STRUCTURED_LOG_PREFIX = "titan-language-server ";
const MAX_PROFILE_LINE_CHARACTERS = 1024 * 1024;
const SOURCE_PROFILE_EVENT = "compiler.source_module.profile";
const SOURCE_PROFILE_OUTCOMES = new Set(["complete", "failed"]);
const NORMALIZATION_PROFILE_EVENT = "compiler.module.normalization";
const HEADER_PHASE_EVENT = "compiler.c_header.phase";
const PROBE_CACHE_EVENT = "compiler.c_probe.cache";
const PROBE_SEMANTIC_EVENT = "compiler.c_probe.semantic";
const PROBE_EXECUTION_EVENT = "compiler.c_probe.execution";
const HEADER_PROCESS_TOTAL_PHASE = "process_total";
const HEADER_DOWNSTREAM_PHASE = "downstream_ffi_conversion";
const PERSISTENT_SUCCESS_CACHE = "persistent success";
const PROBE_CACHE_STAGES = new Set(["baseline", "candidate"]);
const PROBE_OUTCOMES = new Set([
  "success", "compiler_rejection", "infrastructure_failure"
]);
const PROBE_CACHE_TIERS = new Set([
  "service", "analysis", "persistent", "compiler"
]);
const PROBE_BATCH_KINDS = new Set(["single", "batch"]);
const PROBE_PUBLICATIONS = new Set([
  "not_applicable", "published", "existing", "failed", "conflict",
  "disabled", "unstable_diagnostic", "too_large",
  "diagnostic_not_persisted", "mixed"
]);
const PROBE_PERSISTENT_LOOKUPS = new Set([
  "not_applicable", "disabled", "memory", "hit", "miss", "invalid",
  "io_error", "mixed"
]);
const MAX_PROBE_HEADER_LABEL_BYTES = 4096;
const PROFILE_CPU_ROUNDING_ULPS = 64;
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
class BenchmarkError extends Error {}

function profileString(record, field, event, allowEmpty = false) {
  const value = record[field];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new BenchmarkError(
      `${event} field ${field} must be ${allowEmpty ? "a string" : "a nonempty string"}`
    );
  }
  return value;
}

function profileMilliseconds(record, field, event) {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new BenchmarkError(
      `${event} field ${field} must be a finite nonnegative number`
    );
  }
  return value;
}

function profileCpuRemainder(total, components, event, totalField,
                             componentFields) {
  const componentTotal = components.reduce(
    (sum, component) => sum + component, 0);
  if (!Number.isFinite(componentTotal)) {
    throw new BenchmarkError(
      `${event} fields ${componentFields.join(" plus ")} must not exceed ${totalField}`
    );
  }
  const tolerance = Number.EPSILON * PROFILE_CPU_ROUNDING_ULPS *
    Math.max(1, total, componentTotal);
  if (componentTotal > total + tolerance) {
    throw new BenchmarkError(
      `${event} fields ${componentFields.join(" plus ")} must not exceed ${totalField}`
    );
  }
  return Math.max(0, total - componentTotal);
}

function profileBoolean(record, field, event) {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new BenchmarkError(`${event} field ${field} must be a boolean`);
  }
  return value;
}

function stableDisplayValue(current, candidate) {
  if (candidate.length === 0) return current;
  if (current.length === 0 || candidate < current) return candidate;
  return current;
}

function compareProfileStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function addPhase(accumulator, phase, cpuMs) {
  const current = accumulator.get(phase) ?? { calls: 0, cpuMs: 0 };
  current.calls += 1;
  current.cpuMs += cpuMs;
  accumulator.set(phase, current);
}

function phaseRows(phases) {
  return [...phases].map(([phase, value]) => ({
    phase,
    calls: value.calls,
    cpuMs: roundMilliseconds(value.cpuMs)
  })).sort((left, right) =>
    right.cpuMs - left.cpuMs ||
    compareProfileStrings(left.phase, right.phase));
}

function cacheRate(hits, requests) {
  if (requests === 0) return 0;
  return Math.round(hits * 1_000_000 / requests) / 1_000_000;
}

function cacheCounts(source) {
  const requests = source.hits + source.misses;
  return {
    hits: source.hits,
    misses: source.misses,
    requests,
    hitRate: cacheRate(source.hits, requests)
  };
}

function recordCacheRequest(target, hit) {
  if (hit) target.hits += 1;
  else target.misses += 1;
}

function profileEnum(record, field, event, allowed) {
  const value = profileString(record, field, event);
  if (!allowed.has(value)) {
    throw new BenchmarkError(
      `${event} field ${field} has unsupported value ${JSON.stringify(value)}`
    );
  }
  return value;
}

function profileProbeKey(record, event) {
  const key = profileString(record, "key", event);
  if (!/^[0-9a-f]{64}$/.test(key)) {
    throw new BenchmarkError(`${event} field key must be a 64-byte hex digest`);
  }
  return key;
}

function profileProbeHeaderLabel(record, event) {
  const label = profileString(record, "header_label", event, true);
  if (Buffer.byteLength(label, "utf8") > MAX_PROBE_HEADER_LABEL_BYTES) {
    throw new BenchmarkError(
      `${event} field header_label must be a string of at most ${MAX_PROBE_HEADER_LABEL_BYTES} bytes`
    );
  }
  return label;
}

function recordProbeHeaderLabel(labels, identity, label) {
  const existing = labels.get(identity);
  if (existing === undefined) {
    labels.set(identity, label);
  } else {
    // The semantic identity deliberately ignores redundant source spellings,
    // while its human-readable label is derived from those spellings. Pick a
    // stable nonempty representative without splitting or rejecting one
    // equivalent header context.
    labels.set(identity, stableDisplayValue(existing, label));
  }
}

function newLogicalCounts() {
  return { requests: 0, repeatedRequests: 0, keys: new Set() };
}

function recordLogicalCounts(target, key, repeated) {
  target.requests += 1;
  if (repeated) target.repeatedRequests += 1;
  target.keys.add(key);
}

function logicalCounts(target) {
  return {
    requests: target.requests,
    uniqueKeys: target.keys.size,
    repeatedRequests: target.repeatedRequests
  };
}

function recordLogicalDimension(map, name, key, repeated) {
  let target = map.get(name);
  if (target === undefined) {
    target = newLogicalCounts();
    map.set(name, target);
  }
  recordLogicalCounts(target, key, repeated);
}

function logicalRows(map, field) {
  return [...map].map(([name, source]) => ({
    [field]: name,
    ...logicalCounts(source)
  })).sort((left, right) =>
    right.requests - left.requests ||
    compareProfileStrings(String(left[field]), String(right[field])));
}

function newPhysicalCounts() {
  return { attempts: 0, launches: 0, measuredLaunches: 0, childWallMs: 0 };
}

function recordPhysicalCounts(target, started, wallMs) {
  target.attempts += 1;
  if (!started) return;
  target.launches += 1;
  if (wallMs !== undefined) {
    target.measuredLaunches += 1;
    target.childWallMs += wallMs;
  }
}

function physicalCounts(target) {
  return {
    attempts: target.attempts,
    launches: target.launches,
    measuredLaunches: target.measuredLaunches,
    childWallMs: roundMilliseconds(target.childWallMs)
  };
}

function recordPhysicalDimension(map, name, started, wallMs) {
  let target = map.get(name);
  if (target === undefined) {
    target = newPhysicalCounts();
    map.set(name, target);
  }
  recordPhysicalCounts(target, started, wallMs);
}

function physicalRows(map, field) {
  return [...map].map(([name, source]) => ({
    [field]: name,
    ...physicalCounts(source)
  })).sort((left, right) =>
    right.childWallMs - left.childWallMs ||
    right.launches - left.launches ||
    right.attempts - left.attempts ||
    compareProfileStrings(String(left[field]), String(right[field])));
}

function logicalHeaderContextRows(map, labels) {
  return [...map].map(([headerIdentity, source]) => ({
    headerIdentity,
    headerLabel: labels.get(headerIdentity),
    ...logicalCounts(source)
  })).sort((left, right) =>
    right.requests - left.requests ||
    compareProfileStrings(left.headerLabel, right.headerLabel) ||
    compareProfileStrings(left.headerIdentity, right.headerIdentity));
}

function physicalHeaderContextRows(map, labels) {
  return [...map].map(([headerIdentity, source]) => ({
    headerIdentity,
    headerLabel: labels.get(headerIdentity),
    ...physicalCounts(source)
  })).sort((left, right) =>
    right.childWallMs - left.childWallMs ||
    right.launches - left.launches ||
    right.attempts - left.attempts ||
    compareProfileStrings(left.headerLabel, right.headerLabel) ||
    compareProfileStrings(left.headerIdentity, right.headerIdentity));
}

function newAttributionStream() {
  return {
    seen: false,
    firstCpuMs: 0,
    reuseTotalCpuMs: 0,
    reuseCalls: 0,
    reuseMaxCpuMs: 0
  };
}

function recordAttribution(stream, cpuMs) {
  if (!stream.seen) {
    stream.seen = true;
    stream.firstCpuMs = cpuMs;
    return;
  }
  stream.reuseTotalCpuMs += cpuMs;
  stream.reuseCalls += 1;
  stream.reuseMaxCpuMs = Math.max(stream.reuseMaxCpuMs, cpuMs);
}

function firstReuseMetrics(...streams) {
  let firstCallCpuMs = 0;
  let reuseTotalCpuMs = 0;
  let reuseCalls = 0;
  let reuseMaxCpuMs = 0;
  for (const stream of streams) {
    firstCallCpuMs += stream.firstCpuMs;
    reuseTotalCpuMs += stream.reuseTotalCpuMs;
    reuseCalls += stream.reuseCalls;
    reuseMaxCpuMs = Math.max(reuseMaxCpuMs, stream.reuseMaxCpuMs);
  }
  return {
    firstCallCpuMs: roundMilliseconds(firstCallCpuMs),
    reuseTotalCpuMs: roundMilliseconds(reuseTotalCpuMs),
    reuseCalls,
    reuseAverageCpuMs: roundMilliseconds(
      reuseCalls === 0 ? 0 : reuseTotalCpuMs / reuseCalls),
    reuseMaxCpuMs: roundMilliseconds(reuseMaxCpuMs)
  };
}

class ColdProfileAccumulator {
  constructor() {
    this.modules = new Map();
    this.headers = new Map();
    this.headerComponentPhases = new Map();
    this.probeCacheStages = new Map();
    this.persistentProbeModules = new Map();
    this.probeCacheRecords = 0;
    this.logicalProbes = newLogicalCounts();
    this.logicalProbeOutcomes = new Map();
    this.logicalProbeTiers = new Map();
    this.logicalProbeRepetitions = new Map();
    this.logicalProbePublications = new Map();
    this.logicalProbeModules = new Map();
    this.probeHeaderLabels = new Map();
    this.logicalProbeHeaderContexts = new Map();
    this.semanticProbeRecords = 0;
    this.physicalProbes = newPhysicalCounts();
    this.physicalProbeOutcomes = new Map();
    this.physicalProbeBatchKinds = new Map();
    this.physicalProbeLookups = new Map();
    this.physicalProbePublications = new Map();
    this.physicalProbeModules = new Map();
    this.physicalProbeHeaderContexts = new Map();
    this.executionProbeRecords = 0;
    this.traceRecords = 0;
  }

  ingest(record) {
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      return false;
    }
    const event = record.event;
    if (event === SOURCE_PROFILE_EVENT) {
      this.ingestSourceModule(record);
    } else if (event === NORMALIZATION_PROFILE_EVENT) {
      this.ingestNormalization(record);
    } else if (event === HEADER_PHASE_EVENT) {
      this.ingestHeaderPhase(record);
    } else if (event === PROBE_CACHE_EVENT) {
      this.ingestProbeCache(record);
    } else if (event === PROBE_SEMANTIC_EVENT) {
      this.ingestProbeSemantic(record);
    } else if (event === PROBE_EXECUTION_EVENT) {
      this.ingestProbeExecution(record);
    } else {
      return false;
    }
    this.traceRecords += 1;
    return true;
  }

  moduleRow(record, event) {
    const moduleName = profileString(record, "module_name", event);
    const filename = profileString(record, "filename", event);
    const key = JSON.stringify([moduleName, filename]);
    let row = this.modules.get(key);
    if (row === undefined) {
      row = {
        moduleName,
        filename,
        calls: 0,
        selfCpuMs: 0,
        parseCpuMs: 0,
        checkCpuMs: 0,
        otherCpuMs: 0,
        inclusiveCpuMs: 0,
        normalizationCpuMs: 0,
        sourceAttribution: newAttributionStream(),
        normalizationAttribution: newAttributionStream()
      };
      this.modules.set(key, row);
    }
    return row;
  }

  ingestSourceModule(record) {
    profileString(record, "root_module", SOURCE_PROFILE_EVENT);
    const outcome = profileString(record, "outcome", SOURCE_PROFILE_EVENT);
    if (!SOURCE_PROFILE_OUTCOMES.has(outcome)) {
      throw new BenchmarkError(
        `${SOURCE_PROFILE_EVENT} field outcome must be complete or failed`
      );
    }
    const selfCpuMs = profileMilliseconds(
      record, "self_cpu_ms", SOURCE_PROFILE_EVENT);
    const inclusiveCpuMs = profileMilliseconds(
      record, "total_cpu_ms", SOURCE_PROFILE_EVENT);
    profileCpuRemainder(
      inclusiveCpuMs, [selfCpuMs], SOURCE_PROFILE_EVENT,
      "total_cpu_ms", ["self_cpu_ms"]);
    const parseCpuMs = profileMilliseconds(
      record, "parse_cpu_ms", SOURCE_PROFILE_EVENT);
    const checkCpuMs = profileMilliseconds(
      record, "check_cpu_ms", SOURCE_PROFILE_EVENT);
    const otherCpuMs = profileCpuRemainder(
      selfCpuMs, [parseCpuMs, checkCpuMs], SOURCE_PROFILE_EVENT,
      "self_cpu_ms", ["parse_cpu_ms", "check_cpu_ms"]);
    const row = this.moduleRow(record, SOURCE_PROFILE_EVENT);
    row.calls += 1;
    row.selfCpuMs += selfCpuMs;
    row.parseCpuMs += parseCpuMs;
    row.checkCpuMs += checkCpuMs;
    row.otherCpuMs += otherCpuMs;
    row.inclusiveCpuMs += inclusiveCpuMs;
    recordAttribution(row.sourceAttribution, selfCpuMs);
  }

  ingestNormalization(record) {
    profileString(record, "root_module", NORMALIZATION_PROFILE_EVENT);
    const cpuMs = profileMilliseconds(
      record, "cpu_ms", NORMALIZATION_PROFILE_EVENT);
    const row = this.moduleRow(record, NORMALIZATION_PROFILE_EVENT);
    row.normalizationCpuMs += cpuMs;
    recordAttribution(row.normalizationAttribution, cpuMs);
  }

  ingestHeaderPhase(record) {
    profileString(record, "root_module", HEADER_PHASE_EVENT);
    const header = profileString(
      record, "header", HEADER_PHASE_EVENT, true);
    const resolvedHeader = profileString(
      record, "resolved_header", HEADER_PHASE_EVENT, true);
    const identity = profileString(record, "identity", HEADER_PHASE_EVENT);
    const phase = profileString(record, "phase", HEADER_PHASE_EVENT);
    profileString(record, "outcome", HEADER_PHASE_EVENT, true);
    const cpuMs = profileMilliseconds(record, "cpu_ms", HEADER_PHASE_EVENT);
    let row = this.headers.get(identity);
    if (row === undefined) {
      row = {
        identity,
        header: "",
        resolvedHeader: "",
        calls: 0,
        processCpuMs: 0,
        downstreamConversionCpuMs: 0,
        componentPhases: new Map(),
        processAttribution: newAttributionStream(),
        downstreamAttribution: newAttributionStream()
      };
      this.headers.set(identity, row);
    }
    row.header = stableDisplayValue(row.header, header);
    row.resolvedHeader = stableDisplayValue(
      row.resolvedHeader, resolvedHeader);
    if (phase === HEADER_PROCESS_TOTAL_PHASE) {
      row.calls += 1;
      row.processCpuMs += cpuMs;
      recordAttribution(row.processAttribution, cpuMs);
    } else if (phase === HEADER_DOWNSTREAM_PHASE) {
      row.downstreamConversionCpuMs += cpuMs;
      recordAttribution(row.downstreamAttribution, cpuMs);
    } else {
      addPhase(row.componentPhases, phase, cpuMs);
      addPhase(this.headerComponentPhases, phase, cpuMs);
    }
  }

  ingestProbeCache(record) {
    profileString(record, "root_module", PROBE_CACHE_EVENT);
    const moduleName = profileString(
      record, "module_name", PROBE_CACHE_EVENT);
    const cache = profileString(record, "cache", PROBE_CACHE_EVENT);
    if (cache !== PERSISTENT_SUCCESS_CACHE) {
      throw new BenchmarkError(
        `${PROBE_CACHE_EVENT} field cache must be ${JSON.stringify(PERSISTENT_SUCCESS_CACHE)}`
      );
    }
    const stage = profileString(record, "stage", PROBE_CACHE_EVENT);
    if (!PROBE_CACHE_STAGES.has(stage)) {
      throw new BenchmarkError(
        `${PROBE_CACHE_EVENT} field stage must be baseline or candidate`
      );
    }
    const hit = profileBoolean(record, "hit", PROBE_CACHE_EVENT);
    profileString(record, "key", PROBE_CACHE_EVENT);
    profileString(record, "path", PROBE_CACHE_EVENT);
    let stageEntry = this.probeCacheStages.get(stage);
    if (stageEntry === undefined) {
      stageEntry = { stage, hits: 0, misses: 0 };
      this.probeCacheStages.set(stage, stageEntry);
    }
    recordCacheRequest(stageEntry, hit);
    this.probeCacheRecords += 1;
    let moduleEntry = this.persistentProbeModules.get(moduleName);
    if (moduleEntry === undefined) {
      moduleEntry = { moduleName, hits: 0, misses: 0 };
      this.persistentProbeModules.set(moduleName, moduleEntry);
    }
    recordCacheRequest(moduleEntry, hit);
  }

  ingestProbeSemantic(record) {
    profileString(record, "root_module", PROBE_SEMANTIC_EVENT);
    const moduleName = profileString(
      record, "module_name", PROBE_SEMANTIC_EVENT, true);
    const key = profileProbeKey(record, PROBE_SEMANTIC_EVENT);
    profileString(record, "probe_kind", PROBE_SEMANTIC_EVENT);
    const headerIdentity = profileString(
      record, "header_identity", PROBE_SEMANTIC_EVENT, true);
    const headerLabel = profileProbeHeaderLabel(record, PROBE_SEMANTIC_EVENT);
    const outcome = profileEnum(
      record, "outcome", PROBE_SEMANTIC_EVENT, PROBE_OUTCOMES);
    const cacheTier = profileEnum(
      record, "cache_tier", PROBE_SEMANTIC_EVENT, PROBE_CACHE_TIERS);
    const repeated = profileBoolean(
      record, "repeated", PROBE_SEMANTIC_EVENT);
    const publication = profileEnum(
      record, "publication", PROBE_SEMANTIC_EVENT, PROBE_PUBLICATIONS);

    recordLogicalCounts(this.logicalProbes, key, repeated);
    recordLogicalDimension(
      this.logicalProbeOutcomes, outcome, key, repeated);
    recordLogicalDimension(
      this.logicalProbeTiers, cacheTier, key, repeated);
    recordLogicalDimension(
      this.logicalProbeRepetitions, repeated, key, repeated);
    recordLogicalDimension(
      this.logicalProbePublications, publication, key, repeated);
    recordLogicalDimension(
      this.logicalProbeModules, moduleName, key, repeated);
    recordProbeHeaderLabel(
      this.probeHeaderLabels, headerIdentity, headerLabel);
    recordLogicalDimension(
      this.logicalProbeHeaderContexts, headerIdentity, key, repeated);
    this.semanticProbeRecords += 1;
  }

  ingestProbeExecution(record) {
    profileString(record, "root_module", PROBE_EXECUTION_EVENT);
    const moduleName = profileString(
      record, "module_name", PROBE_EXECUTION_EVENT, true);
    profileProbeKey(record, PROBE_EXECUTION_EVENT);
    profileString(record, "probe_kind", PROBE_EXECUTION_EVENT);
    const batchKind = profileEnum(
      record, "batch_kind", PROBE_EXECUTION_EVENT, PROBE_BATCH_KINDS);
    const headerIdentity = profileString(
      record, "header_identity", PROBE_EXECUTION_EVENT, true);
    const headerLabel = profileProbeHeaderLabel(record, PROBE_EXECUTION_EVENT);
    const outcome = profileEnum(
      record, "outcome", PROBE_EXECUTION_EVENT, PROBE_OUTCOMES);
    const lookup = profileEnum(
      record, "persistent_lookup", PROBE_EXECUTION_EVENT,
      PROBE_PERSISTENT_LOOKUPS);
    const publication = profileEnum(
      record, "publication", PROBE_EXECUTION_EVENT, PROBE_PUBLICATIONS);
    const started = profileBoolean(
      record, "started", PROBE_EXECUTION_EVENT);
    const wallMs = record.wall_ms === undefined
      ? undefined
      : profileMilliseconds(record, "wall_ms", PROBE_EXECUTION_EVENT);

    recordProbeHeaderLabel(
      this.probeHeaderLabels, headerIdentity, headerLabel);
    recordPhysicalCounts(this.physicalProbes, started, wallMs);
    recordPhysicalDimension(
      this.physicalProbeOutcomes, outcome, started, wallMs);
    recordPhysicalDimension(
      this.physicalProbeBatchKinds, batchKind, started, wallMs);
    recordPhysicalDimension(
      this.physicalProbeLookups, lookup, started, wallMs);
    recordPhysicalDimension(
      this.physicalProbePublications, publication, started, wallMs);
    recordPhysicalDimension(
      this.physicalProbeModules, moduleName, started, wallMs);
    recordPhysicalDimension(
      this.physicalProbeHeaderContexts, headerIdentity, started, wallMs);
    this.executionProbeRecords += 1;
  }

  finish() {
    if (this.traceRecords === 0) return undefined;
    const moduleTotals = {
      calls: 0,
      selfCpuMs: 0,
      parseCpuMs: 0,
      checkCpuMs: 0,
      otherCpuMs: 0,
      normalizationCpuMs: 0,
      attributedCpuMs: 0
    };
    const modules = [...this.modules.values()].map((source) => {
      const attributedCpuMs = source.selfCpuMs + source.normalizationCpuMs;
      moduleTotals.calls += source.calls;
      moduleTotals.selfCpuMs += source.selfCpuMs;
      moduleTotals.parseCpuMs += source.parseCpuMs;
      moduleTotals.checkCpuMs += source.checkCpuMs;
      moduleTotals.otherCpuMs += source.otherCpuMs;
      moduleTotals.normalizationCpuMs += source.normalizationCpuMs;
      moduleTotals.attributedCpuMs += attributedCpuMs;
      return {
        moduleName: source.moduleName,
        filename: source.filename,
        calls: source.calls,
        selfCpuMs: roundMilliseconds(source.selfCpuMs),
        parseCpuMs: roundMilliseconds(source.parseCpuMs),
        checkCpuMs: roundMilliseconds(source.checkCpuMs),
        otherCpuMs: roundMilliseconds(source.otherCpuMs),
        inclusiveCpuMs: roundMilliseconds(source.inclusiveCpuMs),
        normalizationCpuMs: roundMilliseconds(source.normalizationCpuMs),
        attributedCpuMs: roundMilliseconds(attributedCpuMs),
        ...firstReuseMetrics(
          source.sourceAttribution, source.normalizationAttribution)
      };
    }).sort((left, right) =>
      right.attributedCpuMs - left.attributedCpuMs ||
      compareProfileStrings(left.moduleName, right.moduleName) ||
      compareProfileStrings(left.filename, right.filename));

    const headerTotals = {
      calls: 0,
      processCpuMs: 0,
      downstreamConversionCpuMs: 0,
      attributedCpuMs: 0,
      componentPhases: phaseRows(this.headerComponentPhases)
    };
    const headers = [...this.headers.values()].map((source) => {
      const attributedCpuMs = source.processCpuMs +
        source.downstreamConversionCpuMs;
      headerTotals.calls += source.calls;
      headerTotals.processCpuMs += source.processCpuMs;
      headerTotals.downstreamConversionCpuMs +=
        source.downstreamConversionCpuMs;
      headerTotals.attributedCpuMs += attributedCpuMs;
      return {
        identity: source.identity,
        header: source.header,
        resolvedHeader: source.resolvedHeader,
        calls: source.calls,
        processCpuMs: roundMilliseconds(source.processCpuMs),
        downstreamConversionCpuMs: roundMilliseconds(
          source.downstreamConversionCpuMs),
        attributedCpuMs: roundMilliseconds(attributedCpuMs),
        ...firstReuseMetrics(
          source.processAttribution, source.downstreamAttribution),
        componentPhases: phaseRows(source.componentPhases)
      };
    }).sort((left, right) =>
      right.attributedCpuMs - left.attributedCpuMs ||
      compareProfileStrings(left.identity, right.identity));

    let probeCaches;
    if (this.probeCacheRecords > 0) {
      const probeTotals = { hits: 0, misses: 0 };
      const rows = [...this.probeCacheStages.values()].map((source) => {
        probeTotals.hits += source.hits;
        probeTotals.misses += source.misses;
        return { stage: source.stage, ...cacheCounts(source) };
      }).sort((left, right) =>
        right.requests - left.requests ||
        compareProfileStrings(left.stage, right.stage));
      const modules = [...this.persistentProbeModules.values()]
        .map((source) => ({
          moduleName: source.moduleName,
          ...cacheCounts(source)
        })).sort((left, right) =>
          right.requests - left.requests ||
          compareProfileStrings(left.moduleName, right.moduleName));
      probeCaches = {
        rows,
        totals: cacheCounts(probeTotals),
        persistentSuccess: {
          totals: cacheCounts(probeTotals),
          ...(modules.length === 0 ? {} : { modules })
        }
      };
    }

    let probeTraces;
    if (this.semanticProbeRecords > 0 || this.executionProbeRecords > 0) {
      const repetitionRows = [...this.logicalProbeRepetitions]
        .map(([repeated, source]) => ({
          repeated,
          ...logicalCounts(source)
        })).sort((left, right) => Number(left.repeated) - Number(right.repeated));
      probeTraces = {
        logical: {
          totals: logicalCounts(this.logicalProbes),
          outcomes: logicalRows(this.logicalProbeOutcomes, "outcome"),
          tiers: logicalRows(this.logicalProbeTiers, "cacheTier"),
          repetitions: repetitionRows,
          publications: logicalRows(
            this.logicalProbePublications, "publication"),
          modules: logicalRows(this.logicalProbeModules, "moduleName"),
          headerContexts: logicalHeaderContextRows(
            this.logicalProbeHeaderContexts, this.probeHeaderLabels)
        },
        physical: {
          totals: physicalCounts(this.physicalProbes),
          outcomes: physicalRows(this.physicalProbeOutcomes, "outcome"),
          batchKinds: physicalRows(
            this.physicalProbeBatchKinds, "batchKind"),
          persistentLookups: physicalRows(
            this.physicalProbeLookups, "persistentLookup"),
          publications: physicalRows(
            this.physicalProbePublications, "publication"),
          modules: physicalRows(this.physicalProbeModules, "moduleName"),
          headerContexts: physicalHeaderContextRows(
            this.physicalProbeHeaderContexts, this.probeHeaderLabels)
        }
      };
    }

    for (const totals of [moduleTotals, headerTotals]) {
      for (const [field, value] of Object.entries(totals)) {
        if (field !== "calls" && field !== "componentPhases") {
          totals[field] = roundMilliseconds(value);
        }
      }
    }
    return {
      modules,
      headers,
      ...(probeCaches === undefined ? {} : { probeCaches }),
      ...(probeTraces === undefined ? {} : { probeTraces }),
      totals: {
        modules: moduleTotals,
        headers: headerTotals,
        attributedCpuMs: roundMilliseconds(
          moduleTotals.attributedCpuMs + headerTotals.attributedCpuMs)
      }
    };
  }
}

function aggregateColdProfile(records) {
  const accumulator = new ColdProfileAccumulator();
  for (const record of records) accumulator.ingest(record);
  return accumulator.finish();
}

function usage() {
  return [
    "usage: node scripts/benchmark-server.mjs [options]",
    "",
    "options:",
    "  --server PATH       native server (default: bin/titan-language-server)",
    "  --root PATH         vscode-titan workspace (default: repository root)",
    `  --file PATH         saved Titan target (default: ${BENCHMARK_FILE})`,
    "  --marker TEXT       unique source text containing the target symbol",
    "  --symbol TEXT       target symbol within --marker",
    "  --probe SPEC        ready-state hover/definition probe",
    "                      SPEC is OP:FILE:LINE:CHAR; may be repeated",
    "  --log-level LEVEL   server log emission (default: debug, like VS Code)",
    `  --timeout-ms N      indexing/message timeout (default: ${DEFAULT_TIMEOUT_MS})`,
    "  --help              show this help"
  ].join("\n");
}

function parseArguments(argv) {
  const options = {
    root: REPOSITORY_ROOT,
    server: undefined,
    file: BENCHMARK_FILE,
    marker: BENCHMARK_MARKER,
    symbol: BENCHMARK_SYMBOL,
    probes: [],
    logLevel: "debug",
    timeoutMs: DEFAULT_TIMEOUT_MS
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (argument === "--probe") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new BenchmarkError("--probe requires a value");
      }
      options.probes.push(value);
      index += 1;
      continue;
    }
    if (argument === "--server" || argument === "--root" ||
        argument === "--file" || argument === "--marker" ||
        argument === "--symbol" ||
        argument === "--log-level" ||
        argument === "--timeout-ms") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new BenchmarkError(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--server") {
        options.server = value;
      } else if (argument === "--root") {
        options.root = path.resolve(value);
      } else if (argument === "--file") {
        options.file = value;
      } else if (argument === "--marker") {
        options.marker = value;
      } else if (argument === "--symbol") {
        options.symbol = value;
      } else if (argument === "--log-level") {
        if (!LOG_LEVELS.has(value)) {
          throw new BenchmarkError(
            "--log-level must be off, error, info, debug, or trace"
          );
        }
        options.logLevel = value;
      } else {
        const timeoutMs = Number(value);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
          throw new BenchmarkError("--timeout-ms must be a positive integer");
        }
        options.timeoutMs = timeoutMs;
      }
      continue;
    }
    throw new BenchmarkError(`unknown argument: ${argument}`);
  }

  options.root = path.resolve(options.root);
  options.server = path.resolve(
    options.server ?? path.join(options.root, "bin", "titan-language-server")
  );
  if (options.file.length === 0 || options.marker.length === 0 ||
      options.symbol.length === 0) {
    throw new BenchmarkError("--file, --marker, and --symbol must not be empty");
  }
  if (options.marker.indexOf(options.symbol) < 0 ||
      options.marker.indexOf(options.symbol) !==
        options.marker.lastIndexOf(options.symbol)) {
    throw new BenchmarkError(
      "--marker must contain --symbol exactly once"
    );
  }
  return options;
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body
  ]);
}

function withTimeout(promise, description, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new BenchmarkError(`timed out waiting for ${description}`)),
      timeoutMs
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class FrameReader {
  constructor(stream, timeoutMs) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.timeoutMs = timeoutMs;
    this.buffer = Buffer.alloc(0);
  }

  async read(description) {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd >= 0) {
        const header = this.buffer.subarray(0, headerEnd).toString("ascii");
        const headers = new Map();
        for (const line of header.split("\r\n")) {
          const separator = line.indexOf(":");
          if (separator <= 0) {
            throw new BenchmarkError(`malformed LSP response header: ${line}`);
          }
          const name = line.slice(0, separator).trim().toLowerCase();
          const value = line.slice(separator + 1).trim();
          if (headers.has(name)) {
            throw new BenchmarkError(`duplicate LSP response header: ${name}`);
          }
          headers.set(name, value);
        }
        const rawLength = headers.get("content-length");
        if (rawLength === undefined || !/^[0-9]+$/.test(rawLength)) {
          throw new BenchmarkError("LSP response omitted a valid Content-Length");
        }
        const length = Number(rawLength);
        if (!Number.isSafeInteger(length) || length > MAX_FRAME_BYTES) {
          throw new BenchmarkError(`invalid LSP response length: ${rawLength}`);
        }
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + length;
        if (this.buffer.length >= bodyEnd) {
          const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
          this.buffer = this.buffer.subarray(bodyEnd);
          let message;
          try {
            message = JSON.parse(body);
          } catch (cause) {
            throw new BenchmarkError(`invalid JSON-RPC response: ${cause.message}`);
          }
          if (typeof message !== "object" || message === null ||
              Array.isArray(message) || message.jsonrpc !== "2.0") {
            throw new BenchmarkError("server emitted an invalid JSON-RPC envelope");
          }
          return message;
        }
      } else if (this.buffer.length > MAX_FRAME_BYTES) {
        throw new BenchmarkError("LSP response header exceeded the frame limit");
      }

      const next = await withTimeout(
        this.iterator.next(),
        description,
        this.timeoutMs
      );
      if (next.done) {
        throw new BenchmarkError(
          `server stdout closed with ${this.buffer.length} pending bytes`
        );
      }
      this.buffer = Buffer.concat([this.buffer, next.value]);
    }
  }
}

class ProtocolClient {
  constructor(child, timeoutMs) {
    this.child = child;
    this.reader = new FrameReader(child.stdout, timeoutMs);
    this.timeoutMs = timeoutMs;
    this.responses = new Map();
    this.statuses = [];
    this.inputError = undefined;
    // EPIPE is reported asynchronously when the server exits. Retain it for a
    // useful synchronous failure on the next write instead of letting Node
    // treat it as an unhandled stream error.
    child.stdin.on("error", (cause) => { this.inputError = cause; });
  }

  write(payload) {
    if (this.inputError !== undefined) {
      throw new BenchmarkError(
        `cannot write to server stdin: ${this.inputError.message}`
      );
    }
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new BenchmarkError(
        "server stdin closed before the benchmark completed"
      );
    }
    try {
      // Node retains the complete Buffer in order if this reports
      // backpressure. These bounded messages are intentionally not split.
      this.child.stdin.write(payload);
    } catch (cause) {
      throw new BenchmarkError(`cannot write to server stdin: ${cause.message}`);
    }
  }

  send(message) {
    this.write(frame(message));
  }

  sendTogether(messages) {
    this.write(Buffer.concat(messages.map(frame)));
  }

  async pumpUntil(predicate, description) {
    while (!predicate()) {
      const message = await this.reader.read(description);
      this.ingest(message, performance.now());
    }
  }

  async response(id, description) {
    await this.pumpUntil(() => this.responses.has(id), description);
    const response = this.responses.get(id);
    this.responses.delete(id);
    if (response.message.error !== undefined) {
      const error = response.message.error;
      const detail = typeof error?.message === "string"
        ? error.message
        : JSON.stringify(error);
      throw new BenchmarkError(`${description} failed: ${detail}`);
    }
    if (!("result" in response.message)) {
      throw new BenchmarkError(`${description} omitted its result`);
    }
    return {
      result: response.message.result,
      receivedAt: response.receivedAt
    };
  }

  ingest(message, receivedAt) {
    if (message.id !== undefined) {
      if (message.method !== undefined) {
        throw new BenchmarkError("benchmark client does not accept server requests");
      }
      if (this.responses.has(message.id)) {
        throw new BenchmarkError(`duplicate JSON-RPC response id: ${message.id}`);
      }
      this.responses.set(message.id, { message, receivedAt });
      return;
    }

    if (typeof message.method !== "string") {
      throw new BenchmarkError("server emitted an id-less non-notification");
    }
    if (message.method === INDEXING_STATUS_METHOD) {
      this.statuses.push(validateIndexingStatus(message.params, receivedAt));
    }
  }
}

function validateIndexingStatus(value, receivedAt) {
  const hasCompletedFiles = value?.completed_files !== undefined;
  const hasTotalFiles = value?.total_files !== undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      !["indexing", "ready", "failed"].includes(value.state) ||
      typeof value.initial !== "boolean" ||
      !Number.isSafeInteger(value.epoch) || value.epoch < 0 ||
      (value.generation !== undefined &&
       (!Number.isSafeInteger(value.generation) || value.generation < 0)) ||
      (value.message !== undefined && typeof value.message !== "string") ||
      hasCompletedFiles !== hasTotalFiles ||
      (hasCompletedFiles &&
       (value.state !== "indexing" ||
        !Number.isSafeInteger(value.completed_files) ||
        value.completed_files < 0 ||
        !Number.isSafeInteger(value.total_files) ||
        value.total_files < 0 ||
        value.completed_files > value.total_files))) {
    throw new BenchmarkError(`invalid ${INDEXING_STATUS_METHOD} notification`);
  }
  return {
    state: value.state,
    initial: value.initial,
    epoch: value.epoch,
    generation: value.generation,
    message: value.message,
    completedFiles: value.completed_files,
    totalFiles: value.total_files,
    receivedAt
  };
}

function responseAt(client, id) {
  return client.responses.get(id);
}

function indexingCycleAfter(client, startIndex, initial, subject) {
  const statuses = client.statuses.slice(startIndex);
  if (statuses.length === 0) return undefined;
  const indexing = statuses[0];
  if (indexing.state !== "indexing" || indexing.initial !== initial) {
    throw new BenchmarkError(`${subject} did not begin with its busy status`);
  }
  let terminal;
  const progress = [];
  for (let index = 0; index < statuses.length; index += 1) {
    const status = statuses[index];
    if (status.state === "indexing") {
      if (terminal !== undefined || status.initial !== indexing.initial ||
          status.epoch < indexing.epoch) {
        throw new BenchmarkError(`${subject} emitted an invalid status sequence`);
      }
      progress.push(status);
    } else {
      if (terminal !== undefined || status.initial !== indexing.initial ||
          status.epoch < indexing.epoch) {
        throw new BenchmarkError(`${subject} emitted an invalid status sequence`);
      }
      terminal = status;
    }
  }
  if (terminal === undefined) return undefined;
  if (terminal.state === "failed") {
    throw new BenchmarkError(
      `${subject} failed${terminal.message ? `: ${terminal.message}` : ""}`
    );
  }
  if (!Number.isSafeInteger(terminal.generation)) {
    throw new BenchmarkError(`${subject} ready status omitted its generation`);
  }
  return { indexing, progress, ready: terminal };
}

function progressSummary(cycle) {
  const updates = cycle.progress.filter(
    (status) => status.completedFiles !== undefined
  );
  const latest = updates.at(-1);
  return {
    updates: updates.length,
    completedFiles: latest?.completedFiles,
    totalFiles: latest?.totalFiles
  };
}

async function validateInputs(options) {
  const serverInfo = await stat(options.server).catch(() => undefined);
  if (serverInfo === undefined || !serverInfo.isFile()) {
    throw new BenchmarkError(`native server does not exist: ${options.server}`);
  }
  await access(options.server, fsConstants.X_OK).catch(() => {
    throw new BenchmarkError(`native server is not executable: ${options.server}`);
  });
  const canonicalRoot = await realpath(options.root).catch(() => undefined);
  const rootInfo = canonicalRoot === undefined
    ? undefined
    : await stat(canonicalRoot).catch(() => undefined);
  if (rootInfo === undefined || !rootInfo.isDirectory()) {
    throw new BenchmarkError(`workspace root is not a directory: ${options.root}`);
  }
  options.root = canonicalRoot;
}

async function benchmarkTarget(options) {
  const { filename, relativeFile } = await canonicalTargetInsideRoot(
    options.root, options.file, "--file");
  const source = await readFile(filename, "utf8").catch((cause) => {
    throw new BenchmarkError(`cannot read benchmark target ${filename}: ${cause.message}`);
  });
  const markerOffset = source.indexOf(options.marker);
  if (markerOffset < 0 || source.indexOf(options.marker, markerOffset + 1) >= 0) {
    throw new BenchmarkError(
      `${relativeFile} must contain exactly one ${JSON.stringify(options.marker)}`
    );
  }
  const symbolOffset = markerOffset + options.marker.indexOf(options.symbol);
  const preceding = source.slice(0, symbolOffset);
  const newline = preceding.lastIndexOf("\n");
  return {
    filename,
    relativeFile,
    uri: pathToFileURL(filename).href,
    symbol: options.symbol,
    position: {
      line: preceding.split("\n").length - 1,
      // JavaScript string length is exactly the UTF-16 code-unit count LSP uses.
      character: preceding.slice(newline + 1).length
    }
  };
}

function pathInsideRoot(root, filename, subject) {
  const relativeFile = path.relative(root, filename);
  if (relativeFile === "" || relativeFile === ".." ||
      relativeFile.startsWith(`..${path.sep}`) || path.isAbsolute(relativeFile)) {
    throw new BenchmarkError(`${subject} must identify a file inside --root`);
  }
  return relativeFile;
}

async function canonicalTargetInsideRoot(root, configuredPath, subject) {
  const filename = path.resolve(root, configuredPath);
  pathInsideRoot(root, filename, subject);
  const canonicalFilename = await realpath(filename).catch((cause) => {
    throw new BenchmarkError(
      `cannot resolve ${subject} target ${filename}: ${cause.message}`
    );
  });
  if (path.relative(filename, canonicalFilename) !== "") {
    throw new BenchmarkError(`${subject} target must not traverse symlinks`);
  }
  const relativeFile = pathInsideRoot(root, canonicalFilename, subject);
  const info = await stat(canonicalFilename).catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    throw new BenchmarkError(`${subject} target is not a file: ${canonicalFilename}`);
  }
  return { filename: canonicalFilename, relativeFile };
}

async function benchmarkProbes(options) {
  const result = [];
  for (let index = 0; index < options.probes.length; index += 1) {
    const spec = options.probes[index];
    const match = /^(hover|definition):(.*):([0-9]+):([0-9]+)$/.exec(spec);
    if (match === null || match[2].length === 0) {
      throw new BenchmarkError(
        `invalid --probe ${JSON.stringify(spec)}; expected OP:FILE:LINE:CHAR`
      );
    }
    const line = Number(match[3]);
    const character = Number(match[4]);
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(character)) {
      throw new BenchmarkError(`invalid --probe position: ${spec}`);
    }
    const { filename, relativeFile } = await canonicalTargetInsideRoot(
      options.root, match[2], "--probe FILE");
    result.push({
      operation: match[1],
      filename,
      relativeFile,
      uri: pathToFileURL(filename).href,
      position: { line, character }
    });
  }
  return result;
}

function clockTicksPerSecond() {
  if (process.platform !== "linux") return undefined;
  const result = spawnSync("getconf", ["CLK_TCK"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  const ticks = Number(result.stdout?.trim());
  if (result.status !== 0 || !Number.isFinite(ticks) || ticks <= 0) {
    throw new BenchmarkError("cannot determine Linux process clock tick rate");
  }
  return ticks;
}

async function processSample(pid, ticksPerSecond) {
  if (process.platform !== "linux" || ticksPerSecond === undefined) {
    return { cpuMs: undefined, peakRssKiB: undefined };
  }
  const [rawStat, status] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8"),
    readFile(`/proc/${pid}/status`, "utf8")
  ]).catch((cause) => {
    throw new BenchmarkError(`cannot sample server process ${pid}: ${cause.message}`);
  });
  const commandEnd = rawStat.lastIndexOf(")");
  if (commandEnd < 0) {
    throw new BenchmarkError("malformed Linux process stat record");
  }
  const fields = rawStat.slice(commandEnd + 1).trim().split(/\s+/);
  const userTicks = Number(fields[11]);
  const systemTicks = Number(fields[12]);
  const rssMatch = /^VmHWM:\s+([0-9]+)\s+kB$/m.exec(status);
  if (!Number.isFinite(userTicks) || !Number.isFinite(systemTicks) ||
      rssMatch === null) {
    throw new BenchmarkError("Linux process resource record is incomplete");
  }
  return {
    cpuMs: (userTicks + systemTicks) * 1000 / ticksPerSecond,
    peakRssKiB: Number(rssMatch[1])
  };
}

function createProcessOutcome(child) {
  return new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function collectStderr(stream, maximumBytes = 64 * 1024) {
  let contents = Buffer.alloc(0);
  const decoder = new StringDecoder("utf8");
  const profile = new ColdProfileAccumulator();
  let pendingLine = "";
  let discardingOversizedLine = false;
  let profileError;

  function ingestLine(line) {
    if (line.length > MAX_PROFILE_LINE_CHARACTERS) {
      if (profileError === undefined &&
          line.startsWith(STRUCTURED_LOG_PREFIX)) {
        profileError = new BenchmarkError(
          `structured server log line exceeded ${MAX_PROFILE_LINE_CHARACTERS} characters`
        );
      }
      return;
    }
    if (profileError !== undefined ||
        !line.startsWith(STRUCTURED_LOG_PREFIX)) return;
    try {
      const record = JSON.parse(line.slice(STRUCTURED_LOG_PREFIX.length));
      profile.ingest(record);
    } catch (cause) {
      profileError = cause instanceof BenchmarkError
        ? cause
        : new BenchmarkError(
          `invalid structured server log record: ${cause.message}`);
    }
  }

  function ingestText(text, final = false) {
    let offset = 0;
    while (offset < text.length) {
      if (discardingOversizedLine) {
        const newline = text.indexOf("\n", offset);
        if (newline < 0) return;
        discardingOversizedLine = false;
        offset = newline + 1;
        continue;
      }
      const newline = text.indexOf("\n", offset);
      if (newline < 0) {
        pendingLine += text.slice(offset);
        if (pendingLine.length > MAX_PROFILE_LINE_CHARACTERS) {
          ingestLine(pendingLine);
          pendingLine = "";
          discardingOversizedLine = true;
        }
        break;
      }
      let line = pendingLine + text.slice(offset, newline);
      pendingLine = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      ingestLine(line);
      offset = newline + 1;
    }
    if (final && !discardingOversizedLine && pendingLine.length > 0) {
      ingestLine(pendingLine);
      pendingLine = "";
    }
  }

  stream.on("data", (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    contents = Buffer.concat([contents, buffer]);
    if (contents.length > maximumBytes) {
      contents = contents.subarray(contents.length - maximumBytes);
    }
    ingestText(decoder.write(buffer));
  });
  stream.once("end", () => ingestText(decoder.end(), true));
  return {
    tail: () => contents.toString("utf8").trim(),
    coldProfile: () => {
      if (profileError !== undefined) throw profileError;
      return profile.finish();
    }
  };
}

async function startServer(options) {
  const environment = { ...process.env };
  if (environment.TITAN_LS_LUA_PATH === undefined ||
      environment.TITAN_LS_LUA_CPATH === undefined ||
      environment.TITAN_ROOT === undefined) {
    // Benchmarks reserve TITAN_PREFIX for their probe cache, independently of
    // the installed compiler selected by TITAN_ROOT or PATH discovery. The
    // server needs TITAN_ROOT even when the Lua paths are explicit: header and
    // Lua-source lookup comes from the installation root, not from a Lua path.
    const prefix = resolveTitanSdk({ prefix: environment.TITAN_ROOT,
      environment: compilerDiscoveryEnvironment(environment) });
    const luaRoot = path.join(prefix, "share", "lua", "5.5");
    environment.TITAN_ROOT ??= prefix;
    environment.TITAN_LS_LUA_PATH ??= [
      path.join(luaRoot, "?.lua"), path.join(luaRoot, "?", "init.lua")
    ].join(";");
    environment.TITAN_LS_LUA_CPATH ??= path.join(prefix, "lib", "lua", "5.5",
      process.platform === "win32" ? "?.dll" : "?.so");
  }
  environment.TITAN_LANGUAGE_SERVER_LOG_LEVEL = options.logLevel;
  const child = spawn(options.server, [], {
    cwd: options.root,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const spawned = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (cause) => reject(
      new BenchmarkError(`cannot launch native server: ${cause.message}`)
    ));
  });
  await withTimeout(spawned, "native server startup", options.timeoutMs);
  return child;
}

async function terminateOwnedChild(child, outcome) {
  if (child.exitCode !== null || child.signalCode !== null) {
    await outcome;
    return;
  }
  child.stdin.destroy();
  child.kill("SIGTERM");
  try {
    await withTimeout(outcome, "owned server termination", TERMINATION_GRACE_MS);
    return;
  } catch {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  await withTimeout(outcome, "owned server exit after SIGKILL", TERMINATION_GRACE_MS);
}

function roundMilliseconds(value) {
  return Math.round(value * 1000) / 1000;
}

function definitionSummary(result, target) {
  const location = Array.isArray(result) ? result[0] : result;
  const start = location?.range?.start;
  const found = typeof location?.uri === "string" &&
    Number.isSafeInteger(start?.line) &&
    Number.isSafeInteger(start?.character);
  return {
    found,
    sameFile: found && location.uri === target.uri,
    line: Number.isSafeInteger(start?.line) ? start.line : undefined,
    character: Number.isSafeInteger(start?.character)
      ? start.character
      : undefined
  };
}

async function benchmark(options) {
  await validateInputs(options);
  const target = await benchmarkTarget(options);
  const probes = await benchmarkProbes(options);
  const ticksPerSecond = clockTicksPerSecond();
  const startupStartedAt = performance.now();
  const child = await startServer(options);
  const outcome = createProcessOutcome(child);
  const stderr = collectStderr(child.stderr);
  const client = new ProtocolClient(child, options.timeoutMs);
  let exitedCleanly = false;

  try {
    client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        processId: process.pid,
        clientInfo: { name: "vscode-titan-benchmark", version: "1" },
        rootPath: options.root,
        rootUri: pathToFileURL(options.root).href,
        capabilities: { general: { positionEncodings: ["utf-16"] } },
        workspaceFolders: [{
          uri: pathToFileURL(options.root).href,
          name: path.basename(options.root)
        }]
      }
    });
    const initialize = await client.response(1, "initialize response");
    if (initialize.result?.capabilities?.positionEncoding !== "utf-16") {
      throw new BenchmarkError("server did not negotiate UTF-16 positions");
    }

    const coldStartResources = await processSample(child.pid, ticksPerSecond);
    const coldSentAt = performance.now();
    const initialStatusStart = client.statuses.length;
    client.send({ jsonrpc: "2.0", method: "initialized", params: {} });
    await client.pumpUntil(() => {
      const status = client.statuses[initialStatusStart];
      return status !== undefined;
    }, "cold indexing busy status");
    const observedInitial = client.statuses[initialStatusStart];
    if (observedInitial.state !== "indexing" || !observedInitial.initial) {
      throw new BenchmarkError("cold indexing did not begin with its busy status");
    }

    const immediateHoverSentAt = performance.now();
    client.send({
      jsonrpc: "2.0",
      id: 2,
      method: "textDocument/hover",
      params: {
        textDocument: { uri: target.uri },
        position: target.position
      }
    });

    await client.pumpUntil(() => {
      const cycle = indexingCycleAfter(
        client, initialStatusStart, true, "cold indexing"
      );
      return responseAt(client, 2) !== undefined &&
        cycle !== undefined;
    }, "cold indexing and immediate hover");
    const immediateHover = await client.response(2, "immediate hover response");
    const initialCycle = indexingCycleAfter(
      client, initialStatusStart, true, "cold indexing"
    );
    if (initialCycle === undefined) {
      throw new BenchmarkError("cold indexing omitted its terminal status");
    }
    const initialIndexing = initialCycle.indexing;
    const initialReady = initialCycle.ready;
    const coldEndResources = await processSample(child.pid, ticksPerSecond);
    if (immediateHover.result !== null) {
      throw new BenchmarkError(
        "immediate hover unexpectedly returned data during initial indexing"
      );
    }
    if (immediateHoverSentAt < initialIndexing.receivedAt) {
      throw new BenchmarkError(
        "immediate hover was sent before the busy status was observed"
      );
    }
    if (immediateHover.receivedAt < initialIndexing.receivedAt ||
        immediateHover.receivedAt >= initialReady.receivedAt) {
      throw new BenchmarkError(
        "immediate hover did not complete within the observed indexing interval"
      );
    }
    if (initialReady.epoch !== initialIndexing.epoch) {
      throw new BenchmarkError(
        "workspace changed while measuring cold indexing"
      );
    }

    const queryStatusStart = client.statuses.length;
    const queryStartResources = await processSample(child.pid, ticksPerSecond);
    const readyQueriesSentAt = performance.now();
    const readyMessages = [
      {
        jsonrpc: "2.0",
        id: 3,
        method: "textDocument/hover",
        params: {
          textDocument: { uri: target.uri },
          position: target.position
        }
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "textDocument/definition",
        params: {
          textDocument: { uri: target.uri },
          position: target.position
        }
      }
    ];
    for (let index = 0; index < probes.length; index += 1) {
      const probe = probes[index];
      readyMessages.push({
        jsonrpc: "2.0",
        id: 10 + index,
        method: `textDocument/${probe.operation}`,
        params: {
          textDocument: { uri: probe.uri },
          position: probe.position
        }
      });
    }
    client.sendTogether(readyMessages);

    await client.pumpUntil(() =>
      responseAt(client, 3) !== undefined &&
        responseAt(client, 4) !== undefined &&
        probes.every((_, index) =>
          responseAt(client, 10 + index) !== undefined),
    "ready queries without refresh");
    const readyHover = await client.response(3, "ready hover response");
    const definition = await client.response(4, "target definition response");
    if (readyHover.result === null) {
      throw new BenchmarkError("ready hover returned no data at the benchmark target");
    }
    const summarizedDefinition = definitionSummary(definition.result, target);
    if (!summarizedDefinition.found) {
      throw new BenchmarkError(
        "target definition returned no location at the benchmark target"
      );
    }
    const probeSummaries = [];
    const queryResponses = [readyHover, definition];
    for (let index = 0; index < probes.length; index += 1) {
      const probe = probes[index];
      const response = await client.response(
        10 + index, `${probe.operation} probe response`);
      if (response.result === null) {
        throw new BenchmarkError(
          `${probe.operation} probe returned no data for ${probe.relativeFile}`
        );
      }
      const summary = {
        operation: probe.operation,
        file: probe.relativeFile,
        position: probe.position,
        latencyMs: roundMilliseconds(
          response.receivedAt - readyQueriesSentAt),
        hasResult: true
      };
      if (probe.operation === "definition") {
        const summarizedProbeDefinition = definitionSummary(
          response.result, probe);
        if (!summarizedProbeDefinition.found) {
          throw new BenchmarkError(
            `definition probe returned no location for ${probe.relativeFile}`
          );
        }
        Object.assign(summary, summarizedProbeDefinition);
      }
      probeSummaries.push(summary);
      queryResponses.push(response);
    }
    const readyQueriesCompletedAt = Math.max(
      ...queryResponses.map((response) => response.receivedAt)
    );
    const queryEndResources = await processSample(child.pid, ticksPerSecond);

    client.send({
      jsonrpc: "2.0",
      id: 5,
      method: "shutdown",
      params: null
    });
    await withTimeout(
      client.response(5, "shutdown response"),
      "shutdown response",
      SHUTDOWN_TIMEOUT_MS
    );
    // The shutdown reply is an ordering barrier: the server has handled and
    // joined every preceding semantic request, and the client has ingested all
    // notifications that preceded that reply. Freeze one count for both the
    // assertion and the report so a late busy notification cannot evade one
    // while appearing in the other.
    const queryIndexingStatuses = client.statuses.length - queryStatusStart;
    client.send({ jsonrpc: "2.0", method: "exit" });
    child.stdin.end();
    const exit = await withTimeout(
      outcome,
      "clean server exit",
      SHUTDOWN_TIMEOUT_MS
    );
    exitedCleanly = exit.code === 0 && exit.signal === null;
    if (!exitedCleanly) {
      throw new BenchmarkError(
        `server exited with code ${exit.code} and signal ${exit.signal}`
      );
    }
    if (queryIndexingStatuses !== 0) {
      throw new BenchmarkError(
        "unchanged semantic queries unexpectedly started indexing"
      );
    }
    const coldProfile = stderr.coldProfile();

    const cpuDelta = coldEndResources.cpuMs === undefined ||
      coldStartResources.cpuMs === undefined
      ? undefined
      : coldEndResources.cpuMs - coldStartResources.cpuMs;
    const queryCpuDelta = queryEndResources.cpuMs === undefined ||
      queryStartResources.cpuMs === undefined
      ? undefined
      : queryEndResources.cpuMs - queryStartResources.cpuMs;
    return {
      server: options.server,
      workspace: options.root,
      logLevel: options.logLevel,
      target: {
        file: target.relativeFile,
        symbol: target.symbol,
        position: target.position
      },
      startup: {
        wallMs: roundMilliseconds(initialize.receivedAt - startupStartedAt),
        childCpuMs: coldStartResources.cpuMs === undefined
          ? undefined
          : roundMilliseconds(coldStartResources.cpuMs),
        peakRssKiB: coldStartResources.peakRssKiB
      },
      coldIndex: {
        wallMs: roundMilliseconds(initialReady.receivedAt - coldSentAt),
        childCpuMs: cpuDelta === undefined
          ? undefined
          : roundMilliseconds(cpuDelta),
        peakRssKiB: coldEndResources.peakRssKiB,
        epoch: initialReady.epoch,
        generation: initialReady.generation,
        progress: progressSummary(initialCycle)
      },
      immediateHover: {
        latencyMs: roundMilliseconds(
          immediateHover.receivedAt - immediateHoverSentAt
        ),
        completedBeforeReady: immediateHover.receivedAt < initialReady.receivedAt,
        returnedNoData: immediateHover.result === null
      },
      readyHover: {
        latencyMs: roundMilliseconds(readyHover.receivedAt - readyQueriesSentAt),
        hasResult: readyHover.result !== null
      },
      targetDefinition: {
        latencyMs: roundMilliseconds(definition.receivedAt - readyQueriesSentAt),
        ...summarizedDefinition
      },
      probes: probeSummaries,
      unchangedRequests: {
        wallMs: roundMilliseconds(
          readyQueriesCompletedAt - readyQueriesSentAt),
        childCpuMs: queryCpuDelta === undefined
          ? undefined
          : roundMilliseconds(queryCpuDelta),
        indexingStatuses: queryIndexingStatuses,
        generation: initialReady.generation
      },
      ...(coldProfile === undefined ? {} : { coldProfile })
    };
  } catch (cause) {
    const diagnostics = stderr.tail();
    if (diagnostics.length > 0 && cause instanceof Error) {
      cause.message = `${cause.message}; server stderr: ${diagnostics}`;
    }
    throw cause;
  } finally {
    if (!exitedCleanly) {
      await terminateOwnedChild(child, outcome).catch(() => undefined);
    }
  }
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await benchmark(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export { aggregateColdProfile, collectStderr };
