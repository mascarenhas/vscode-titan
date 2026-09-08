# Workspace SQLite measurements

`scripts/benchmark-workspace-cache.mjs` measures the native language server
against saved files in an actual workspace. Each invocation records a cold
startup, an unchanged process restart, and one saved comment edit in that
restarted process, followed by startup after a repository-owned header changes.
These are the workloads required by the integrated-performance gate in
[#20](https://github.com/mascarenhas/vscode-titan/issues/20) and the durable
SQLite implementation plan. The runner queries hover, definition, references,
and folding after each completed generation and checks that the comment edits
and restarts preserve the returned feature data.

## Reproduce

Build and verify the intended server first. Keep both workspaces idle for the
measurements: close other language-server processes for those roots and finish
builds or source edits before starting. Copy the executable once and use that
same image for every process. The cache identity includes the actual image
path, metadata, and contents, so replacing the executable between the cold and
restart processes would invalidate the measurement.

From the vscode-titan repository:

```sh
mkdir -p .build/cache-benchmarks
cp bin/titan-language-server .build/cache-benchmarks/titan-language-server

node scripts/benchmark-workspace-cache.mjs \
  --server .build/cache-benchmarks/titan-language-server \
  --root . \
  --file src/server/compiler_io.titan \
  --module server.compiler_io \
  --header src/server/compiler_io_clock.h \
  --marker 'return same_lstat_identity(left as LstatIdentity, right as LstatIdentity)' \
  --symbol same_lstat_identity \
  --output .build/cache-benchmarks/vscode-titan

node scripts/benchmark-workspace-cache.mjs \
  --server .build/cache-benchmarks/titan-language-server \
  --root ../titan \
  --file titan/sqlite3/sqlite3.titan \
  --module titan.sqlite3 \
  --header titan/sqlite3/native.h \
  --marker 'check_result(packet, "prepare")' \
  --symbol check_result \
  --timeout-ms 7200000 \
  --output .build/cache-benchmarks/titan
```

Each output directory must be new and outside `.titan-ls`. Use another output
name for another repetition. The target marker must occur exactly once. The
runner derives its UTF-16 position from that marker, so source-line movement
does not require updating a hard-coded coordinate. The selected modules import
the indicated C headers; their saved comment edit can therefore exercise both
header graph reuse and downstream FFI conversion replay. Titan's SQLite module
also exercises a folder module whose foreign imports live in another source
contributor.

`--module` names the project module owning the edited source. This is explicit
because a folder-module contributor does not necessarily have the same name as
its containing file.

The Titan workspace configuration must include the SQLite headers used by that
checkout, alongside its other native dependencies. For the checkout measured
below, `sqlite-autoconf-3530400` is the required entry in
`extra_ffi_include_dirs` in `titan-config.lua`. A missing header is an indexing
failure, so fix the workspace configuration before measuring it.

The runner uses the repository's `.titan` compiler Lua modules by default.
`TITAN_LS_LUA_PATH` and `TITAN_LS_LUA_CPATH` override those paths when measuring
another compatible compiler installation. It requires Linux `/proc`, Node.js,
and Python 3 with `sqlite3`. `--python` selects that Python interpreter;
`-E` prevents unrelated Python environment settings from affecting it.
`--timeout-ms` sets each startup/edit deadline, and `--queries` sets the number
of sequential samples per feature, five by default. The Titan command allows
two hours per phase for its fresh individual native-probe workload; a first
source-only attempt exceeded the default 30-minute response deadline. A deadline
is not an expected duration. Trace logging is always enabled to retain evidence
of work performed and avoided.

## What is measured

Cold means an absent workspace database and a fresh private native-probe cache
directory. All three server processes share that directory. The current runner
uses the compiler's supported `TITAN_PREFIX` cache-root override only in its
child processes, while `TITAN_ROCKS_ROOT` still selects the actual installation.
The source-only probe cache retains its ordinary raw-source SHA-256 keys and
format-1 acceptance/rejection records. Existing installation caches are neither
deleted nor used for the controlled comparison. The historical runs below,
before the source-only simplification, used the former cache-identity namespace
control instead. The OS page cache is not flushed, so these are not machine
cold-boot measurements.

`setup.json` records the inherited and effective cache settings and verifies the
private prefix starts empty. The runner rejects `TITAN_PROBE_CACHE_DISABLE=1`,
requires a positive cold cache miss, and checks every observed persistent lookup
against the private format-1 path. Reported hits include cached acceptance and
rejection; in-memory result reuse does not emit a persistent-lookup event. Probe
files remain under the output directory and have separate file/byte totals.

The report keeps these measurements separate:

- `launchToInitialize` covers process launch through the `initialize` reply.
- `initialIndex.wallMs` covers `initialized` through the ready notification;
  `launchToReadyWallMs` includes native startup as well.
- `savedEdit.wallMs` covers the saved file write through the next ready epoch.
  The edit appends a comment without changing the public interface.
- `headerChange.initialIndex` measures a third startup after appending a C
  comment to the selected header and changing its precise timestamp. The source
  comment from the preceding saved-edit phase remains on
  disk and already matches the database, isolating the header invalidation.
  Header mutation time is recorded separately. These headers are intentionally
  unwatched; this scenario measures startup revalidation, not detection of a
  live header save. The historical 2026-09-07 runs below preserved the header
  timestamp; the current harness follows the subsequently requested timestamp
  validation policy. Separate regressions verify unchanged-mtime trust and
  timestamp-only touches.
- `childCpuMs` samples the server subprocess's user and system CPU through
  `/proc/PID/stat`. It has the host clock-tick granularity recorded by the
  operating system. `reapedDescendantCpuMs` separately reports CPU charged for
  completed descendant processes, such as native compiler probes.
- `peakRssKiB` is the server process's lifetime high-water mark from `VmHWM`.
  The saved-edit value is not a peak for only that edit, and descendant RSS is
  not included.
- Each feature records individual request latencies and their minimum, median,
  p95 and maximum, together with the actual result and a SHA-256 comparison value.
  Unchanged feature requests must not start an indexing cycle.
- `graphHydration` records when background hydration finishes relative to SQL
  readiness, its logged phase, and resource samples after completion. The client
  continuously cycles through all four feature queries while hydration is active;
  these latency samples are separate from `featuresAfterHydration`. Hydration wall
  and process CPU therefore include concurrent query traffic. Fast cold/header
  paths can finish restoration before readiness, leaving no overlapping samples.
- Cache sizes include the database and any `-wal`, `-shm`, and `-journal`
  sidecars both at readiness and after shutdown. They exclude the separate
  compiler probe cache and unrelated installation files.

`initialWork` in all three processes and `savedEdit.work` retain source parse/check profile counts and
CPU, source-module names, header preprocessing/parsing counts, downstream FFI
conversion calls and replay hits, cache statistics, hydration and encoding
events, and the `cache.startup.phase` CPU/wall records. The existing detailed
compiler profile aggregation is included as well. `cacheBehavior` states the
observed restart/edit outcomes explicitly. `graphHydration.work` records the
hydration lifecycle and its final counters. Current runs also enforce these work
checks before reporting success:

- An unchanged restart performs no source analysis/profile visits, header
  preprocessing/parsing, downstream FFI conversion/replay, conversion lookups,
  cache misses, or project-payload encoding.
- Warm SQL readiness precedes project hydration. Source, external-input, header
  and compiler-inventory counters prove zero content reads/hashes for unchanged
  observations. Initial validation and background completion are timed separately.
- The saved comment parses/checks only the named module, performs no header
  preprocessing/parsing or FFI conversion, records a persisted FFI replay hit,
  and encodes exactly one payload with that module's name.
- The header comment rechecks its importing module and performs header
  preprocessing/parsing and FFI conversion again.

The corresponding `reuseAssertions` flags must all be true. Raw logs and
partial session evidence are kept when an assertion fails.

`sourceProfileCalls` and `sourceModules` count profile visits, which include
cached dependencies. `sourceParseCalls` / `sourceCheckCalls` and
`parsedSourceModules` / `checkedSourceModules` require positive
`parse_cpu_ms` / `check_cpu_ms`, respectively. A dependency profile with zero
parse and check CPU is a cache visit; it must not be reported as a module that
was parsed or checked again. Multiple attempts can produce more calls than
unique module names.

Startup phase times include their named operations. In particular,
`input_validation` includes discovery and provider/header validation, plus content
reads/hashes only when metadata requires them; it is not a measurement of hashing
alone. Compiler trace CPU is
process CPU measured across asynchronous operations. Component phases can
overlap and must not be added to their containing totals. Trace logging and
resource sampling add overhead. A single run does not establish a statistically
stable speedup or isolate other machine activity.

## Evidence and restoration

The output directory retains `setup.json`, `summary.json`, raw stderr logs,
partial session measurements, the original edited source bytes, and
`sqlite-inspection.json`. The original header is retained in
`header-original.bin`, and the project configuration, when present, is copied
to `workspace-config.lua`. `--keep-database` additionally retains the measured
database and remaining sidecars after shutdown, including a failed run. Error
diagnostics are retained in the partial session even if feature validation
fails. The SQLite inspection uses
Python's read-only connection and records that library's SQLite version,
integrity result, table row counts, page information, and plans for occurrence,
definition, reference, reverse-import, and dirty-project queries. Native feature
latencies use the server's embedded SQLite; Python query plans should be read
with their separately reported engine version in mind.

An existing `.titan-ls` directory is moved aside before cold startup and restored
after all server processes close. The selected source and header are restored
to their original bytes and exact nanosecond atime/mtime in `finally`. Linux file ctime
changes cannot be undone. If the source changes independently, the runner
preserves that edit, restores the prior cache independently, and reports the
restoration conflict. The header is restricted to a direct regular file inside
the workspace; the runner never edits a system or installed SDK header.
SIGINT and SIGTERM stop the owned server and run
the same cleanup. A forced SIGKILL, host crash, or filesystem failure can prevent
cleanup: `setup.json` records the backup path and original timestamps, and
`source-original.bin` and `header-original.bin` retain the pre-edit bytes for
recovery.

Failures remain failures in `summary.json` and the process exits nonzero.
An incomplete startup, missing feature result, timeout, or unavailable database
must not be presented as a successful performance measurement. Raw logs and
partial measurements remain available to diagnose it.

## Provisional baseline: 7 September 2026

These are historical measurements of the first integrated implementation,
before the revision-keyed payload reuse and codec hashing improvements under
review. They are retained to identify costs and compare a subsequently verified
build. They are not measurements of that later build.

The native image SHA-256 was
`759052cdda7707dec408fe38d0a6ca9ff1a0923047c91609e35662cc0b1f023e`.
The machine used an AMD Ryzen AI 9 HX 370, 24 logical CPUs, Linux
`7.2.0-ogc6.1.fc44.x86_64`, Node.js `v24.13.0`, and 100 process clock ticks per
second. Other test/build processes were held during the sequence. The
vscode-titan checkout was based on `551d01785ea8cdbbcf2c7706158a2525f1658d31`
with the integrated SQLite changes uncommitted; its complete status is retained
in `setup.json`.

The complete vscode-titan sequence passed: all four feature results remained
identical across restarts and comments, unchanged requests started no indexing
cycle, and the final database passed `quick_check`. Source/header bytes and
nanosecond timestamps were checked during cleanup, and the prior cache was
restored. Subsequent readers can advance atime after that check.

| vscode-titan workload | Ready wall time (s) | Server CPU (s) | Reaped descendant CPU (s) | Server peak RSS (MiB) | Database at ready (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cold startup | 86.793 | 84.390 | 0.830 | 3,515.4 | 204.3 |
| Unchanged restart | 53.433 | 53.030 | 0.030 | 3,731.3 | 204.3 |
| Saved importer comment | 64.116 | 62.490 | 0.050 | 3,731.3 | 222.3 |
| Startup after header comment | 142.729 | 139.720 | 0.390 | 4,214.2 | 222.3 |

Startup wall/CPU includes launch through readiness. Saved-edit CPU is the
sample difference for that edit; its RSS remains the restarted process's
lifetime peak. No WAL, SHM, or journal sidecar existed at the readiness or
shutdown snapshots. These snapshots do not measure transient journal peaks.

| Work performed | Cold | Restart | Saved importer comment | Header comment startup |
| --- | ---: | ---: | ---: | ---: |
| Source profile visits | 265 | 0 | 4 | 153 |
| Source parse/check calls | 62 / 62 | 0 / 0 | 1 / 1 | 23 / 23 |
| Unique modules checked | 62 | 0 | 1 | 12 |
| Source parse CPU (s) | 1.211 | 0 | 0.107 | 0.788 |
| Source check CPU (s) | 9.812 | 0 | 0.396 | 3.407 |
| Header preprocess/parse calls | 5 / 5 | 0 / 0 | 0 / 0 | 1 / 1 |
| FFI conversion calls / replay hits | 7 / 0 | 0 / 0 | 0 / 1 | 2 / 0 |
| Project payloads encoded | 62 | 0 | 62 | 62 |
| Project payload encoding CPU (s) | 45.595 | 0 | 45.836 | 44.099 |

Only `server.compiler_io` had nonzero source parse/check CPU after its saved
comment. The other three profile visits were cached dependencies. The unchanged
restart reported zero downstream conversion lookups and misses, and the edit
reported one conversion lookup, one hit, and zero misses. The header comment
caused one preprocessing/parsing pass and two conversions, with repeated source
attempts across 12 affected modules.

Warm startup's named wall phases were inventory 0.462 s, native context 0.446 s,
saved-input validation 3.341 s, and project hydration 45.668 s. Hydration therefore
dominated restart time. The saved edit's 45.836 s of payload encoding CPU also
showed that unchanged modules were being serialized again. These observations
motivate the targeted optimizations; avoiding source work alone did not make
this baseline's refresh inexpensive.

Five sequential requests per feature produced these medians:

| Feature latency (ms) | Cold | Restart | Saved importer comment | Header comment startup |
| --- | ---: | ---: | ---: | ---: |
| Hover | 0.707 | 0.845 | 1.798 | 1.187 |
| Definition | 0.776 | 0.722 | 2.033 | 1.157 |
| References | 0.958 | 1.170 | 2.989 | 1.446 |
| Folding | 4.878 | 5.961 | 17.491 | 6.747 |

The final database contained 64,346 semantic occurrences, 3,987 folds, 62
project snapshots, 414 import edges, and 77 graph modules. Python SQLite
3.51.2 selected an indexed `SEARCH` for each inspected query:
`semantic_occurrences_file`, `semantic_declarations`,
`semantic_occurrences_symbol`, `graph_reverse`, and `graph_project_work`.

Raw evidence is under
`.build/cache-benchmarks/vscode-titan-20260907/`: `summary.json`, the three
stderr logs, `sqlite-inspection.json`, and the preserved `cache/index.sqlite3`.
`work-clarification.json` derives actual parse/check counts from those unchanged
logs; the earlier summary's `sourceModules` field contains all profile visits.

### Failed Titan baseline

The first Titan attempt used its existing `titan-config.lua`, which omitted
`sqlite-autoconf-3530400` from `extra_ffi_include_dirs`. The first diagnostic was
`titan/sqlite3/worker.titan:1:1`: preprocessing `native.h` failed because
`sqlite3.h` was not found. The next diagnostic reported the missing direct
`sqlite3.h` import. Those root errors produced 841 diagnostics in total and
failed `titan.sqlite3` and `sqlite3.tests`; 61 other project modules completed.

The process reached a ready notification after 614.873 s, but hover at the
SQLite target had no result, so the runner exited nonzero. This is failed
evidence, not a successful cold-start benchmark. No warm, source-edit, or
header-edit measurements were performed. Cleanup restored the original source,
header, and absent prior-cache state. The raw trace, exact configuration,
`live-diagnostics.json`, `cold.partial.json`, and failed `summary.json` are
retained under `.build/cache-benchmarks/titan-20260907/`.

## Measurements before the startup follow-up: 7 September 2026

Both complete native repository sequences passed every strict assertion, all
feature-result comparisons, zero-error diagnostic checks, and SQLite integrity
checks. The source and header were restored to their original bytes and exact
nanosecond timestamps during cleanup; current byte hashes and mtimes were also
verified independently afterward. Previous cache presence was restored, backup
directories were removed, and all benchmark processes exited.

The final executable SHA-256 was
`a388a82c7631190051799e3b9edce2931e8fec362b4d0e5fcae1ede7baf3e6bb`.
It was copied once to
`.build/cache-benchmarks/final-image-20260907/titan-language-server` and used
unchanged for all six processes. The host and tracing settings were the same as
the baseline. Both workspaces and the compiler installation stayed frozen, and
all build/test processes were stopped. Titan used the corrected SQLite include
configuration retained in its final `workspace-config.lua`.

### Readiness and resources

| Workspace / workload | Wall (s) | Server CPU (s) | Reaped child CPU (s) | Peak RSS (MiB) | Database at ready (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| vscode-titan: Cold startup | 51.291 | 48.900 | 0.850 | 3,534.6 | 205.9 |
| vscode-titan: Unchanged restart | 18.626 | 18.360 | 0.030 | 3,559.6 | 205.9 |
| vscode-titan: Saved importer comment | 17.440 | 16.770 | 0.040 | 3,568.3 | 224.2 |
| vscode-titan: Header comment startup | 63.773 | 62.020 | 0.400 | 4,224.9 | 224.2 |
| Titan: Cold startup | 453.968 | 292.370 | 157.520 | 5,296.5 | 844.2 |
| Titan: Unchanged restart | 67.657 | 66.550 | 0.020 | 4,384.6 | 844.2 |
| Titan: Saved importer comment | 102.670 | 100.860 | 0.220 | 4,758.0 | 859.6 |
| Titan: Header comment startup | 116.780 | 109.610 | 5.250 | 4,915.5 | 859.6 |

No WAL, SHM, or journal sidecar existed at any final readiness or shutdown
snapshot. The preserved final databases occupy 224.2 MiB and
859.6 MiB respectively. These sizes exclude the separate native-probe cache.
Saved-edit RSS is the process lifetime peak, and server RSS excludes native
compiler descendants.

### Warm startup phases

| Workspace / phase | Wall (s) | CPU (s) |
| --- | ---: | ---: |
| vscode-titan: inventory | 0.727 | 0.696 |
| vscode-titan: native_context | 0.341 | 0.287 |
| vscode-titan: input_validation | 3.609 | 3.512 |
| vscode-titan: project_hydration | 10.199 | 10.160 |
| Titan: inventory | 0.639 | 0.606 |
| Titan: native_context | 0.348 | 0.304 |
| Titan: input_validation | 16.934 | 16.514 |
| Titan: project_hydration | 23.130 | 23.037 |

These named phases are part of startup, not an exhaustive decomposition of
launch-to-ready time. Input validation includes saved-byte hashing, discovery,
and header/provider checks; additional validation and publication work occurs
after hydration. Both restarts restored every project payload (62 and 63)
without invoking source analysis, header preprocessing/parsing, or downstream
FFI conversion. The native-context header lookup was a validated cache hit;
conversion lookups and all misses were zero.

### Work performed and avoided

| Workspace / workload | Parse / check calls | Parse / check CPU (s) | Header preprocess / parse | FFI convert / replay | Payloads encoded | Encoding CPU (s) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| vscode-titan: Cold startup | 62 / 62 | 1.602 / 9.806 | 5 / 5 | 7 / 0 | 62 | 12.084 |
| vscode-titan: Unchanged restart | 0 / 0 | 0.000 / 0.000 | 0 / 0 | 0 / 0 | 0 | 0.000 |
| vscode-titan: Saved importer comment | 1 / 1 | 0.023 / 0.217 | 0 / 0 | 0 / 1 | 1 | 0.176 |
| vscode-titan: Header comment startup | 23 / 23 | 0.784 / 3.411 | 1 / 1 | 2 / 0 | 12 | 2.824 |
| Titan: Cold startup | 63 / 63 | 1.253 / 132.661 | 35 / 35 | 121 / 0 | 63 | 35.082 |
| Titan: Unchanged restart | 0 / 0 | 0.000 / 0.000 | 0 / 0 | 0 / 0 | 0 | 0.000 |
| Titan: Saved importer comment | 1 / 1 | 0.034 / 1.652 | 0 / 0 | 0 / 4 | 1 | 0.918 |
| Titan: Header comment startup | 1 / 1 | 0.025 / 3.418 | 1 / 1 | 4 / 0 | 1 | 0.852 |

Each importer edit parsed, checked, and encoded exactly its own module:
`server.compiler_io` (2,205,925 payload bytes) or `titan.sqlite3`
(16,468,554 bytes). Other source profiles were dependency visits with zero
parse/check CPU. The vscode-titan header change made 23 parse/check calls across
12 affected modules;
Titan's header change rechecked only `titan.sqlite3`. Both changed headers
caused a fresh preprocessing/parsing pass and fresh FFI conversions.

Relative to the provisional vscode-titan run, warm readiness fell from 53.433 s
to 18.626 s and importer-edit readiness from 64.116 s to 17.440 s. The edit's
payload encoding changed from 62 modules / 45.836 s CPU to one module / 0.176 s
CPU. These are observations from the two recorded runs, not a statistical
speedup estimate. The failed Titan baseline cannot support a corresponding
comparison.

### Feature queries and indexed lookups

Each cell is the median of five sequential requests after the indicated
completed generation. All responses matched the cold run exactly, and unchanged
queries initiated no indexing cycle.

| Workspace / workload | Hover (ms) | Definition (ms) | References (ms) | Folding (ms) |
| --- | ---: | ---: | ---: | ---: |
| vscode-titan: Cold startup | 1.471 | 1.126 | 6.269 | 32.491 |
| vscode-titan: Unchanged restart | 1.610 | 1.663 | 2.120 | 12.535 |
| vscode-titan: Saved importer comment | 1.847 | 1.752 | 3.204 | 16.714 |
| vscode-titan: Header comment startup | 0.862 | 0.711 | 1.350 | 5.429 |
| Titan: Cold startup | 1.602 | 1.341 | 3.975 | 5.634 |
| Titan: Unchanged restart | 0.785 | 0.496 | 1.431 | 2.081 |
| Titan: Saved importer comment | 0.908 | 0.896 | 2.409 | 2.432 |
| Titan: Header comment startup | 0.724 | 0.792 | 2.274 | 2.481 |

Both final databases passed `quick_check`. Python SQLite 3.51.2 selected indexed
`SEARCH` plans for occurrence-at-position, definition, references, reverse
imports, and dirty projects, using the five indexes named in the baseline.
The final occurrence/fold/project-snapshot counts were
65,153 / 4,012 / 62 for vscode-titan and
66,787 / 4,817 / 63 for Titan. The native feature timings and Python
query-plan inspection use their respective SQLite engines, as described above.

### Evidence and limits

Complete final evidence, including the database, raw trace, per-phase feature
responses and samples, startup CPU/wall records, compiler profiles, configuration
copy, and restoration results, is retained in:

- `.build/cache-benchmarks/vscode-titan-final-20260907/`
- `.build/cache-benchmarks/titan-final-20260907/`

Both `summary.json` files have `completed`, `restored`, and all three
`reuseAssertions` flags set to true. The provisional baseline directories and
image remain unchanged.

The remaining costs are visible: Titan still takes 102.670 s for the saved
comment edit despite zero header/conversion misses and less than one second of
payload-encoding CPU. Full validation and feature publication still contribute
substantially. Peak server RSS remains several GiB. Query medians vary across
phases and do not show a uniform improvement over the baseline. These are
single trace-enabled runs with five samples per feature, no OS page-cache flush,
and no claim about stable latency percentiles, descendant peak memory, or
transient journal size.

## Timestamp validation and background hydration: 8 September 2026 UTC

These measurements precede the reconciliation with Titan's source-only probe
cache in PR #151. They retain the original compiler and cache-control identities
and serve as a baseline for the combined implementation.

Both complete sequences passed with server schema 3 and the reviewed compiler
language-server API 1 implementation in Titan PR
[#153](https://github.com/mascarenhas/titan/pull/153), commit
`f628e0aa414e4e0ba2b2e57521a49b3d8458e0bf`. The API remains 1 until the first
public release. The extension source was based on `ada9e91` with the startup
follow-up uncommitted; each `setup.json` retains the complete status and host
configuration. The host, tracing and OS page-cache conditions match the earlier
runs. All local builds had finished before these measurements. The maintainer
authorized temporarily pausing the editor's Titan server for the Titan sequence;
it resumed after benchmark cleanup and its running state was verified.

All six benchmark processes used the same frozen image:
`.build/cache-benchmarks/startup-api1-image-20260908/titan-language-server`,
SHA-256 `7053065aa9bb73002968b47f8e8c6f3529fc9e17e1c798d41298421e77ede090`.
The installed 61 compiler Lua files matched the independently reviewed snapshot.

### Readiness and resources

On an unchanged restart, readiness now means validated SQL answers are available;
background graph hydration starts afterward. Cold and changed-header startup
still need analysis before publishing their ready generation. The saved edit
below starts after hydration completes, so it does not measure an edit arriving
during restoration; focused lifecycle tests cover that coordination.

| Workspace / workload | Wall (s) | Server CPU (s) | Reaped child CPU (s) | Peak RSS (MiB) | Database at ready (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| vscode-titan: Cold startup | 53.392 | 51.130 | 0.860 | 3,717.2 | 217.8 |
| vscode-titan: Unchanged restart, SQL ready | 1.550 | 1.440 | 0.020 | 157.7 | 217.8 |
| vscode-titan: Saved importer comment | 5.938 | 5.430 | 0.030 | 1,815.8 | 237.2 |
| vscode-titan: Header comment startup | 32.637 | 31.110 | 0.340 | 1,895.2 | 237.2 |
| Titan: Cold startup | 401.665 | 242.670 | 155.360 | 5,459.8 | 873.0 |
| Titan: Unchanged restart, SQL ready | 5.540 | 5.360 | 0.020 | 182.2 | 873.0 |
| Titan: Saved importer comment | 21.906 | 21.050 | 0.160 | 3,946.6 | 888.4 |
| Titan: Header comment startup | 66.549 | 59.940 | 5.340 | 3,744.0 | 888.4 |

The warm readiness memory samples precede graph allocation. Peak RSS by hydration
completion was 1,358.6 MiB for vscode-titan and 2,776.8 MiB for Titan; saved-edit RSS is the
process's lifetime peak. No WAL, SHM or journal sidecars existed at the sampled
readiness or shutdown points. Final databases were 237.2 and 888.4 MiB, excluding
the separate native-probe cache. These are sampled sizes, not transient peaks.

### Warm validation and hydration

| Workspace / phase | Wall (s) | Process CPU (s) |
| --- | ---: | ---: |
| vscode-titan: inventory | 0.287 | 0.243 |
| vscode-titan: native_context | 0.423 | 0.391 |
| vscode-titan: input_validation | 0.348 | 0.341 |
| vscode-titan: background project_hydration | 16.442 | 16.592 |
| Titan: inventory | 0.489 | 0.403 |
| Titan: native_context | 0.319 | 0.285 |
| Titan: input_validation | 1.561 | 1.551 |
| Titan: background project_hydration | 31.747 | 31.938 |

Both restarts reused 66 compiler-inventory entries with zero content reads or
hashes. Two source-validation scans per workspace also recorded zero source and
external-input reads/hashes. Header content reads/hashes were zero before SQL
readiness, after hydration, and after the saved importer edit. Header search and
physical-identity checks still ran: initial counters recorded 248 metadata
reuses / 1,382 search checks for vscode-titan and 951 / 10,599 for Titan.
Unchanged validation therefore avoids file contents, while retaining discovery,
metadata and search-precedence checks.

On both unchanged restarts, SQL readiness preceded every hydration-start event.
All 62 / 63 project payloads
were restored. Hydration completed 16.442 / 31.747 seconds after SQL readiness,
or 17.992 / 37.286 seconds after launch. The server answered 291 / 886 sequential
feature requests during that work. These hydration wall and process-CPU values
include the concurrent requests; the previous run's hydration phases did not.
The ready and hydration measurements must not be added to CPU columns with a
different sampling interval.

### Feature requests during restoration

All concurrent responses matched the cold result. Each row gives the actual
sample count; p95 is an empirical percentile of this one run.

| Workspace / feature | Requests | Median (ms) | p95 (ms) | Maximum (ms) | Median after hydration (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| vscode-titan: Hover | 73 | 34.363 | 127.310 | 150.990 | 1.261 |
| vscode-titan: Definition | 73 | 41.539 | 95.875 | 158.476 | 1.379 |
| vscode-titan: References | 73 | 35.536 | 71.094 | 95.734 | 2.031 |
| vscode-titan: Folding | 72 | 99.566 | 281.710 | 453.387 | 30.260 |
| Titan: Hover | 222 | 25.297 | 59.226 | 225.722 | 0.451 |
| Titan: Definition | 222 | 26.076 | 53.161 | 401.828 | 0.424 |
| Titan: References | 221 | 32.651 | 64.350 | 324.873 | 1.262 |
| Titan: Folding | 221 | 37.372 | 104.692 | 159.890 | 1.757 |

The post-hydration medians use five samples each. Requests remain serviceable
during restoration, but contention is visible, especially the 453 ms folding
maximum in vscode-titan. Bounded graph traversal yields do not make native
hashing, a single SQLite BLOB read, or string copies preemptible. No uniform
query-latency improvement or hard latency bound is claimed.

### Work performed and avoided

| Workspace / workload | Source parse / check | Header preprocess / parse | FFI convert / replay | Payloads encoded | Encoding CPU (s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| vscode-titan: Cold startup | 62 / 62 | 5 / 5 | 9 / 0 | 62 | 12.916 |
| vscode-titan: Unchanged restart | 0 / 0 | 0 / 0 | 0 / 0 | 0 | 0.000 |
| vscode-titan: Saved importer comment | 1 / 1 | 0 / 0 | 0 / 1 | 1 | 0.147 |
| vscode-titan: Header comment startup | 23 / 23 | 1 / 1 | 2 / 2 | 12 | 2.225 |
| Titan: Cold startup | 63 / 63 | 35 / 35 | 121 / 0 | 63 | 38.866 |
| Titan: Unchanged restart | 0 / 0 | 0 / 0 | 0 / 0 | 0 | 0.000 |
| Titan: Saved importer comment | 1 / 1 | 0 / 0 | 0 / 4 | 1 | 0.965 |
| Titan: Header comment startup | 1 / 1 | 1 / 1 | 4 / 0 | 1 | 1.168 |

The saved edit parsed, checked and encoded only `server.compiler_io`
(2,206,447 bytes) or `titan.sqlite3` (16,894,944 bytes). Other source profile
visits were cached dependencies. Warm startup performed no source analysis,
FFI conversion lookups/misses, header preprocessing/parsing, or payload encoding,
including during background restoration. The changed header caused fresh
preprocessing/parsing and conversions; vscode-titan rechecked 12 unique modules
over 23 attempts, while Titan rechecked only its SQLite module.

### Comparison and evidence

Compared with the preceding run, vscode-titan SQL readiness is 1.550 s versus
18.626 s, and Titan SQL readiness is 5.540 s versus 67.657 s. The earlier ready
event included hydration. Comparing full restoration instead gives 17.992 s and
37.286 s from launch for the current run, with concurrent queries included.
Saved-edit readiness changed from 17.440 to 5.938 s and from 102.670 to 21.906 s.
These observations describe the recorded workloads rather than statistical
speedup estimates. The changed-header workload now advances mtime to follow the
requested timestamp-trust policy; its earlier version deliberately preserved it.

Schema and corpus differences also matter. The vscode-titan occurrence/fold
counts increased to 69,450 / 4,213 from 65,153 / 4,012; Titan retains 66,787 /
4,817. Both contain all 62 / 63 project snapshots. The new schema records header
observations separately from graph payloads, contributing to database growth.
Cold vscode-titan startup was slightly slower than the preceding run, and its
post-hydration folding median increased. The report does not imply that every
workload became faster or that total graph memory was eliminated.

Retained evidence, including all response samples, compiler counters, database
and query-plan inspections, exact configuration, raw logs and restoration
results, is under:

- `.build/cache-benchmarks/vscode-titan-startup-20260908/`
- `.build/cache-benchmarks/titan-startup-20260908/`

Both summaries report `completed`, all restoration flags, and all three reuse
assertions as true, with zero error diagnostics or storage-fallback events.
Both databases passed `quick_check`, and Python SQLite 3.51.2 selected indexed
`SEARCH` plans for all five representative queries. Cleanup restored source and
header bytes and exact nanosecond timestamps plus the previous cache state.
The OS page cache remained intact; trace overhead, single-run sampling, server
versus descendant resources, and unmeasured transient sidecars retain the
limits described above.

## Raw-source probe cache reconciliation: 8 September 2026 UTC

The completed sequences below used the reconciled compiler snapshot
`189b0b8175ec40c4a73feb4a5263c8ac023888b7`, tree
`e932daf28a59b3bb964213ea127322d98ae933f5`, based on Titan master
`9ee0d47ad79a0c28efa0c4c14075f054d86a7ebd` after PR
[#151](https://github.com/mascarenhas/titan/pull/151). This is the reviewed
implementation for PR [#153](https://github.com/mascarenhas/titan/pull/153),
merged as master `788b353bed8e2580bbf12bf8ebf4ad9e7f1ab47d` with that exact
same tree. The extension pins the merged master. It preserves the raw-C-source-only
probe key and format-1 `.result` storage. The installed 61 compiler Lua files
were verified against the frozen snapshot before measurements.

The frozen native image SHA-256 is
`91d08215ed7a849c955850ff2d4306fb7ea7e0cdce8cce624226512e8b11d21c`
(92,127,376 bytes). The vscode-titan checkout was based on
`2f2d3cced20cd925c1baf7d7f870c5249927c669` with the recorded follow-up changes
uncommitted; the complete checkout status is retained with the evidence. The
completed sequence ran from 05:10:54.511 to 05:13:02.627 UTC on 8 September.
The host used an AMD Ryzen AI 9 HX 370, 24 logical CPUs, Linux
`7.2.0-ogc6.1.fc44.x86_64`, Node.js `v24.13.0`, and 100 process clock ticks per
second. Builds were held during the measurements. Trace logging was enabled
and the OS page cache was not flushed.

Both complete sequences passed their independent probe-cache, statistical, and
database audits. Titan R2 ran from 05:49:40.002 to 06:25:19.558 UTC with a fresh
prefix and the same frozen image. Its indexed workspace was the clean Titan
checkout at `f628e0aa414e4e0ba2b2e57521a49b3d8458e0bf`; that is the source
corpus being indexed, not the installed compiler implementation. Lua discovery
still selected the verified reconciled compiler installation. The incomplete
first Titan attempt remains separate and supplies no completed measurement.

### Readiness, CPU, and memory

Startup wall time covers launch through the ready notification. The warm ready
notification means validated SQL answers are available; project hydration
continues afterward. Saved-edit wall and CPU cover the file write through its
next ready notification and start after warm hydration has completed. Startup
CPU is cumulative server-process CPU from launch; edit CPU is a delta for that
edit. Reaped descendant CPU is separate CPU charged for completed child
processes, including compiled probes. It is not part of the server CPU column.
RSS is the server process's lifetime high-water mark; the edit row can retain a
peak reached earlier in the restarted process and excludes descendant RSS.


| Workspace / workload | Wall (s) | Server CPU (s) | Reaped descendant CPU (s) | Peak RSS (MiB) | Database at ready (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| vscode-titan: Cold startup | 66.807 | 52.590 | 12.130 | 3,726.9 | 217.7 |
| vscode-titan: Unchanged restart, SQL ready | 1.542 | 1.440 | 0.010 | 153.4 | 217.7 |
| vscode-titan: Saved importer comment | 6.054 | 5.520 | 0.030 | 1,818.0 | 237.2 |
| vscode-titan: Header comment startup | 33.091 | 31.840 | 0.130 | 1,891.7 | 237.2 |
| Titan R2: Cold startup | 2,011.724 | 615.970 | 1,360.350 | 5,758.3 | 860.5 |
| Titan R2: Unchanged restart, SQL ready | 7.509 | 7.300 | 0.010 | 180.9 | 860.5 |
| Titan R2: Saved importer comment | 21.103 | 20.390 | 0.180 | 4,147.4 | 875.8 |
| Titan R2: Header comment startup | 54.016 | 52.980 | 0.170 | 3,787.0 | 875.8 |

The vscode-titan database was 228,319,232 bytes at cold and warm readiness,
then 248,745,984 bytes at edit and header readiness. After cold shutdown it
remained 228,319,232 bytes; after the restarted process (including its edit)
and the header process it was 248,745,984 bytes. The `-wal`, `-shm`, and
`-journal` sidecars were absent at every recorded readiness and shutdown
observation. These samples do not measure transient sidecar peaks. Probe-cache
bytes are reported separately below.

Titan R2 exact database and sidecar observations:
The Titan database was 902,270,976 bytes at cold and warm readiness and after
cold shutdown. It grew to 918,376,448 bytes at edit and header readiness and
remained that size after the restarted process and header process shut down.
All three SQLite sidecars were absent at every readiness/shutdown sample.
The retained probe cache is separate from these totals.

### Warm validation and background hydration

The warm startup phases below are named operation intervals, not an exhaustive
partition of launch-to-ready time. `input_validation` includes discovery and
provider/header validation; it does not represent hashing alone. Trace CPU
measures process CPU over an interval that may include other asynchronous
activity. Phase and component CPU can overlap, so they must not be added to
server-process CPU or to containing phases.


| vscode-titan warm phase | Wall (ms) | CPU (ms) |
| --- | ---: | ---: |
| inventory | 237.307 | 189.223 |
| native_context | 513.812 | 477.950 |
| input_validation | 289.425 | 284.483 |

Titan R2 warm inventory/native-context/input-validation wall and CPU:

| Titan R2 warm phase | Wall (ms) | CPU (ms) |
| --- | ---: | ---: |
| inventory | 424.872 | 377.438 |
| native_context | 453.319 | 418.709 |
| input_validation | 2,260.126 | 2,206.883 |

At vscode-titan SQL readiness, no project hydration had started or completed.
The background phase then restored all 62 requested project snapshots. The
client issued 291 feature requests overlapping that phase. Its 16,812.116 ms
post-ready completion interval and 16,811.632 ms logged phase wall time include
that query traffic; the logged phase CPU was 16,942.777 ms, including the
16,918.856 ms project-restore interval. Launch-to-hydration completion was
18,353.957 ms. These intervals and their nested CPU must not be added together.

The resource sample after warm completion was 18,390 ms cumulative server CPU,
10 ms cumulative reaped descendant CPU, and 1,393,984 KiB (1,361.3 MiB) lifetime
peak RSS. This sample covers launch, SQL validation, hydration, and the
concurrent requests. The SQL-ready memory observation was 157,080 KiB
(153.4 MiB); early readiness defers graph memory growth rather than removing it.


| vscode-titan hydration | Restored / requested | Phase wall (ms) | Phase CPU (ms) | Launch to phase completion (ms) | Overlapping queries |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cold startup | 0 / 0 | 12.233 | 12.004 | 2,206.560 | 0 |
| Unchanged restart, SQL ready | 62 / 62 | 16,811.632 | 16,942.777 | 18,353.957 | 291 |
| Header comment startup | 60 / 60 | 12,961.837 | 12,907.449 | 14,583.065 | 0 |

Cold and changed-header hydration finished before their ready notification;
there were zero overlapping query samples in those phases. Cold hydration had
no saved payloads to restore. The header startup restored 60 snapshots before
its subsequent analysis and publication. Their resource fields are sampled by
the client after observing readiness and are not CPU or RSS at the earlier
hydration-completion timestamp. The table above uses the recorded completion
time and phase interval, without attributing those later resource samples to it.

Titan R2 hydration counts, completion boundaries, logged phase wall/CPU,
cumulative post-completion resources, and overlap counts:

| Titan R2 hydration | Restored / requested | Phase wall (ms) | Phase CPU (ms) | Launch to phase completion (ms) | Overlapping queries |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cold startup | 0 / 0 | 19.135 | 18.929 | 2,283.740 | 0 |
| Unchanged restart, SQL ready | 63 / 63 | 36,576.095 | 36,890.095 | 44,084.746 | 854 |
| Header comment startup | 62 / 62 | 27,415.532 | 27,323.988 | 35,603.037 | 0 |

At Titan SQL readiness, project hydration had not started. All 63 requested
snapshots were restored afterward while 854 feature requests overlapped the
phase. Post-ready completion took 36,576.033 ms and launch-to-completion
was 44,084.746 ms. Logged phase CPU was 36,890.095 ms, with the
nested project-restore interval recording 36,843.397 ms; neither is an
additional cost to add to process CPU. The post-completion resource sample was
44,190 ms cumulative server CPU, 10 ms reaped descendant CPU, and
2,793,896 KiB (2,728.4 MiB) lifetime peak RSS. SQL-ready RSS was
185,236 KiB (180.9 MiB).

Titan cold/header hydration also finished before readiness with zero overlapping
queries. Cold restored zero payloads; the header startup restored 62 before
analysis. Their later resource samples have the same post-readiness observation
boundary described for vscode-titan, not the earlier phase-completion boundary.

### Work performed and avoided

Parse/check calls require positive recorded parse/check CPU. Profile visits
also include cached dependencies and are not additional parses or checks.
Header calls count preprocessing/parsing operations; FFI conversion calls and
replay hits count conversion sites, which need not equal conversion-cache lookup
counts. Payload CPU is its own logged interval, not an amount to add to total
process CPU.


| vscode-titan workload | Profile visits | Parse / check calls | Unique checked modules | Parse / check CPU (ms) | Header preprocess / parse | FFI convert / replay | Encoded modules | Encoded bytes | Encoding CPU (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Cold startup | 272 | 62 / 62 | 62 | 1,320.111 / 12,331.908 | 5 / 5 | 9 / 0 | 62 | 150,016,495 | 12,590.502 |
| Unchanged restart, SQL ready | 0 | 0 / 0 | 0 | 0.000 / 0.000 | 0 / 0 | 0 / 0 | 0 | 0 | 0.000 |
| Saved importer comment | 4 | 1 / 1 | 1 | 23.538 / 205.083 | 0 / 0 | 0 / 1 | 1 | 2,206,333 | 162.150 |
| Header comment startup | 159 | 23 / 23 | 12 | 993.810 / 3,996.882 | 1 / 1 | 2 / 2 | 12 | 32,823,708 | 2,219.825 |

The importer edit parsed, checked, and encoded only `server.compiler_io`.
Its other three profile visits were cached dependencies. The header edit made
23 parse/check calls across 12 modules and encoded those 12 payloads. All three
strict reuse assertions passed. Unchanged restart performed no source analysis,
profile visits, header preprocessing/parsing, FFI conversion/replay, conversion
lookups/misses, or payload encoding. Hydration added no analysis or encoding.

Titan R2 work counts, parse/check CPU, affected module names, payload bytes/CPU,
and all three strict reuse assertions:

| Titan R2 workload | Profile visits | Parse / check calls | Unique checked modules | Parse / check CPU (ms) | Header preprocess / parse | FFI convert / replay | Encoded modules | Encoded bytes | Encoding CPU (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Cold startup | 301 | 63 / 63 | 63 | 1,126.959 / 495,165.347 | 35 / 35 | 121 / 0 | 63 | 521,217,495 | 43,230.016 |
| Unchanged restart, SQL ready | 0 | 0 / 0 | 0 | 0.000 / 0.000 | 0 / 0 | 0 / 0 | 0 | 0 | 0.000 |
| Saved importer comment | 7 | 1 / 1 | 1 | 33.410 / 3,261.162 | 0 / 0 | 0 / 4 | 1 | 16,303,114 | 829.956 |
| Header comment startup | 7 | 1 / 1 | 1 | 28.881 / 3,831.192 | 1 / 1 | 4 / 0 | 1 | 16,303,114 | 815.898 |

All three Titan reuse assertions passed. Unchanged restart and background
hydration did no source analysis/profile visits, header preprocessing/parsing,
FFI conversion/replay, or payload encoding. The saved comment parsed, checked,
and encoded only `titan.sqlite3`; six other profile visits were cached
dependencies. Its four FFI replay sites correspond to one conversion-cache
lookup/hit. The header comment also rechecked and encoded only `titan.sqlite3`,
with one preprocessing/parsing pass and four fresh FFI conversions. The saved
edit and header payloads each contain 16,303,114 bytes.


| vscode-titan workload | Source scans | Source reads / hashes | External reads / hashes | Header reads / hashes | Inventory reads / hashes / reused |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cold startup | 3 | 62 / 62 | 0 / 0 | 1634 / 280 | 66 / 66 / 0 |
| Unchanged restart, SQL ready | 2 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 / 66 |
| Saved importer comment | 3 | 1 / 1 | 0 / 0 | 0 / 0 | no inventory event |
| Header comment startup | 6 | 0 / 0 | 0 / 0 | 3 / 3 | 0 / 0 / 66 |

These counters describe instrumented source, parser/header-cache, and compiler-
inventory validation. They are not total filesystem I/O: ordinary Lua module
loading, executable paging, compiler-internal header reads, and SQLite graph
BLOB reads are outside them.

The source/external values sum the scans attributed to the indicated workload.
Header values are the latest cumulative compiler counters in that process,
not sums of repeated counter events. Saved-edit header values are therefore
restart-plus-edit cumulative values; because they remain zero, they also prove
zero header content reads/hashes during the edit. The saved-edit work record
also contains the preceding hydration event, so its 62 restored snapshots must
not be described as a second hydration caused by the edit.

The two warm scans report zero source and external content reads/hashes; the
inventory event reused all 66 observations with zero reads/hashes. Header reads
and hashes remain zero at readiness, after hydration, and after the edit. Warm
readiness counters record 248 header metadata reuses, 1,382 search checks,
1,473 memo reuses, one header lookup/hit, zero header misses, and zero conversion
lookups. After the edit those cumulative counters are 423 / 2,353 / 2,455, three
header lookups/hits, and one conversion lookup/hit, still with zero misses.
These header graph counters are distinct from the compiled-probe disk lookup
counters in the next table.

Titan R2 source/external/header/inventory read/hash counters and metadata reuse:

| Titan R2 workload | Source scans | Source reads / hashes | External reads / hashes | Header reads / hashes | Inventory reads / hashes / reused |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cold startup | 3 | 135 / 135 | 0 / 0 | 38570 / 3288 | 66 / 66 / 0 |
| Unchanged restart, SQL ready | 2 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 / 66 |
| Saved importer comment | 3 | 1 / 1 | 0 / 0 | 0 / 0 | no inventory event |
| Header comment startup | 3 | 0 / 0 | 0 / 0 | 32 / 6 | 0 / 0 / 66 |

The 135 cold source reads/hashes cover constituent files of 63 modules; source
files and project modules are different counts. Both warm scans, all warm
inventory content operations, and header reads/hashes at readiness, hydration
completion, and after the edit are zero. Inventory validation reuses all 66
observations. Warm header counters record 951 metadata reuses, 10,599 search
checks, 175,335 memo reuses, one lookup/hit, zero misses, and zero conversion
lookups. After the edit those process-cumulative counters are 1,665 / 18,658 /
292,225, six header lookups/hits, and one conversion lookup/hit, still with
zero misses. Saved-edit records contain the preceding 63-project hydration
event; they do not imply hydration ran again because of the edit. The counter
scope exclusions stated above apply to both workspaces.

### Controlled compiled-probe cache

Each invocation begins with a new empty `TITAN_PREFIX` under its retained output
directory; all three server processes share that prefix. The actual
`TITAN_ROCKS_ROOT` and Lua discovery paths continue to use the compiler
installation. No `TITAN_PROBE_CACHE_IDENTITY` namespace is supplied, and probe
caching is enabled. Observed disk lookups use
`var/cache/titan-probes/1/<64-lowercase-hex-key>.result`. The compiler key is
SHA-256 of the exact raw C source, following the reconciled implementation.


| vscode-titan process scope | Observed disk lookups | Hits | Misses | Unique paths |
| --- | ---: | ---: | ---: | ---: |
| Cold process | 190 | 0 | 190 | 190 |
| Restart + saved-edit process | 1 | 1 | 0 | 1 |
| Changed-header process | 7 | 7 | 0 | 5 |

The single lookup belongs to the complete restart-and-edit process. The retained
aggregate audit does not attribute it to initial warm validation, hydration, or
the saved edit. The table must not be relabeled as per-ready or edit-only
counters, and zero warm source/FFI/encoding work does not establish the timing
of a compiled-probe disk lookup. Header changes do not require fresh compiled-probe
misses when the raw C source key is unchanged. The independent header
preprocessing/parsing/conversion assertions still passed.

The retained probe directory contains 190 valid format-1 records totaling
3,610 bytes, independently checked against the raw logs and summary. All 190
records in this invocation store successful exit status; there are zero retained
rejections. The cache format also supports cached rejection: a reported hit
means a stored result exists and does not generally imply success. In-memory
hits emit no disk-lookup event. Positive cold misses corroborate the recorded
empty-start observation; retained files alone cannot reconstruct the initial
state or the raw-source preimages.

The installation probe-cache snapshots taken before and after the complete
vscode-titan invocation match, including the recorded file metadata and hashes.
The independent audit compared those retained snapshots without opening the
live installation. The 3,610 probe bytes are excluded from all SQLite sizes.

Titan R2 full-process disk lookup/hit/miss/unique-path counts, valid record and
success/rejection counts, separate retained bytes, controlled-path audit, and
installation before/after comparison:

| Titan R2 process scope | Observed disk lookups | Hits | Misses | Unique paths |
| --- | ---: | ---: | ---: | ---: |
| Cold process | 9496 | 0 | 9496 | 9496 |
| Restart + saved-edit process | 285 | 285 | 0 | 285 |
| Changed-header process | 285 | 285 | 0 | 285 |

The Titan prefix retains 9,496 independently validated format-1 records totaling
357,363 bytes: 9,042 accepted results and 454 rejected results. All 9,496 cold
lookups were misses from the newly empty controlled prefix. Each subsequent
process observed 285 hits and zero misses. Those 285 restart-and-edit hits
remain scoped to the complete process; the aggregate audit does not attribute
them to initial validation, hydration, or the edit. Every observed key/path and
record matched the source-only format contract. Before/after installation
probe-cache snapshots match. These probe bytes are excluded from SQLite
sizes. Cached rejections are valid cache records, not language-server error
diagnostics; all three Titan processes had zero error diagnostics.

### Feature requests

Every cell below is **median / p95 / maximum milliseconds**. Ordinary query
sets contain five sequential requests per feature. The warm initial set is a
subset of the hydration-overlap samples, not an additional independent sample
set. The warm overlap counts are hover 73, definition 73, references 73, and
folding 72 (291 total). Its results were checked by the runner on every request;
retained initial and post-hydration result objects were also independently
rehashed and compared across workloads. No query result changed and unchanged
queries triggered no indexing generation.


| vscode-titan query phase | Hover (ms) | Definition (ms) | References (ms) | Folding (ms) |
| --- | ---: | ---: | ---: | ---: |
| Cold: initial ready | 1.026 / 1.338 / 1.338 | 1.004 / 2.220 / 2.220 | 1.246 / 1.381 / 1.381 | 6.377 / 6.920 / 6.920 |
| Cold: post-hydration query set | 0.699 / 0.907 / 0.907 | 0.926 / 1.114 / 1.114 | 1.206 / 1.549 / 1.549 | 5.806 / 6.023 / 6.023 |
| Warm: initial five, overlapping hydration | 40.073 / 67.538 / 67.538 | 41.777 / 42.415 / 42.415 | 17.816 / 23.098 / 23.098 | 250.946 / 331.809 / 331.809 |
| Warm: all hydration-overlap samples | 34.116 / 137.868 / 170.871 | 35.992 / 77.458 / 166.004 | 29.081 / 63.336 / 206.752 | 109.067 / 331.809 / 457.443 |
| Warm: after hydration | 1.346 / 2.389 / 2.389 | 2.098 / 2.307 / 2.307 | 2.991 / 13.730 / 13.730 | 32.728 / 34.834 / 34.834 |
| Saved importer edit | 0.490 / 0.748 / 0.748 | 0.497 / 0.552 / 0.552 | 0.624 / 0.820 / 0.820 | 4.198 / 5.669 / 5.669 |
| Header: initial ready | 0.630 / 0.994 / 0.994 | 0.956 / 1.117 / 1.117 | 1.031 / 1.378 / 1.378 | 5.130 / 5.610 / 5.610 |
| Header: post-hydration query set | 0.625 / 0.856 / 0.856 | 0.661 / 0.699 / 0.699 | 0.987 / 1.089 / 1.089 | 5.050 / 5.659 / 5.659 |

All 32 stored distributions were independently recalculated from their
samples. For a five-sample set, the reported p95 is the maximum observation.
Cold/header post-hydration sets are further queries after readiness; they do
not imply that restoration continued after readiness. Warm hydration allowed
requests to complete, but its observed folding maximum was 457.443 ms and its
references maximum was 206.752 ms. Availability during hydration is not a claim
of uniformly small request latency.

Titan R2 initial/post-hydration/edit median/p95/max tables, per-feature overlap
counts and distributions, feature equality, and unchanged-query assertions:

| Titan R2 query phase | Hover (ms) | Definition (ms) | References (ms) | Folding (ms) |
| --- | ---: | ---: | ---: | ---: |
| Cold: initial ready | 0.670 / 1.073 / 1.073 | 0.683 / 0.796 / 0.796 | 1.326 / 1.346 / 1.346 | 1.867 / 2.068 / 2.068 |
| Cold: post-hydration query set | 0.615 / 0.698 / 0.698 | 0.624 / 0.721 / 0.721 | 1.344 / 1.370 / 1.370 | 1.652 / 1.824 / 1.824 |
| Warm: initial five, overlapping hydration | 39.746 / 127.338 / 127.338 | 38.719 / 59.938 / 59.938 | 62.488 / 70.407 / 70.407 | 108.383 / 145.349 / 145.349 |
| Warm: all hydration-overlap samples | 27.716 / 72.023 / 503.564 | 24.597 / 65.416 / 236.172 | 37.569 / 89.146 / 156.741 | 45.308 / 140.829 / 313.378 |
| Warm: after hydration | 0.573 / 0.687 / 0.687 | 0.563 / 0.600 / 0.600 | 1.585 / 1.705 / 1.705 | 1.724 / 1.813 / 1.813 |
| Saved importer edit | 0.586 / 0.779 / 0.779 | 0.470 / 0.543 / 0.543 | 1.551 / 1.603 / 1.603 | 1.652 / 1.681 / 1.681 |
| Header: initial ready | 0.585 / 1.483 / 1.483 | 0.578 / 0.604 / 0.604 | 1.881 / 2.092 / 2.092 | 2.007 / 2.436 / 2.436 |
| Header: post-hydration query set | 0.516 / 0.630 / 0.630 | 0.570 / 0.688 / 0.688 | 1.457 / 1.828 / 1.828 | 1.763 / 2.037 / 2.037 |

Titan overlap counts were hover 214, definition 214, references 213, and folding
213, totaling 854. The initial five per feature are included in these overlap
counts. Independent recalculation passed all 32 Titan distributions; the two
completed workspaces therefore supply 64 distributions and 1,145 overlapping
requests in total. Actual retained feature JSON hashes match each workspace's
own cold baseline across restart, edit, header, and post-hydration query sets;
the runner checked every overlapping response and no unchanged request started
an indexing generation. This does not assert that different workspaces return
the same feature data. The largest Titan overlapping hover sample was 503.564 ms;
its five post-hydration hover samples had median 0.573 ms and maximum 0.687 ms.
These describe different phases and sample counts.

### Corpus, database integrity, and cleanup

The final retained vscode-titan database contains 62 project snapshots totaling
148,043,633 payload bytes, 69,458 semantic occurrences, 69,458 hovers, 4,213
folds, 62 semantic files/projects, 77 graph modules, 418 import edges, nine FFI
conversion snapshots, and six header graphs. Cold encoding produced
150,016,495 bytes across 62 snapshots; the final payload sum is a later state
after the edit and header workloads and must not be substituted for cold
encoding volume.

The independent read-only inspection passed `PRAGMA quick_check`, matched all
recorded table counts, and verified 60,729 pages of 4,096 bytes with 5,364 free
pages. Python SQLite 3.51.2 selected the following indexed plans. Native feature
timings come from the server's embedded SQLite, not this inspection process.


| Query | Verified plan |
| --- | ---: |
| occurrence_at | `SEARCH` using `semantic_occurrences_file` |
| definition | `SEARCH` using `semantic_declarations` |
| references | `SEARCH` using `semantic_occurrences_symbol` |
| reverse_imports | `SEARCH` using `graph_reverse` |
| dirty_projects | `SEARCH` using `graph_project_work` |

Vscode-titan `completed`, all three reuse assertions, `databaseRetained`,
`sourceRestored`, `headerRestored`, `cacheRestored`, and combined `restored` are
true. The runner checked restoration of original source/header bytes and exact
nanosecond timestamps during cleanup and restored the prior workspace cache.
The independent retained-evidence audit matched the original source/header and
configuration hashes; it deliberately did not reopen the live workspace to
repeat restoration checks. Subsequent readers can advance file atime, and Linux
ctime is not restorable. No error diagnostics or in-memory cache fallback were
recorded in the three completed processes.

Titan R2 payload/corpus counts, read-only integrity and five indexed plans,
all completion/restoration flags, evidence hashes, and editor-resume evidence:
The final Titan database contains 63 project snapshots totaling 521,196,530
payload bytes, 66,787 semantic occurrences and hovers, 4,817 folds, 135 semantic
files, 63 semantic projects/graph modules, 253 import edges, 36 FFI conversion
snapshots, and 36 header graphs. Cold encoding produced 521,217,495 bytes;
the later final payload sum is a different observation. Its 224,213 pages of
4,096 bytes, 3,100 free pages, and every recorded table count match an
independent read-only inspection. `quick_check` returned `ok`; all five queries
used the same five indexed `SEARCH` plans listed above under Python SQLite
3.51.2. Native request latencies still use the server's embedded engine.

All Titan completion, database-retention, restoration, and strict reuse flags
are true. There were zero error diagnostics and zero memory-fallback events.
Retained source/header/configuration bytes match their setup SHA-256 values.
`independent-input-restoration.json` additionally confirms both live inputs'
bytes, precise mtime, mode, and that the later O_NOATIME verification itself
left metadata unchanged. That later check records advanced atime for both files;
it does not claim atime remained unchanged after benchmark cleanup. No prior
Titan workspace cache existed, and the runner restored that absent-cache state.

`editor-pause.json` records the authorized pause and resumption of editor server
PID 1632948 and benchmark exit code 0. The controlling run also verified the
resumed process in state `S`; the independent artifact audit verified the
retained pause/resume record without signaling or re-reading the live process.

### Incomplete Titan attempt and retry boundary

The first Titan invocation, retained separately as
`.build/cache-benchmarks/titan-startup-source-only-20260908/`, exceeded the
harness's 1,800,000 ms framed-response deadline before a completed cold-ready
measurement. Its summary has `completed: false` and no completed cold object;
it contributes no row to the completed performance tables. It retained 8,924
probe records totaling 316,484 bytes. Those are partial-run artifact counts,
not a completed corpus or a successful cold-run result. The recorded source,
header, prior cache, and combined restoration flags are all true; the retained
installation snapshots match, and the paused editor server was resumed and
its running state verified. The timeout is a harness deadline outcome, not
evidence of a reported server error or of the time required to finish indexing.

R2 uses a different new output directory,
`.build/cache-benchmarks/titan-startup-source-only-20260908-r2/`, a fresh empty
probe prefix, the same image, and `--timeout-ms 7200000`. Two hours is the
allowed per-operation deadline, not an expected or measured runtime. R2 finished
successfully and passed the independent audit. Its measured cold readiness was
2,011,723.506 ms: 33 minutes 31.724 seconds. The subsequent warm/edit/header
measurements above come from that complete R2 invocation.

### Evidence and comparison limits

Completed vscode-titan raw logs, results, sample arrays, setup, original bytes,
configuration, retained database and probe prefix, and installation snapshots
are retained at:

- `.build/cache-benchmarks/vscode-titan-startup-source-only-20260908/`

Independent audit extracts are:

- `/tmp/vscode-titan-source-only-20260908-probe-audit.json`
- `/tmp/vscode-titan-source-only-20260908-statistical-audit.json`
- `/tmp/vscode-titan-source-only-20260908-database-audit.json`

Titan R2 completed evidence/audit locations:

- `.build/cache-benchmarks/titan-startup-source-only-20260908-r2/`
- `/tmp/titan-source-only-20260908-r2-probe-audit.json`
- `/tmp/titan-source-only-20260908-r2-statistical-audit.json`
- `/tmp/titan-source-only-20260908-r2-database-audit.json`

The Titan directory also retains `editor-pause.json` and
`independent-input-restoration.json`, plus the same original/configuration,
probe, database, raw-log, and installation-snapshot evidence as vscode-titan.

The earlier `f628e0a` / `7053065` measurements remain historical results for
that earlier compiler and probe-cache setup. Titan cold readiness increased from
the historical 401.665 s observation to 2,011.724 s in the present controlled
source-only run. This is a substantial observed cold-start cost. R2 recorded
9,496 cold compiled-probe misses and 1,360.350 s of reaped descendant CPU,
separate from 615.970 s of server CPU. These measurements identify the work
present in this run; they do not isolate the causal cost of any single change.
The present source-only run uses a newly controlled format-1 prefix, while the
earlier compiler/probe setup and serialized payload state differ. Its cold CPU
and wall time must be reported separately. Neither those differences nor a single trace-enabled run establish a
blanket speedup or regression. SQL readiness, full hydration completion, and
saved-edit readiness are distinct milestones. Five-sample p95 values are not
stable tail-latency estimates; hydration samples include active query traffic.
The measurements exclude descendant peak RSS, transient sidecar peaks, OS
cold-boot effects, and an edit arriving before warm hydration completes.
