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
of sequential samples per feature, five by default. Trace logging is always
enabled to retain evidence of work performed and avoided.

## What is measured

Cold means an absent workspace database and a new isolated native-probe cache
namespace. All three server processes share that native-probe namespace. The OS
page cache is not flushed, so this is not a machine cold-boot measurement.
Previously populated compiler probe namespaces are neither deleted nor used
for the invocation's controlled cold/restart comparison.

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
