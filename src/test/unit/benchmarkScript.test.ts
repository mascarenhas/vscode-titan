import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(__dirname, "../../../..");
const benchmarkScript = path.join(
  repositoryRoot, "scripts", "benchmark-server.mjs");
const temporaryDirectories: string[] = [];

interface ProfilePhase {
  phase: string;
  calls: number;
  cpuMs: number;
}

interface FirstReuseMetrics {
  firstCallCpuMs: number;
  reuseTotalCpuMs: number;
  reuseCalls: number;
  reuseAverageCpuMs: number;
  reuseMaxCpuMs: number;
}

interface ModuleProfileRow extends FirstReuseMetrics {
  moduleName: string;
  filename: string;
  calls: number;
  selfCpuMs: number;
  parseCpuMs: number;
  checkCpuMs: number;
  otherCpuMs: number;
  inclusiveCpuMs: number;
  normalizationCpuMs: number;
  attributedCpuMs: number;
}

interface HeaderProfileRow extends FirstReuseMetrics {
  identity: string;
  header: string;
  resolvedHeader: string;
  calls: number;
  processCpuMs: number;
  downstreamConversionCpuMs: number;
  attributedCpuMs: number;
  componentPhases: ProfilePhase[];
}

interface CacheCounts {
  hits: number;
  misses: number;
  requests: number;
  hitRate: number;
}

interface ProbeCacheProfile {
  rows: Array<CacheCounts & { stage: string }>;
  totals: CacheCounts;
  persistentSuccess: {
    totals: CacheCounts;
    modules?: Array<CacheCounts & { moduleName: string }>;
  };
}

interface LogicalProbeCounts {
  requests: number;
  uniqueKeys: number;
  repeatedRequests: number;
}

interface PhysicalProbeCounts {
  attempts: number;
  launches: number;
  measuredLaunches: number;
  childWallMs: number;
}

interface ProbeTraceProfile {
  logical: {
    totals: LogicalProbeCounts;
    outcomes: Array<LogicalProbeCounts & { outcome: string }>;
    tiers: Array<LogicalProbeCounts & { cacheTier: string }>;
    repetitions: Array<LogicalProbeCounts & { repeated: boolean }>;
    publications: Array<LogicalProbeCounts & { publication: string }>;
    modules: Array<LogicalProbeCounts & { moduleName: string }>;
    headerContexts: Array<LogicalProbeCounts & {
      headerIdentity: string;
      headerLabel: string;
    }>;
  };
  physical: {
    totals: PhysicalProbeCounts;
    outcomes: Array<PhysicalProbeCounts & { outcome: string }>;
    batchKinds: Array<PhysicalProbeCounts & { batchKind: string }>;
    persistentLookups: Array<PhysicalProbeCounts & {
      persistentLookup: string;
    }>;
    publications: Array<PhysicalProbeCounts & { publication: string }>;
    modules: Array<PhysicalProbeCounts & { moduleName: string }>;
    headerContexts: Array<PhysicalProbeCounts & {
      headerIdentity: string;
      headerLabel: string;
    }>;
  };
}

interface ColdProfile {
  modules: ModuleProfileRow[];
  headers: HeaderProfileRow[];
  probeCaches?: ProbeCacheProfile;
  probeTraces?: ProbeTraceProfile;
  totals: {
    modules: Omit<ModuleProfileRow,
      "moduleName" | "filename" | "inclusiveCpuMs" |
      keyof FirstReuseMetrics>;
    headers: Omit<HeaderProfileRow,
      "identity" | "header" | "resolvedHeader" |
      keyof FirstReuseMetrics>;
    attributedCpuMs: number;
  };
}

type AggregateColdProfile = (
  records: Array<Record<string, unknown>>
) => ColdProfile | undefined;

interface StderrCollection {
  tail: () => string;
  coldProfile: () => ColdProfile | undefined;
}

type CollectStderr = (
  stream: PassThrough,
  maximumBytes?: number
) => StderrCollection;

interface BenchmarkExports {
  aggregateColdProfile: AggregateColdProfile;
  collectStderr: CollectStderr;
}

let benchmarkExportsPromise: Promise<BenchmarkExports> | undefined;

async function benchmarkExports(): Promise<BenchmarkExports> {
  benchmarkExportsPromise ??= import(pathToFileURL(benchmarkScript).href)
    .then((module: unknown) => {
      const candidate = module as {
        aggregateColdProfile?: unknown;
        collectStderr?: unknown;
      };
      assert.equal(typeof candidate.aggregateColdProfile, "function");
      assert.equal(typeof candidate.collectStderr, "function");
      return candidate as BenchmarkExports;
    });
  return benchmarkExportsPromise;
}

async function aggregateColdProfile(
  records: Array<Record<string, unknown>>
): Promise<ColdProfile | undefined> {
  return (await benchmarkExports()).aggregateColdProfile(records);
}

function makeSymlinkWorkspace(context: TestContext): { lexicalRoot: string } | undefined {
  const directory = mkdtempSync(path.join(tmpdir(), "vscode-titan-benchmark-"));
  temporaryDirectories.push(directory);
  const physicalRoot = path.join(directory, "physical");
  const lexicalRoot = path.join(directory, "lexical");
  mkdirSync(physicalRoot);
  const target = path.join(physicalRoot, "target.titan");
  const linkedFile = path.join(physicalRoot, "linked.titan");
  writeFileSync(target, "local target = 1\n");
  try {
    symlinkSync(physicalRoot, lexicalRoot, "dir");
    symlinkSync(target, linkedFile, "file");
    realpathSync(lexicalRoot);
    realpathSync(linkedFile);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code ?? "";
    if (process.platform === "win32" && ["EPERM", "EACCES", "UNKNOWN", "ENOSYS"].includes(code)) {
      context.skip("Windows account cannot create or traverse the benchmark fixture symlinks");
      return;
    }
    throw cause;
  }
  return { lexicalRoot };
}

function runValidation(root: string, ...arguments_: string[]) {
  return spawnSync(process.execPath, [
    benchmarkScript,
    "--server", process.execPath,
    "--root", root,
    "--file", "target.titan",
    "--marker", "target",
    "--symbol", "target",
    ...arguments_
  ], {
    encoding: "utf8",
    timeout: 5_000
  });
}

function reportedError(result: ReturnType<typeof runValidation>): string {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stderr.trim()) as { error?: unknown };
  assert.equal(typeof output.error, "string");
  return output.error as string;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("language-server benchmark input validation", () => {
  test("canonicalizes the workspace root and rejects a symlinked target", (context) => {
    const workspace = makeSymlinkWorkspace(context);
    if (!workspace) return;
    const { lexicalRoot } = workspace;

    const result = runValidation(
      lexicalRoot,
      "--file", "linked.titan"
    );

    assert.match(reportedError(result), /--file target must not traverse symlinks/);
  });

  test("rejects a probe that reaches its file through a symlink", (context) => {
    const workspace = makeSymlinkWorkspace(context);
    if (!workspace) return;
    const { lexicalRoot } = workspace;

    const result = runValidation(
      lexicalRoot,
      "--probe", "hover:linked.titan:0:6"
    );

    assert.match(
      reportedError(result),
      /--probe FILE target must not traverse symlinks/
    );
  });
});

describe("language-server cold profile aggregation", () => {
  test("aggregates repeated module records and sorts by attributed CPU", async () => {
    const profile = await aggregateColdProfile([
      {
        event: "compiler.source_module.profile",
        root_module: "project.root",
        module_name: "project.repeated",
        filename: "/project/repeated.titan",
        outcome: "complete",
        self_cpu_ms: 3,
        total_cpu_ms: 12,
        parse_cpu_ms: 1,
        check_cpu_ms: 1.5
      },
      {
        event: "compiler.module.normalization",
        root_module: "project.root",
        module_name: "project.repeated",
        filename: "/project/repeated.titan",
        cpu_ms: 1
      },
      {
        event: "compiler.source_module.profile",
        root_module: "project.root",
        module_name: "project.hot",
        filename: "/project/hot.titan",
        outcome: "complete",
        self_cpu_ms: 8,
        total_cpu_ms: 10,
        parse_cpu_ms: 2,
        check_cpu_ms: 5
      },
      {
        event: "compiler.source_module.profile",
        root_module: "project.root",
        module_name: "project.repeated",
        filename: "/project/repeated.titan",
        outcome: "complete",
        self_cpu_ms: 2,
        total_cpu_ms: 9,
        parse_cpu_ms: 0.5,
        check_cpu_ms: 1
      },
      {
        event: "compiler.module.normalization",
        root_module: "project.root",
        module_name: "project.hot",
        filename: "/project/hot.titan",
        cpu_ms: 1
      },
      {
        event: "compiler.module.normalization",
        root_module: "project.root",
        module_name: "project.repeated",
        filename: "/project/repeated.titan",
        cpu_ms: 0.5
      }
    ]);

    assert.ok(profile);
    assert.deepEqual(profile.modules, [
      {
        moduleName: "project.hot",
        filename: "/project/hot.titan",
        calls: 1,
        selfCpuMs: 8,
        parseCpuMs: 2,
        checkCpuMs: 5,
        otherCpuMs: 1,
        inclusiveCpuMs: 10,
        normalizationCpuMs: 1,
        attributedCpuMs: 9,
        firstCallCpuMs: 9,
        reuseTotalCpuMs: 0,
        reuseCalls: 0,
        reuseAverageCpuMs: 0,
        reuseMaxCpuMs: 0
      },
      {
        moduleName: "project.repeated",
        filename: "/project/repeated.titan",
        calls: 2,
        selfCpuMs: 5,
        parseCpuMs: 1.5,
        checkCpuMs: 2.5,
        otherCpuMs: 1,
        inclusiveCpuMs: 21,
        normalizationCpuMs: 1.5,
        attributedCpuMs: 6.5,
        firstCallCpuMs: 4,
        reuseTotalCpuMs: 2.5,
        reuseCalls: 2,
        reuseAverageCpuMs: 1.25,
        reuseMaxCpuMs: 2
      }
    ]);
    assert.deepEqual(profile.totals.modules, {
      calls: 3,
      selfCpuMs: 13,
      parseCpuMs: 3.5,
      checkCpuMs: 7.5,
      otherCpuMs: 2,
      normalizationCpuMs: 2.5,
      attributedCpuMs: 15.5
    });
    assert.equal(profile.totals.attributedCpuMs, 15.5);
    assert.equal(profile.probeCaches, undefined);
    assert.equal(profile.probeTraces, undefined);
  });

  test("counts header calls from process totals without double-counting components",
  async () => {
    const header = (identity: string, phase: string, cpuMs: number) => ({
      event: "compiler.c_header.phase",
      root_module: "project.root",
      header: `${identity}.h`,
      resolved_header: `/include/${identity}.h`,
      identity: `/stable/${identity}.h`,
      phase,
      outcome: "complete",
      cpu_ms: cpuMs
    });
    const profile = await aggregateColdProfile([
      header("hot", "process_total", 20),
      header("hot", "preprocess", 15),
      header("hot", "parse", 12),
      header("hot", "downstream_ffi_conversion", 4),
      header("hot", "process_total", 5),
      header("hot", "graph_clone", 2),
      header("hot", "downstream_ffi_conversion", 1),
      header("cool", "process_total", 12),
      header("cool", "downstream_ffi_conversion", 3)
    ]);

    assert.ok(profile);
    assert.deepEqual(profile.headers.map((row) => row.identity), [
      "/stable/hot.h",
      "/stable/cool.h"
    ]);
    assert.deepEqual(profile.headers[0], {
      identity: "/stable/hot.h",
      header: "hot.h",
      resolvedHeader: "/include/hot.h",
      calls: 2,
      processCpuMs: 25,
      downstreamConversionCpuMs: 5,
      attributedCpuMs: 30,
      firstCallCpuMs: 24,
      reuseTotalCpuMs: 6,
      reuseCalls: 2,
      reuseAverageCpuMs: 3,
      reuseMaxCpuMs: 5,
      componentPhases: [
        { phase: "preprocess", calls: 1, cpuMs: 15 },
        { phase: "parse", calls: 1, cpuMs: 12 },
        { phase: "graph_clone", calls: 1, cpuMs: 2 }
      ]
    });
    assert.deepEqual(profile.totals.headers, {
      calls: 3,
      processCpuMs: 37,
      downstreamConversionCpuMs: 8,
      attributedCpuMs: 45,
      componentPhases: [
        { phase: "preprocess", calls: 1, cpuMs: 15 },
        { phase: "parse", calls: 1, cpuMs: 12 },
        { phase: "graph_clone", calls: 1, cpuMs: 2 }
      ]
    });
    assert.equal(profile.totals.attributedCpuMs, 45);
    // Component phases are explanatory subsets of process_total, so adding
    // them here would report 74ms instead of the non-overlapping 30ms.
    assert.equal(profile.headers[0].attributedCpuMs, 30);
    assert.deepEqual({
      firstCallCpuMs: profile.headers[1].firstCallCpuMs,
      reuseTotalCpuMs: profile.headers[1].reuseTotalCpuMs,
      reuseCalls: profile.headers[1].reuseCalls,
      reuseAverageCpuMs: profile.headers[1].reuseAverageCpuMs,
      reuseMaxCpuMs: profile.headers[1].reuseMaxCpuMs
    }, {
      firstCallCpuMs: 15,
      reuseTotalCpuMs: 0,
      reuseCalls: 0,
      reuseAverageCpuMs: 0,
      reuseMaxCpuMs: 0
    });
  });

  test("aggregates persistent probe-cache stages and modules", async () => {
    const cache = (
      moduleName: string,
      stage: "baseline" | "candidate",
      hit: boolean,
      rootModule = "project.root"
    ) => ({
      event: "compiler.c_probe.cache",
      root_module: rootModule,
      module_name: moduleName,
      cache: "persistent success",
      stage,
      hit,
      key: `${stage}:${moduleName}:${hit}`,
      path: `/cache/${moduleName}`
    });
    const profile = await aggregateColdProfile([
      cache("project.slow", "baseline", false, "project.one"),
      cache("project.fast", "candidate", true),
      cache("project.slow", "baseline", true, "project.two"),
      cache("project.fast", "candidate", true),
      cache("project.base", "baseline", false),
      cache("project.fast", "candidate", false),
      cache("project.slow", "candidate", false),
      cache("project.fast", "candidate", true),
      cache("project.base", "baseline", true),
      cache("project.fast", "candidate", true)
    ]);

    assert.ok(profile?.probeCaches);
    assert.deepEqual(profile.probeCaches.rows, [
      {
        stage: "candidate",
        hits: 4,
        misses: 2,
        requests: 6,
        hitRate: 0.666667
      },
      {
        stage: "baseline",
        hits: 2,
        misses: 2,
        requests: 4,
        hitRate: 0.5
      }
    ]);
    assert.deepEqual(profile.probeCaches.totals, {
      hits: 6,
      misses: 4,
      requests: 10,
      hitRate: 0.6
    });
    assert.deepEqual(profile.probeCaches.persistentSuccess, {
      totals: {
        hits: 6,
        misses: 4,
        requests: 10,
        hitRate: 0.6
      },
      modules: [
        {
          moduleName: "project.fast",
          hits: 4,
          misses: 1,
          requests: 5,
          hitRate: 0.8
        },
        {
          moduleName: "project.slow",
          hits: 1,
          misses: 2,
          requests: 3,
          hitRate: 0.333333
        },
        {
          moduleName: "project.base",
          hits: 1,
          misses: 1,
          requests: 2,
          hitRate: 0.5
        }
      ]
    });
  });

  test("aggregates logical and physical C-probe lifecycle traces", async () => {
    const keyA = "a".repeat(64);
    const keyB = "b".repeat(64);
    const keyC = "c".repeat(64);
    const headerOne = "1".repeat(64);
    const headerTwo = "2".repeat(64);
    const headerOneLabel = "lua.h + uv.h";
    const headerTwoLabel = "fixture_probe.h";
    const semantic = (
      moduleName: string,
      key: string,
      headerIdentity: string,
      headerLabel: string,
      outcome: string,
      cacheTier: string,
      repeated: boolean,
      publication: string
    ) => ({
      event: "compiler.c_probe.semantic",
      root_module: "project.root",
      module_name: moduleName,
      key,
      probe_kind: "unsafe_object_pointer",
      header_identity: headerIdentity,
      header_label: headerLabel,
      outcome,
      cache_tier: cacheTier,
      repeated,
      publication
    });
    const execution = (
      moduleName: string,
      key: string,
      headerIdentity: string,
      headerLabel: string,
      outcome: string,
      batchKind: string,
      persistentLookup: string,
      publication: string,
      started: boolean,
      wallMs?: number
    ) => ({
      event: "compiler.c_probe.execution",
      root_module: "project.root",
      module_name: moduleName,
      key,
      probe_kind: "declaration_compatibility",
      batch_kind: batchKind,
      header_identity: headerIdentity,
      header_label: headerLabel,
      outcome,
      persistent_lookup: persistentLookup,
      publication,
      started,
      ...(wallMs === undefined ? {} : { wall_ms: wallMs })
    });

    const profile = await aggregateColdProfile([
      semantic("project.a", keyA, headerOne, headerOneLabel, "success",
        "compiler", false, "diagnostic_not_persisted"),
      semantic("project.a", keyA, headerOne, headerOneLabel, "success",
        "service", true, "existing"),
      semantic("project.b", keyB, headerOne, headerOneLabel,
        "compiler_rejection", "persistent", false, "existing"),
      semantic("project.b", keyC, headerTwo, headerTwoLabel,
        "infrastructure_failure", "compiler", false, "failed"),
      semantic("project.b", keyC, headerTwo, headerTwoLabel,
        "infrastructure_failure", "compiler", true, "not_applicable"),
      execution("project.a", keyA, headerOne, headerOneLabel, "success",
        "single", "miss", "published", true, 10.25),
      execution("project.a", keyA, headerOne, headerOneLabel,
        "compiler_rejection", "single", "hit", "existing", true, 2),
      execution("project.b", keyB, headerTwo, headerTwoLabel,
        "compiler_rejection", "batch", "mixed", "mixed", true, 20.5),
      execution("project.b", keyC, headerTwo, headerTwoLabel,
        "infrastructure_failure", "single", "io_error", "failed", false,
        99)
    ]);

    assert.ok(profile?.probeTraces);
    assert.deepEqual(profile.probeTraces.logical.totals, {
      requests: 5,
      uniqueKeys: 3,
      repeatedRequests: 2
    });
    assert.deepEqual(profile.probeTraces.logical.outcomes, [
      {
        outcome: "infrastructure_failure",
        requests: 2,
        uniqueKeys: 1,
        repeatedRequests: 1
      },
      {
        outcome: "success",
        requests: 2,
        uniqueKeys: 1,
        repeatedRequests: 1
      },
      {
        outcome: "compiler_rejection",
        requests: 1,
        uniqueKeys: 1,
        repeatedRequests: 0
      }
    ]);
    assert.deepEqual(profile.probeTraces.logical.tiers, [
      {
        cacheTier: "compiler", requests: 3, uniqueKeys: 2,
        repeatedRequests: 1
      },
      {
        cacheTier: "persistent", requests: 1, uniqueKeys: 1,
        repeatedRequests: 0
      },
      {
        cacheTier: "service", requests: 1, uniqueKeys: 1,
        repeatedRequests: 1
      }
    ]);
    assert.deepEqual(profile.probeTraces.logical.repetitions, [
      { repeated: false, requests: 3, uniqueKeys: 3, repeatedRequests: 0 },
      { repeated: true, requests: 2, uniqueKeys: 2, repeatedRequests: 2 }
    ]);
    assert.deepEqual(profile.probeTraces.logical.publications, [
      {
        publication: "existing", requests: 2, uniqueKeys: 2,
        repeatedRequests: 1
      },
      {
        publication: "diagnostic_not_persisted", requests: 1, uniqueKeys: 1,
        repeatedRequests: 0
      },
      {
        publication: "failed", requests: 1, uniqueKeys: 1,
        repeatedRequests: 0
      },
      {
        publication: "not_applicable", requests: 1, uniqueKeys: 1,
        repeatedRequests: 1
      }
    ]);
    assert.deepEqual(profile.probeTraces.logical.modules, [
      {
        moduleName: "project.b", requests: 3, uniqueKeys: 2,
        repeatedRequests: 1
      },
      {
        moduleName: "project.a", requests: 2, uniqueKeys: 1,
        repeatedRequests: 1
      }
    ]);
    assert.deepEqual(profile.probeTraces.logical.headerContexts, [
      {
        headerIdentity: headerOne,
        headerLabel: headerOneLabel,
        requests: 3,
        uniqueKeys: 2,
        repeatedRequests: 1
      },
      {
        headerIdentity: headerTwo,
        headerLabel: headerTwoLabel,
        requests: 2,
        uniqueKeys: 1,
        repeatedRequests: 1
      }
    ]);
    assert.deepEqual(profile.probeTraces.physical.totals, {
      attempts: 4,
      launches: 3,
      measuredLaunches: 3,
      childWallMs: 32.75
    });
    assert.deepEqual(profile.probeTraces.physical.modules, [
      {
        moduleName: "project.b", attempts: 2, launches: 1,
        measuredLaunches: 1,
        childWallMs: 20.5
      },
      {
        moduleName: "project.a", attempts: 2, launches: 2,
        measuredLaunches: 2,
        childWallMs: 12.25
      }
    ]);
    assert.deepEqual(profile.probeTraces.physical.headerContexts, [
      {
        headerIdentity: headerTwo, headerLabel: headerTwoLabel,
        attempts: 2, launches: 1, measuredLaunches: 1,
        childWallMs: 20.5
      },
      {
        headerIdentity: headerOne, headerLabel: headerOneLabel,
        attempts: 2, launches: 2, measuredLaunches: 2,
        childWallMs: 12.25
      }
    ]);
    assert.deepEqual(profile.probeTraces.physical.outcomes[0], {
      outcome: "compiler_rejection",
      attempts: 2,
      launches: 2,
      measuredLaunches: 2,
      childWallMs: 22.5
    });
    assert.deepEqual(profile.probeTraces.physical.batchKinds, [
      {
        batchKind: "batch",
        attempts: 1,
        launches: 1,
        measuredLaunches: 1,
        childWallMs: 20.5
      },
      {
        batchKind: "single",
        attempts: 3,
        launches: 2,
        measuredLaunches: 2,
        childWallMs: 12.25
      }
    ]);
    assert.deepEqual(profile.probeTraces.physical.persistentLookups, [
      {
        persistentLookup: "mixed",
        attempts: 1,
        launches: 1,
        measuredLaunches: 1,
        childWallMs: 20.5
      },
      {
        persistentLookup: "miss",
        attempts: 1,
        launches: 1,
        measuredLaunches: 1,
        childWallMs: 10.25
      },
      {
        persistentLookup: "hit",
        attempts: 1,
        launches: 1,
        measuredLaunches: 1,
        childWallMs: 2
      },
      {
        persistentLookup: "io_error",
        attempts: 1,
        launches: 0,
        measuredLaunches: 0,
        childWallMs: 0
      }
    ]);
    assert.deepEqual(profile.probeTraces.physical.publications[0], {
      publication: "mixed",
      attempts: 1,
      launches: 1,
      measuredLaunches: 1,
      childWallMs: 20.5
    });
  });

  test("omits absent profiles, rejects invalid traces, and stabilizes labels",
  async () => {
    assert.equal(await aggregateColdProfile([
      { event: "server.start", cpu_ms: 10 }
    ]), undefined);
    const rounded = await aggregateColdProfile([{
      event: "compiler.source_module.profile",
      root_module: "project.root",
      module_name: "project.rounded",
      filename: "/project/rounded.titan",
      outcome: "complete",
      self_cpu_ms: 0.3,
      total_cpu_ms: 0.3,
      parse_cpu_ms: 0.1,
      check_cpu_ms: 0.2
    }]);
    assert.equal(rounded?.modules[0].otherCpuMs, 0);
    await assert.rejects(aggregateColdProfile([{
      event: "compiler.source_module.profile",
      root_module: "project.root",
      module_name: "project.bad",
      filename: "/project/bad.titan",
      outcome: "failed",
      self_cpu_ms: -1,
      total_cpu_ms: 2,
      parse_cpu_ms: 0,
      check_cpu_ms: 0
    }]), /self_cpu_ms must be a finite nonnegative number/);
    await assert.rejects(aggregateColdProfile([{
      event: "compiler.source_module.profile",
      root_module: "project.root",
      module_name: "project.negative_parse",
      filename: "/project/negative_parse.titan",
      outcome: "complete",
      self_cpu_ms: 2,
      total_cpu_ms: 3,
      parse_cpu_ms: -0.1,
      check_cpu_ms: 1
    }]), /parse_cpu_ms must be a finite nonnegative number/);
    await assert.rejects(aggregateColdProfile([{
      event: "compiler.source_module.profile",
      root_module: "project.root",
      module_name: "project.overlapping",
      filename: "/project/overlapping.titan",
      outcome: "complete",
      self_cpu_ms: 2,
      total_cpu_ms: 3,
      parse_cpu_ms: 1.5,
      check_cpu_ms: 1
    }]), /parse_cpu_ms plus check_cpu_ms must not exceed self_cpu_ms/);
    await assert.rejects(aggregateColdProfile([{
      event: "compiler.source_module.profile",
      root_module: "project.root",
      module_name: "project.impossible_self",
      filename: "/project/impossible_self.titan",
      outcome: "complete",
      self_cpu_ms: 3,
      total_cpu_ms: 2,
      parse_cpu_ms: 1,
      check_cpu_ms: 1
    }]), /self_cpu_ms must not exceed total_cpu_ms/);
    await assert.rejects(aggregateColdProfile([{
      event: "compiler.c_header.phase",
      root_module: "project.root",
      header: "bad.h",
      resolved_header: "/include/bad.h",
      identity: "",
      phase: "process_total",
      outcome: "failed",
      cpu_ms: Number.POSITIVE_INFINITY
    }]), /identity must be a nonempty string/);
    await assert.rejects(aggregateColdProfile([{
      event: "compiler.c_header.phase",
      root_module: "project.root",
      header: "bad.h",
      resolved_header: "/include/bad.h",
      identity: "/stable/bad.h",
      phase: "process_total",
      outcome: "failed",
      cpu_ms: Number.POSITIVE_INFINITY
    }]), /cpu_ms must be a finite nonnegative number/);
    await assert.rejects(aggregateColdProfile([{
      event: "compiler.source_module.profile",
      module_name: "project.missing_root",
      filename: "/project/missing_root.titan",
      outcome: "complete",
      self_cpu_ms: 1,
      total_cpu_ms: 1,
      parse_cpu_ms: 0.5,
      check_cpu_ms: 0.5
    }]), /root_module must be a nonempty string/);
    await assert.rejects(aggregateColdProfile([{
      event: "compiler.source_module.profile",
      root_module: "project.root",
      module_name: "project.bad_outcome",
      filename: "/project/bad_outcome.titan",
      outcome: "cached",
      self_cpu_ms: 1,
      total_cpu_ms: 1,
      parse_cpu_ms: 0.5,
      check_cpu_ms: 0.5
    }]), /outcome must be complete or failed/);
    await assert.rejects(aggregateColdProfile([{
      event: "compiler.module.normalization",
      module_name: "project.missing_root",
      filename: "/project/missing_root.titan",
      cpu_ms: 1
    }]), /root_module must be a nonempty string/);
    await assert.rejects(aggregateColdProfile([{
      event: "compiler.c_header.phase",
      header: "missing-root.h",
      resolved_header: "/include/missing-root.h",
      identity: "/stable/missing-root.h",
      phase: "process_total",
      outcome: "complete",
      cpu_ms: 1
    }]), /root_module must be a nonempty string/);
    await assert.rejects(aggregateColdProfile([{
      event: "compiler.c_probe.cache",
      root_module: "project.root",
      module_name: "project.bad",
      cache: "persistent success",
      stage: "candidate",
      hit: "yes",
      key: "candidate:bad"
    }]), /hit must be a boolean/);
    await assert.rejects(aggregateColdProfile([{
      event: "compiler.c_probe.cache",
      root_module: "project.root",
      module_name: "project.bad",
      cache: "persistent success",
      stage: "unknown",
      hit: false,
      key: "unknown:bad",
      path: "/cache/bad"
    }]), /stage must be baseline or candidate/);
    await assert.rejects(aggregateColdProfile([{
      event: "compiler.c_probe.cache",
      root_module: "project.root",
      module_name: "project.bad",
      cache: "persistent success",
      stage: "baseline",
      hit: false,
      key: "persistent:bad",
      path: 42
    }]), /path must be a nonempty string/);
    await assert.rejects(aggregateColdProfile([{
      event: "compiler.c_probe.semantic",
      root_module: "project.root",
      module_name: "project.bad",
      key: "not-a-digest",
      probe_kind: "c_operator",
      header_identity: "",
      header_label: "",
      outcome: "success",
      cache_tier: "compiler",
      repeated: false,
      publication: "not_applicable"
    }]), /key must be a 64-byte hex digest/);
    await assert.rejects(aggregateColdProfile([{
      event: "compiler.c_probe.semantic",
      root_module: "project.root",
      module_name: "project.bad",
      key: "a".repeat(64),
      probe_kind: "c_operator",
      header_identity: "",
      header_label: "",
      outcome: "cached",
      cache_tier: "compiler",
      repeated: false,
      publication: "not_applicable"
    }]), /outcome has unsupported value/);
    await assert.rejects(aggregateColdProfile([{
      event: "compiler.c_probe.execution",
      root_module: "project.root",
      module_name: "project.bad",
      key: "a".repeat(64),
      probe_kind: "c_operator",
      batch_kind: "single",
      header_identity: "",
      header_label: "",
      outcome: "success",
      persistent_lookup: "miss",
      publication: "not_applicable",
      started: true,
      wall_ms: -0.1
    }]), /wall_ms must be a finite nonnegative number/);
    await assert.rejects(aggregateColdProfile([{
      event: "compiler.c_probe.execution",
      root_module: "project.root",
      module_name: "project.bad",
      key: "a".repeat(64),
      probe_kind: "c_operator",
      batch_kind: "single",
      header_identity: "",
      header_label: "",
      outcome: "success",
      persistent_lookup: "miss",
      publication: "not_applicable",
      started: "yes"
    }]), /started must be a boolean/);
    await assert.rejects(aggregateColdProfile([{
      event: "compiler.c_probe.semantic",
      root_module: "project.root",
      module_name: "project.bad",
      key: "a".repeat(64),
      probe_kind: "c_operator",
      header_identity: "context",
      header_label: "💥".repeat(1025),
      outcome: "success",
      cache_tier: "compiler",
      repeated: false,
      publication: "not_applicable"
    }]), /header_label must be a string of at most 4096 bytes/);
    const equivalentLabels = await aggregateColdProfile([{
      event: "compiler.c_probe.semantic",
      root_module: "project.root",
      module_name: "project.bad",
      key: "a".repeat(64),
      probe_kind: "c_operator",
      header_identity: "same-context",
      header_label: "lua.h",
      outcome: "success",
      cache_tier: "compiler",
      repeated: false,
      publication: "not_applicable"
    }, {
      event: "compiler.c_probe.execution",
      root_module: "project.root",
      module_name: "project.bad",
      key: "a".repeat(64),
      probe_kind: "c_operator",
      batch_kind: "single",
      header_identity: "same-context",
      header_label: "uv.h",
      outcome: "success",
      persistent_lookup: "miss",
      publication: "not_applicable",
      started: true
    }]);
    assert.equal(
      equivalentLabels?.probeTraces?.logical.headerContexts[0].headerLabel,
      "lua.h");
    assert.equal(
      equivalentLabels?.probeTraces?.physical.headerContexts[0].headerLabel,
      "lua.h");

    const reversedLabels = await aggregateColdProfile([{
      event: "compiler.c_probe.execution",
      root_module: "project.root",
      module_name: "project.bad",
      key: "a".repeat(64),
      probe_kind: "c_operator",
      batch_kind: "single",
      header_identity: "same-context",
      header_label: "uv.h",
      outcome: "success",
      persistent_lookup: "miss",
      publication: "not_applicable",
      started: true
    }, {
      event: "compiler.c_probe.semantic",
      root_module: "project.root",
      module_name: "project.bad",
      key: "a".repeat(64),
      probe_kind: "c_operator",
      header_identity: "same-context",
      header_label: "lua.h",
      outcome: "success",
      cache_tier: "compiler",
      repeated: false,
      publication: "not_applicable"
    }]);
    assert.equal(
      reversedLabels?.probeTraces?.logical.headerContexts[0].headerLabel,
      "lua.h");
    assert.equal(
      reversedLabels?.probeTraces?.physical.headerContexts[0].headerLabel,
      "lua.h");
  });

  test("rejects oversized structured profile lines independent of chunking",
  async () => {
    const { collectStderr } = await benchmarkExports();
    const oversized = `titan-language-server ${JSON.stringify({
      event: "compiler.module.normalization",
      module_name: "project.oversized",
      filename: `/${"x".repeat(1_100_000)}`,
      cpu_ms: 1
    })}\n`;

    for (const split of [undefined, 128]) {
      const stream = new PassThrough();
      const collected = collectStderr(stream);
      if (split === undefined) {
        stream.end(oversized);
      } else {
        stream.write(oversized.slice(0, split));
        stream.end(oversized.slice(split));
      }
      await once(stream, "end");
      assert.throws(
        () => collected.coldProfile(),
        /structured server log line exceeded 1048576 characters/
      );
    }
  });
});
