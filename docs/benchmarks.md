# Performance measurement

Two scripts measure a native server against saved Titan sources. Neither runs
in `make verify` or CI. `src/test/unit/benchmarkScript.test.ts` covers the
aggregation logic of `scripts/benchmark-server.mjs` and runs in
`make extension-test`. Completion timings come from
`make completion-protocol-test`; see [completion timings](#completion-timings).

## Rules for comparable runs

- Measure the production build: `make server` uses the production profile by
  default (see [build profiles](native-build.md#build-profiles)). Do not compare
  it with a validation (`-O0`, no LTO) image unless you record the difference.
- Copy the executable once and use that copy for every process.
  `Compiler:cache_identity` in `src/server/compiler_bridge.titan` fingerprints
  the server executable, the compiler Lua trees and their native dependencies.
  Replacing any of them makes the persisted workspace cache incompatible.
- Keep the workspace idle. Stop other language servers for that root and
  finish builds and source edits before you start.
- Keep the inherited preprocessing environment, such as `C_INCLUDE_PATH`,
  identical between compared runs. The compiler derives header search roots
  from it. A changed value changes header provenance and breaks the strict
  warm-reuse checks.
- For A/B comparisons, use isolated source snapshots. On hosts with mixed core
  classes, pin the server and its descendants to one CPU with `taskset -c 0`.
  Report replays of a copied database separately from ordinary restarts,
  because copying the file changes OS page-cache behavior.
- "Cold" means a fresh workspace database and a fresh private probe cache. The
  OS page cache is not flushed.
- Trace logging and resource sampling add overhead. One run is a single
  observation, not a stable estimate. With five samples, the reported p95 is
  the maximum.
- Both scripts exit nonzero when a run fails, and the workspace benchmark keeps
  its evidence. An incomplete startup, a missing feature result or a timeout is
  not a performance measurement.

In both scripts `TITAN_PREFIX` means the server's probe-cache prefix, never the
SDK. `benchmark-workspace-cache.mjs` creates a private one, and
`benchmark-server.mjs` passes yours through (unset, the server uses
`.titan-ls`). Both select the compiler from `TITAN_ROOT`, or else use
[SDK discovery](native-build.md#sdk-selection) through `scripts/titan-sdk.mjs`.
`TITAN_LS_LUA_PATH` and `TITAN_LS_LUA_CPATH`, when set, override the compiler
module paths derived from that installation.

## Startup and cold-index profile: `scripts/benchmark-server.mjs`

```sh
node scripts/benchmark-server.mjs --server bin/titan-language-server
```

By default the script measures this repository and uses
`src/server/application.titan` as its query target. It reports:

- `startup.wallMs`: process launch through the `initialize` reply, including
  native module initialization.
- `startup.childCpuMs` and `startup.peakRssKiB`: server CPU and peak resident
  memory sampled right after that reply. Both are read from `/proc`, so they
  appear only on Linux.
- `coldIndex`: starts at the `initialized` notification, so its wall and CPU
  times exclude startup.
- A hover/definition pair on an unchanged target that must not start
  indexing, plus request responsiveness.

`--log-level` selects the emitted server level and defaults to `debug`, the
extension's default. Use `off` only to measure the lower bound without
structured logging.

`--root`, `--file`, `--marker` and `--symbol` select another saved workspace and
query target. The script canonicalizes the root and rejects target and probe
files whose paths traverse a symlink, matching project discovery. Each
`--probe OP:FILE:LINE:CHARACTER` adds a ready-state `hover` or `definition`
request, using zero-based LSP coordinates:

```sh
node scripts/benchmark-server.mjs \
  --server bin/titan-language-server --root ../titan \
  --file PATH --marker TEXT --symbol NAME \
  --probe hover:PATH:LINE:CHARACTER --log-level trace
```

`coldProfile` is reported only when the server emits compiler trace records,
which requires `--log-level trace`:

- `coldProfile.modules` charges each module its own compiler CPU plus
  language-server normalization, without its recursive dependencies.
  `inclusiveCpuMs` keeps the overlapping recursive context and is not summed.
  `parseCpuMs`, `checkCpuMs` and `otherCpuMs` add up to `selfCpuMs`, apart
  from rounding. The script rejects trace records whose parse and check work
  exceeds self time.
- `firstCallCpuMs`, `reuseTotalCpuMs`, `reuseCalls`, `reuseAverageCpuMs` and
  `reuseMaxCpuMs` separate each identity's first attributed operation from
  later reuse. Source self time and normalization are separate streams, as are
  header processing and downstream FFI conversion. The trace has no call ID, so
  these fields do not correlate one stream's records with the other's.
- `coldProfile.headers` attributes each header's complete processing plus
  downstream FFI conversion. Component phases stay visible but are not added
  again.
- `coldProfile.probeCaches` summarizes completed-result disk lookups by
  `baseline` or `candidate` probe stage. Hit rates are fractions from 0 to 1.
  `persistentSuccess` ranks the modules responsible for those lookups.
- `coldProfile.probeTraces.logical` counts semantic probe requests and unique
  keys by outcome, cache tier, first or repeated use, publication, module and
  header. `probeTraces.physical` counts execution attempts, started children
  and child wall time. A fully warm cache can show logical requests with zero
  physical attempts.

Module and header durations are process CPU, not Task-exclusive clocks. An
async suspension can let unrelated server work enter an interval. Before the
index is ready, the script sends only an empty immediate-hover probe, so the
cold rows mostly isolate compiler work.

For a persistent-cache fill and warm comparison, point `TITAN_PREFIX` at a
fresh absolute directory and reuse it across the consecutive processes. Keep
`TITAN_ROOT` on the real installation. The compiler stores probe
records under `var/cache/titan-probes/2` in that prefix.

## Restart and saved-edit workload: `scripts/benchmark-workspace-cache.mjs`

A full run starts four phases against one workspace:

1. Cold startup.
2. An unchanged process restart.
3. A saved comment edit in `--file`, handled by that restarted process.
4. A third startup after appending a comment to `--header` and changing its
   timestamp.

`--startup-only` runs only phases 1 and 2. After each completed generation the
script queries hover, definition, references and folding. It requires the
results to stay identical across phases and checks that unchanged requests do
not start indexing.

```sh
mkdir -p .build/cache-benchmarks
cp bin/titan-language-server .build/cache-benchmarks/titan-language-server
node scripts/benchmark-workspace-cache.mjs \
  --server .build/cache-benchmarks/titan-language-server \
  --output .build/cache-benchmarks/vscode-titan
```

The defaults measure this repository. `--file` defaults to
`src/server/compiler_io.titan`, `--module` to `server.compiler_io` and
`--header` to `src/server/compiler_io_clock.h`; `--marker` and `--symbol`
default to a known function there. Other options:

- `--marker` must occur exactly once in `--file`, and the script derives the
  query position from it.
- `--module` names the module that owns the edited file. It is required
  because a folder-module contributor need not share its module's name.
- `--header` must be a regular file below the root, outside `.titan-ls`, and
  reached without symlinks. The script never edits an SDK or system header.
  Headers are not watched, so phase 4 measures startup revalidation, not
  live-save detection.
- `--output` is required and must be a new directory outside `.titan-ls`.
- `--timeout-ms` sets each phase's deadline (default 1,800,000) and
  `--queries` the samples per feature (default 5).
- `--keep-database` retains the measured database.
- `--python` selects the Python 3 interpreter used for exact timestamp
  restoration and read-only SQLite inspection.

A cold index of the Titan repository can exceed the default deadline. Its
measurements have used `--timeout-ms 7200000`. The deadline is a limit, not an
expected duration. Every imported C header must resolve from the workspace
configuration or the SDK. A missing header is an indexing failure, so the run
fails.

The script requires Linux `/proc` and Python 3 with `sqlite3`. It always
enables trace logging and rejects `TITAN_PROBE_CACHE_DISABLE=1`. All processes
share a fresh private probe prefix, `OUTPUT/probe-prefix`, which is excluded from
database sizes.

### Report

`summary.json` has `schemaVersion` 2 and records:

- `launchToInitialize`, `initialIndex.wallMs` (from `initialized` to ready) and
  `launchToReadyWallMs`;
- `savedEdit.wallMs`, from the file write to the next ready epoch;
- `headerChange.initialIndex` for phase 4;
- `childCpuMs` and `reapedDescendantCpuMs`, from `/proc/PID/stat`, and
  `peakRssKiB`, the server's lifetime `VmHWM` without descendants;
- per-feature latency samples with minimum, median, p95, maximum and a
  result digest;
- `manifestRestoration`: background restoration completion relative to SQL
  readiness. The script keeps querying while restoration runs, so restoration
  wall and CPU include that traffic;
- database and sidecar sizes at readiness and after shutdown;
- `initialWork` and `savedEdit.work`: parse/check, header, FFI, cache,
  restoration and encoding counters from the compiler trace, plus
  `cacheBehavior`.

`sourceParseCalls` and `sourceCheckCalls` count only profiles with positive
parse or check CPU. A dependency profile with zero CPU is a cache visit.
Startup phase times such as `input_validation` include discovery and validation,
not just hashing. Component phases overlap and must not be added to their
totals.

`reuseAssertions` must all be true for a successful run:

- `unchangedRestart`: SQL readiness precedes project restoration. The restart
  performs no source analysis, header preprocessing or parsing, FFI conversion
  or replay, cache misses or project-payload encoding. It also performs no
  content reads or hashes for unchanged observations.
- `sparseImporter` (full mode): the saved comment parses, checks and encodes
  only `--module`, without header or conversion misses, and replays a persisted
  FFI conversion.
- `changedHeader` (full mode): the header change rechecks the importing module
  and runs header preprocessing and FFI conversion again.

### Evidence and cleanup

The output directory keeps `setup.json`, which records the inherited and
effective cache settings. It also keeps `summary.json`, raw stderr logs,
partial session data and `sqlite-inspection.json`. The inspection holds
integrity, row counts, page counts and query plans from Python's read-only
SQLite. The directory also keeps `source-original.bin`, `header-original.bin`
and a copy of `titan-config.lua` as `workspace-config.lua`.

The script moves an existing `.titan-ls` aside before the cold phase and
restores it afterward. In `finally` it restores the source and header bytes and
their nanosecond atime and mtime. Linux ctime cannot be restored. SIGINT and
SIGTERM stop the server and run the same cleanup. After a SIGKILL or a crash,
recover from the paths and original bytes recorded in `setup.json` and the
`.bin` files.

## Completion timings

`make completion-protocol-test` drives completion through the stdio server with
an 800-field dirty module (`scripts/test-completion-protocol.mjs`). It prints
the raw request, preparation (`completion.prepare`), selection and Linux RSS
samples as one JSON object. For shipping numbers, build and run it with
`BUILD_PROFILE=production`.

## Measured conclusions

These conclusions come from the retired records below. Their raw numbers were
single local runs on one Linux host.

- An unchanged restart answers from validated SQL in seconds, even for the
  Titan repository. Background declaration restoration then finishes seconds
  later. Cold indexing takes tens of seconds for this repository and many
  minutes for the Titan repository. Compiler checking, C-header work and C
  probes dominate cold time.
- Saved-file features stay answerable during background restoration, but they
  contend with it. Maxima of several hundred milliseconds were observed, so no
  latency bound is claimed. After restoration, typical requests take a few
  milliseconds.
- Reusing unchanged modules' SQL facts and re-encoding only changed modules
  turned a saved edit from a whole-project re-encode into one module's work.
- Removing checked bodies from persisted project payloads shrank them by more
  than 80% and the whole database by about two thirds. Extracted C-header
  graphs and FFI conversion payloads now dominate the database. See
  [workspace storage](sqlite-backend-storage.md).
- Warm completion selection from SQL takes a few milliseconds. Private
  preparation, which includes parsing, checking and header validation, takes
  tens to hundreds of milliseconds and dominates cold requests. The completion
  bounds limit owned data, not process RSS. See
  [completion bounds](completion.md#bounds-and-checks).

## Retired evidence records

These records described past measurements, audits and research. Their durable
conclusions now live in the linked owners. The permalinks keep their last
version.

| Record | Contents | Conclusions now in |
| --- | --- | --- |
| [sqlite-backend-benchmarks.md](https://github.com/mascarenhas/vscode-titan/blob/02d0fdff0678e8437da49a211c820d8f94b8796b/docs/sqlite-backend-benchmarks.md) | Restart, saved-edit and header-change runs from September 2026 | This page |
| [sqlite-backend-storage.md (measurements)](https://github.com/mascarenhas/vscode-titan/blob/02d0fdff0678e8437da49a211c820d8f94b8796b/docs/sqlite-backend-storage.md) | Database allocation census before and after compact declaration manifests | [Workspace storage](sqlite-backend-storage.md) |
| [parser-overhaul-performance.md](https://github.com/mascarenhas/vscode-titan/blob/02d0fdff0678e8437da49a211c820d8f94b8796b/docs/parser-overhaul-performance.md) and [.json](https://github.com/mascarenhas/vscode-titan/blob/02d0fdff0678e8437da49a211c820d8f94b8796b/docs/parser-overhaul-performance.json) | Matched cold and restart runs across the parser overhaul | [Rules for comparable runs](#rules-for-comparable-runs) |
| [completion-performance.md](https://github.com/mascarenhas/vscode-titan/blob/02d0fdff0678e8437da49a211c820d8f94b8796b/docs/completion-performance.md) | Completion request, phase and RSS observations | [Completion timings](#completion-timings), [completion](completion.md) |
| [completion-usability-research.md](https://github.com/mascarenhas/vscode-titan/blob/02d0fdff0678e8437da49a211c820d8f94b8796b/docs/completion-usability-research.md) | LSP, LuaLS, rust-analyzer, gopls, HLS and clangd precedents for completion and hover | [Completion](completion.md#design-precedents) |
| [union-payload-audit.md](https://github.com/mascarenhas/vscode-titan/blob/02d0fdff0678e8437da49a211c820d8f94b8796b/docs/union-payload-audit.md) | Inventory of server union payload records | [Union payload parts](union-payload-parts.md#server-data-models) |
| [coverage.md (measurements)](https://github.com/mascarenhas/vscode-titan/blob/02d0fdff0678e8437da49a211c820d8f94b8796b/docs/coverage.md) | 2026-10-09 line-coverage captures and remaining gaps | [Coverage](coverage.md) |
