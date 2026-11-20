# Appendix C: Performance Measurement and Retired Evidence

Two Node scripts benchmark a native language-server executable against saved Titan workspaces. Neither runs during `make verify` or CI; [`src/test/unit/benchmarkScript.test.ts`](../src/test/unit/benchmarkScript.test.ts) tests the aggregation logic of [`scripts/benchmark-server.mjs`](../scripts/benchmark-server.mjs) inside `make extension-test`. Completion timings are collected by `make completion-protocol-test` (see [Completion timings](#completion-timings)).

## Rules for comparable runs

- **Measure a production build:** `make server` builds the `production` profile by default (see [Build profiles](native-build.md#build-profiles)). Record the profile explicitly whenever comparing against a `validation` (`-O0`, no LTO) binary.
- **Freeze one binary copy across phases:** `Compiler:cache_identity` in [`src/server/compiler_bridge/cache_and_completion.titan`](../src/server/compiler_bridge/cache_and_completion.titan) fingerprints the server executable, the compiler Lua trees, and their native dependencies. Rebuilding or replacing any of them invalidates the persisted workspace cache.
- **Keep the workspace idle:** Stop other language servers attached to that root and finish builds and edits before starting.
- **Hold the preprocessing environment constant:** Variables such as `C_INCLUDE_PATH` determine compiler header search roots; changing them alters header provenance and breaks warm-reuse assertions.
- **Isolate A/B inputs:** Use isolated source snapshots, pin processes to one CPU (`taskset -c 0`) on heterogeneous-core hosts, and report replays of copied SQLite files separately from ordinary restarts because copying alters OS page-cache residency.
- **Understand "cold":** A cold run starts with a fresh workspace database and a fresh private probe cache without flushing the OS page cache.
- **Account for overhead and sample count:** Trace logging and `/proc` sampling add overhead. Treat a single run as one observation rather than a distribution; with five samples, the reported p95 equals the maximum.
- **Reject failed runs:** Both scripts exit nonzero on failure, and the cache benchmark preserves its evidence directory. Incomplete startups, missing feature responses, and timeouts are invalid measurements.

In both scripts, `TITAN_PREFIX` selects the server's probe-cache prefix rather than the SDK (`benchmark-workspace-cache.mjs` allocates a private one; `benchmark-server.mjs` forwards yours, defaulting to `.titan-ls` when unset). Compiler selection reads `TITAN_ROOT` or falls back to [SDK selection](native-build.md#sdk-selection) via [`scripts/titan-sdk.mjs`](../scripts/titan-sdk.mjs). `TITAN_LS_LUA_PATH` and `TITAN_LS_LUA_CPATH` override derived module paths when set.

## Startup and cold-index profile: `scripts/benchmark-server.mjs`

```sh
node scripts/benchmark-server.mjs --server bin/titan-language-server
```

By default, [`scripts/benchmark-server.mjs`](../scripts/benchmark-server.mjs) measures this repository with [`src/server/application/indexing_lifecycle.titan`](../src/server/application/indexing_lifecycle.titan) as its query target (`BENCHMARK_FILE`, targeting `start_refresh`). It reports:

- `startup.wallMs`: launch through `initialize` reply, including native module initialization.
- `startup.childCpuMs` and `startup.peakRssKiB`: Linux `/proc` CPU time and peak resident set size sampled right after `initialize`.
- `coldIndex`: wall and CPU time starting at `initialized`, excluding startup.
- Unchanged-target hover and definition latency verifying that ready-state queries do not restart indexing, plus request responsiveness.

`--log-level` defaults to `debug` (matching the extension); pass `off` to measure the lower bound without structured logging.

`--root`, `--file`, `--marker`, and `--symbol` target another saved workspace; the script canonicalizes the root and rejects target or probe files traversing a symlink, matching project discovery. Repeatable `--probe OP:FILE:LINE:CHARACTER` flags add ready-state `hover` or `definition` queries using zero-based LSP coordinates:

```sh
node scripts/benchmark-server.mjs \
  --server bin/titan-language-server --root ../titan \
  --file PATH --marker TEXT --symbol NAME \
  --probe hover:PATH:LINE:CHARACTER --log-level trace
```

With `--log-level trace`, the report includes `coldProfile` aggregated from compiler trace records:

- `coldProfile.modules`: self compiler CPU plus normalization per module, excluding recursive dependencies (`inclusiveCpuMs` is reported separately and never summed). `parseCpuMs`, `checkCpuMs`, and `otherCpuMs` sum to `selfCpuMs` within rounding tolerance; records where parse plus check exceeds self time fail validation.
- `firstCallCpuMs`, `reuseTotalCpuMs`, `reuseCalls`, `reuseAverageCpuMs`, and `reuseMaxCpuMs`: separate initial work from subsequent reuse per identity. Source self-time and normalization streams — like header processing and downstream FFI conversion — carry no shared call ID and remain independent streams.
- `coldProfile.headers`: complete header processing plus downstream FFI conversion per header; component phases are visible without double-counting.
- `coldProfile.probeCaches`: disk-lookup summaries by `baseline` or `candidate` probe stage with 0–1 hit rates, plus `persistentSuccess` ranking modules by persistent-cache hits.
- `coldProfile.probeTraces.logical` and `probeTraces.physical`: logical semantic probe requests versus physical execution attempts, spawned children, and wall time (a warm cache records logical requests with zero physical attempts).

Module and header durations measure process CPU rather than Task-exclusive time, so cooperative yields can admit unrelated work. Because the script sends only one empty immediate-hover probe before readiness, cold rows primarily reflect compiler work.

To compare cold fill against a warm probe cache, point `TITAN_PREFIX` at a fresh absolute directory and reuse it across runs while keeping `TITAN_ROOT` on the SDK. The compiler stores format-2 probe records under `<TITAN_PREFIX>/var/cache/titan-probes/2`.

## Restart and saved-edit workload: `scripts/benchmark-workspace-cache.mjs`

[`scripts/benchmark-workspace-cache.mjs`](../scripts/benchmark-workspace-cache.mjs) runs four sequential phases against one workspace (`--startup-only` stops after phase 2):

1. Cold startup.
2. Unchanged process restart.
3. A saved comment edit in `--file`, served by the restarted process.
4. A third startup after appending a comment to `--header` and advancing its timestamp.

After each generation completes, the script queries hover, definition, references, and folding, asserting identical result digests across phases and verifying that ready-state requests trigger no reindexing:

```sh
mkdir -p .build/cache-benchmarks
cp bin/titan-language-server .build/cache-benchmarks/titan-language-server
node scripts/benchmark-workspace-cache.mjs \
  --server .build/cache-benchmarks/titan-language-server \
  --output .build/cache-benchmarks/vscode-titan
```

By default, it measures this repository using [`src/server/compiler_io.titan`](../src/server/compiler_io.titan) (`--module server.compiler_io`) and [`src/server/compiler_io_clock.h`](../src/server/compiler_io_clock.h). Key options:

- `--marker` must appear exactly once in `--file` to locate the query symbol.
- `--module` names the logical module owning `--file` (required because folder-module contributors need not share the module's leaf name).
- `--header` must be a regular, symlink-free file inside the workspace outside `.titan-ls` (never an SDK or system header). Because headers are unwatched, phase 4 benchmarks startup revalidation.
- `--output` must be a new directory outside `.titan-ls`.
- `--timeout-ms` sets each phase deadline (default 1,800,000; cold runs on the Titan repository use `--timeout-ms 7200000`), `--queries` sets samples per feature (default 5), `--keep-database` retains the measured SQLite file, and `--python` selects Python 3 for nanosecond timestamp restoration and read-only SQLite inspection.

Every imported C header must resolve from workspace configuration or the SDK; a missing header fails the run. The script requires Linux `/proc` and Python 3 with `sqlite3`, always enables trace logging, rejects `TITAN_PROBE_CACHE_DISABLE=1`, and isolates probes in `OUTPUT/probe-prefix` (excluded from database sizes).

### Report

`summary.json` (`schemaVersion: 2`) records:

- `launchToInitialize`, `initialIndex.wallMs` (`initialized` to ready), `launchToReadyWallMs`, `savedEdit.wallMs` (write to next ready epoch), and `headerChange.initialIndex`;
- `childCpuMs`, `reapedDescendantCpuMs` (from `/proc/PID/stat`), and `peakRssKiB` (`VmHWM`, excluding descendants);
- per-feature latency distributions (`min`, `median`, `p95`, `max`) and result digests;
- `manifestRestoration`: background restoration timing relative to SQL readiness (including concurrent query traffic);
- database and WAL/SHM sidecar sizes at readiness and post-shutdown;
- `initialWork` and `savedEdit.work` trace counters plus `cacheBehavior`.

`sourceParseCalls` and `sourceCheckCalls` count only profiles with positive parse or check CPU (zero-CPU dependency profiles are cache visits). Startup stages such as `input_validation` overlap component phases and are never summed.

Every entry in `reuseAssertions` must pass:

- `unchangedRestart`: SQL readiness precedes restoration, with zero source analysis, header preprocessing/parsing, FFI conversion/replay, cache misses, payload encoding, or unchanged-file content hashing.
- `sparseImporter` (full mode): the saved comment parses, checks, and encodes only `--module` with zero header/conversion misses and replays persisted FFI conversions.
- `changedHeader` (full mode): the header edit rechecks the importing module and reruns header preprocessing and FFI conversion.

### Evidence and cleanup

The evidence directory retains `setup.json`, `summary.json`, raw stderr logs, partial session logs, `sqlite-inspection.json` (read-only integrity, row/page counts, and query plans), `source-original.bin`, `header-original.bin`, and `workspace-config.lua`.

The script stashes any existing `.titan-ls` before the cold phase and restores it afterward; its `finally` block (also invoked on `SIGINT`/`SIGTERM`) restores source and header bytes plus nanosecond `atime`/`mtime` (Linux `ctime` cannot be restored). Recover from `SIGKILL` or a crash using `setup.json` and the `.bin` backups.

## Completion timings

`make completion-protocol-test` drives completion over framed stdio against an 800-field dirty module via [`scripts/test-completion-protocol.mjs`](../scripts/test-completion-protocol.mjs), printing request, preparation (`completion.prepare`), selection, and Linux RSS samples as one JSON object. Run with `BUILD_PROFILE=production` for shipping performance numbers.

## Measured conclusions

These conclusions summarize the retired records below (each measured on single local Linux runs):

- Unchanged restarts serve validated SQL queries in seconds even on the Titan repository, with background declaration restoration completing seconds later. Cold indexing takes tens of seconds on this repository and several minutes on the Titan repository, dominated by compiler checking, C-header extraction, and C probes.
- Saved-file features remain responsive during background restoration but contend with it (maxima of several hundred milliseconds observed; no strict latency bound is claimed). Once restoration completes, typical queries finish in a few milliseconds.
- Reusing unchanged modules' SQL rows and re-encoding only modified modules reduces a saved edit from whole-project re-encoding to one module's work.
- Stripping checked function bodies from persisted project payloads shrinks project manifests by over 80% and total database size by roughly two thirds, leaving extracted C-header graphs and FFI conversion payloads as the primary storage consumers (see [Chapter 4](sqlite-backend-storage.md)).
- Warm completion selection from TEMP SQL completes in a few milliseconds, whereas cold private preparation (parsing, checking, header validation) takes tens to hundreds of milliseconds. Completion caps bound owned data rather than process RSS (see [Bounds and checks](completion.md#bounds-and-checks)).

## Retired evidence records

These historical measurement, audit, and research records have been folded into the owning documentation pages. The permalinks preserve their final revisions.

| Record | Contents | Owning page |
| --- | --- | --- |
| [sqlite-backend-benchmarks.md](https://github.com/mascarenhas/vscode-titan/blob/02d0fdff0678e8437da49a211c820d8f94b8796b/docs/sqlite-backend-benchmarks.md) | Restart, saved-edit and header-change runs from September 2026 | This page |
| [sqlite-backend-storage.md (measurements)](https://github.com/mascarenhas/vscode-titan/blob/02d0fdff0678e8437da49a211c820d8f94b8796b/docs/sqlite-backend-storage.md) | Database allocation census before and after compact declaration manifests | [Workspace storage](sqlite-backend-storage.md) |
| [parser-overhaul-performance.md](https://github.com/mascarenhas/vscode-titan/blob/02d0fdff0678e8437da49a211c820d8f94b8796b/docs/parser-overhaul-performance.md) and [.json](https://github.com/mascarenhas/vscode-titan/blob/02d0fdff0678e8437da49a211c820d8f94b8796b/docs/parser-overhaul-performance.json) | Matched cold and restart runs across the parser overhaul | [Rules for comparable runs](#rules-for-comparable-runs) |
| [completion-performance.md](https://github.com/mascarenhas/vscode-titan/blob/02d0fdff0678e8437da49a211c820d8f94b8796b/docs/completion-performance.md) | Completion request, phase and RSS observations | [Completion timings](#completion-timings), [completion](completion.md) |
| [completion-usability-research.md](https://github.com/mascarenhas/vscode-titan/blob/02d0fdff0678e8437da49a211c820d8f94b8796b/docs/completion-usability-research.md) | LSP, LuaLS, rust-analyzer, gopls, HLS and clangd precedents for completion and hover | [Completion](completion.md#design-precedents) |
| [union-payload-audit.md](https://github.com/mascarenhas/vscode-titan/blob/02d0fdff0678e8437da49a211c820d8f94b8796b/docs/union-payload-audit.md) | Inventory of server union payload records | [Server data models](semantic-features.md#server-data-models) |
| [coverage.md (measurements)](https://github.com/mascarenhas/vscode-titan/blob/02d0fdff0678e8437da49a211c820d8f94b8796b/docs/coverage.md) | 2026-10-09 line-coverage captures and remaining gaps | [Coverage](coverage.md) |

---

← Previous: [Appendix B](coverage.md) | [Table of Contents](index.md)
