# Experimental FFI profiling tools

These scripts capture individual C probe work, compiler phases, native-server
spans, and observed foreign-name demand. The experiment requires the matching
instrumented Titan compiler and native server, plus a Lua 5.5
`probe_profile_clock.so` built from [probe_profile_clock.c](probe_profile_clock.c).
Ordinary release binaries do not provide this schema. See
[the profiling report](../../docs/ffi-probe-profile.md) for results and the
instrumentation delivery instructions.

## Capture prerequisites

Use Linux, the project's installed Lua dependencies, Node.js, Python 3, and the
same headers/compiler used by the workload. Set these absolute paths before the
examples:

```sh
WORKSPACE=/absolute/path/to/titan
TOOLS=/absolute/path/to/vscode-titan/scripts/profiling
COMPILER=/absolute/path/to/instrumented-titan
SDK=/absolute/path/to/installed-titan
CLOCK_DIR=/absolute/path/to/clock-module
SERVER=/absolute/path/to/instrumented-titan-language-server
NODE=$(command -v node)
readlink -f /usr/bin/cc
/usr/bin/cc --version
```

`COMPILER` contains the `titan-compiler/` directory. `SDK` is the real
installation containing Lua 5.5 and its rocks; `CLOCK_DIR` contains the matching
shared library. Keep source/configuration, compiler modules, server executable,
headers, and toolchain fixed during each capture. Record their revisions and
hashes with the evidence. Verify that `/usr/bin/cc` resolves to the intended
Linux host compiler and record its version. The commands select that compiler
explicitly, disable ccache, and restrict child PATH to SDK and system tools.
Resolve Node before changing PATH. Run one measured workload at a time.

Cold means a fresh process, fresh persistent probe prefix, and, for native
startup, a fresh workspace database. In-process reuse remains enabled. Keep
`TITAN_ROCKS_ROOT` on the real installation while assigning `TITAN_PREFIX` to the
fresh output prefix. `TITAN_PROBE_CACHE_DISABLE=1` would change the workload.
Neither example flushes the operating system's filesystem cache.

The original standalone SSL pilot inherited `cc` resolving through ccache,
whose hit state was not captured. Its request, key, outcome, and demand counts
remain valid; its timings are provisional. The controlled native capture is
the timing reference once its completion and integrity checks pass. The native
harness records PATH, CC, and its compiler-cache environment allowlist in
`setup.json`.

## Prepare disposable instrumentation overlays

The [patch manifest](patches/manifest.json) pins bases and every changed-file
hash. Set the two source repository paths and choose a new overlay directory:

```sh
TITAN_SOURCE_REPO=/absolute/path/to/titan-repository
SERVER_SOURCE_REPO=/absolute/path/to/vscode-titan-repository
OVERLAY=/tmp/titan-ffi-overlay-unique
mkdir "$OVERLAY"
mkdir "$OVERLAY/compiler" "$OVERLAY/server" "$OVERLAY/support"
git -C "$TITAN_SOURCE_REPO" archive 788b353bed8e2580bbf12bf8ebf4ad9e7f1ab47d | tar -xf - -C "$OVERLAY/compiler"
git -C "$SERVER_SOURCE_REPO" archive e0bff3b6f46725880b5c8a9b7633eff82643c8a4 | tar -xf - -C "$OVERLAY/server"
git -C "$OVERLAY/compiler" apply --check --whitespace=error-all "$TOOLS/patches/titan-observer.patch"
git -C "$OVERLAY/compiler" apply --whitespace=error-all "$TOOLS/patches/titan-observer.patch"
git -C "$OVERLAY/server" apply --check --whitespace=error-all "$TOOLS/patches/server-observer.patch"
git -C "$OVERLAY/server" apply --whitespace=error-all "$TOOLS/patches/server-observer.patch"
COMPILER="$OVERLAY/compiler"
CLOCK_DIR="$OVERLAY/support"
SERVER="$OVERLAY/server/bin/titan-language-server"
```

Verify the resulting files against the manifest before building. Complete
archives preserve the unchanged dependencies needed by the compiler overlay.
Build the clock separately and build the disposable server with the matching
uninstrumented SDK, leaving profiling disabled during compilation:

```sh
/usr/bin/cc -std=c99 -O2 -Wall -Wextra -Werror -fPIC -shared \
  -I "$SDK/include" "$TOOLS/probe_profile_clock.c" \
  -o "$CLOCK_DIR/probe_profile_clock.so"
env -u TITAN_FFI_PROFILE_DIR CC=/usr/bin/cc CCACHE_DISABLE=1 \
  TITAN_ROCKS_ROOT="$SDK" PATH="$SDK/bin:/usr/bin:/bin" \
  make -C "$OVERLAY/server" -j1 server \
  CC=/usr/bin/cc TITAN_PREFIX="$SDK" TITAN_REPO="$TITAN_SOURCE_REPO"
```

Load the compiler overlay through the explicit Lua search paths below. Keep
the clock in its separate support directory; the packaged native-module
inventory excludes it. The patches are experimental data, applied only for
replay, with no normal installation/startup hook. See the report for patch,
behavior, and delivery gates; finish builds and small smokes before timing.

## Standalone compiler capture

```sh
RUN=/tmp/titan-ffi-standalone-unique
mkdir "$RUN"
cd "$WORKSPACE"
env -u TITAN_PROBE_CACHE_DISABLE -u TITAN_PROBE_CACHE_IDENTITY -u TITAN_EXTRA_CPPFLAGS \
  CC=/usr/bin/cc CCACHE_DISABLE=1 PATH="$SDK/bin:/usr/bin:/bin" \
  TITAN_PREFIX="$RUN/probe-prefix" TITAN_ROCKS_ROOT="$SDK" \
  TITAN_FFI_PROFILE_DIR="$RUN/trace" \
  LUA_PATH="$COMPILER/?.lua;$COMPILER/?/init.lua;$SDK/share/lua/5.5/?.lua;$SDK/share/lua/5.5/?/init.lua" \
  LUA_CPATH="$CLOCK_DIR/?.so;$SDK/lib/lua/5.5/?.so" \
  "$SDK/bin/lua" "$TOOLS/profile-compiler.lua" \
  "$WORKSPACE" titan.ssl "$RUN"
```

Choose the analysis root as the second Lua-script argument; `titan.math` is a
smaller smoke workload. The script reads the workspace's `titan-config.lua`,
builds a catalog of regular `.titan` files under its `include` directories, and
passes all catalog entries as saved source overrides. It uses
`source_module_roots`, `extra_ffi_include_dirs`, and `extra_ffi_cppflags`.
Its simple discovery does not apply `exclude` patterns or follow symlinks;
check the catalog for the selected configuration. Passing `--catalog-only`
instead of the output directory stops before loading the compiler.

The `standalone_compiler` span covers loading/checking the selected root and
finalizing its resolver context. Initial catalog reads precede that span;
interface serialization and retained manifest writes follow it. Successful
completion requires zero diagnostics. These timings cover compiler analysis;
native startup additionally performs workspace discovery, SQLite publication,
and LSP readiness notification.

## Native cold startup

```sh
RUN=/tmp/titan-ffi-native-unique
env -u TITAN_PROBE_CACHE_DISABLE -u TITAN_PROBE_CACHE_IDENTITY -u TITAN_EXTRA_CPPFLAGS \
  CC=/usr/bin/cc CCACHE_DISABLE=1 PATH="$SDK/bin:/usr/bin:/bin" \
  TITAN_STDIO_PIPE_FDS=0,1,2 \
  "$NODE" "$TOOLS/profile-native-cold.mjs" \
  --server "$SERVER" --root "$WORKSPACE" --output "$RUN" \
  --rocks-root "$SDK" --compiler "$COMPILER" --clock-dir "$CLOCK_DIR"
```

The output directory must be new and outside `WORKSPACE/.titan-ls`. The harness
temporarily moves the existing workspace cache aside, creates an owned empty
cache, retains the experimental database on shutdown, and restores the old
cache. Use an idle workspace so another server cannot change cache ownership.
Cleanup failures are recorded in `summary.json`; changed ownership prevents
overwriting an unrelated cache. Cleanup signals the whole detached process group
even after its leader exits, with bounded TERM/KILL and pipe-drain waits. If
writer shutdown or pipe closure cannot be established, `cacheRestorationDeferred`
is true and the experimental cache and original backup stay at the recorded
paths for recovery; the harness does not restore into possible live writes.
The measured capture retains its original harness separately; this delivery's
cleanup fix does not change or rerun the recorded workload.

The default saved-file feature target is `titan/sqlite3/sqlite3.titan`, with the
unique marker `check_result(packet, "prepare")` and symbol `check_result`.
Override these together using `--file`, `--marker`, and `--symbol` for another
workspace. `--timeout-ms` defaults to `7200000`. All options take a value.
After `titan/indexingStatus` reports `ready`, the harness requests hover,
definition, references, and folding, checks diagnostics, then shuts down. It
does one cold startup without source/header edits or a warm restart.

`summary.json` separates launch-to-ready from initialized-to-ready wall time.
Its `/proc` samples report server process CPU, reaped descendant CPU, and peak
RSS. Node's relative timings and recorded monotonic timestamps have different
origins; compare durations or align an explicitly shared event.

## Artifacts and schema

| Artifact | Meaning |
| --- | --- |
| `trace/events.jsonl` (standalone), `compiler/events.jsonl` (native) | Compiler schema-version-1 event stream. |
| `sources/<sha256>.c`, below the trace directory | Exact raw C bytes keyed by SHA-256, before preprocessing. |
| `wrappers/wrapper-<id>.h`, below the trace directory | Retained wrapper bytes referenced by ordered header contexts. |
| `INCOMPLETE`, below the trace directory | Recorder failure marker; its absence alone does not establish completion. |
| `probe-prefix/var/cache/titan-probes/1/*.result` | Isolated persistent acceptance/rejection records. |
| `manifests/<module>.public` and `.source` | Standalone checked-module interface products. |
| `setup.json`, `summary.json`, `server.stderr.log`, `database/` | Native setup fingerprints, outcome/resources, logs, and retained workspace cache. |

Compiler JSONL records carry `producer`, `schema_version`, `sequence`, and
`event`. Server records use the stderr prefix
`titan-language-server-profile ` and the same span format. `span_begin` and
`span_end` pair by `span_id`; `fields.parent_span_id` supplies the hierarchy.
An end records `start`, `finish`, and `delta` clock samples. Compiler and server
span IDs have separate prefixes and can link across the embedded Lua boundary.
Deferred span closure also runs on error; a closed span alone does not prove
that its operation succeeded.

| Clock field (milliseconds) | Scope |
| --- | --- |
| `monotonic_ms` | `CLOCK_MONOTONIC` elapsed time. |
| `process_cpu_ms` | `CLOCK_PROCESS_CPUTIME_ID`, including worker threads. |
| `thread_cpu_ms` | `CLOCK_THREAD_CPUTIME_ID` for the sampling thread. |
| `child_user_ms`, `child_system_ms` | `RUSAGE_CHILDREN` CPU accumulated for reaped children. |

Probe contexts record compiler/service identity, cwd, flags, ordered includes,
and baseline dependencies. Candidate inventory and decision events preserve
ordinary names, previous/current headers, type identities, and purpose.
`request_start`/`request_result` delimit logical calls; `request_source` joins
them to exact source keys. `execution_start` records an attempt, and
`execution_result.started == true` establishes a physical launch. Preparation
failure or an unknown launch state must remain separate. Cached requests have
no new physical execution. Diagnostic labels and instrumentation IDs do not
enter the raw-source cache key.

The relationships are many-to-many: several candidates can request one key,
a request can depend on a baseline request, and a key can have multiple
executions. Charge a physical execution once. Keep baseline validity costs
separate from the first candidate that happened to request them.

Post-check `demand_root` events record resolved foreign-name uses, including
foreign macros/types whose Titan result is primitive. `demand_type` records
selected semantic type edges. Literal module/header/name matches provide direct
name evidence; shared C type identities provide weaker evidence. The observer
does not traverse every `CModule.members` entry or aggregate field, and absence
is meaningful only after a complete observer pass. Demand evidence does not
establish that a probe can safely be skipped.

## Offline analysis

After capture finishes, keep it immutable and write reports elsewhere:

```sh
TRACE="$RUN/trace"                 # Use "$RUN/compiler" for native captures.
REPORT=/tmp/titan-ffi-analysis-unique
mkdir "$REPORT"
python3 -E "$TOOLS/analyze-probes.py" "$TRACE" --out "$REPORT/probes"
python3 -E "$TOOLS/analyze-demand.py" --trace "$TRACE" \
  --output "$REPORT/demand.json" --verify-sources
node --max-old-space-size=12288 "$TOOLS/analyze-spans.mjs" --compiler "$TRACE/events.jsonl" \
  --out "$REPORT/spans.json"
```

For a native capture, add `--server "$RUN/server.stderr.log"` to the span
command. Combine only streams from the same process lifetime and machine.
The span analyzer streams its JSON output so the complete inventory can exceed
Node's single-string limit. The heap allowance above supports the full measured
workspace; it does not change the captured workload.

Derive the native startup phase table and enriched compact accounting directly
from that analyzer output and the harness summary:

```sh
python3 -E "$TOOLS/summarize-native-spans.py" "$REPORT/spans.json" \
  --harness "$RUN/summary.json" --out "$REPORT/native-span-accounting.json"
```

The derivation requires one `application.refresh_once` span and the streamed
format written by the checked-in span analyzer. It separates spans ending by
refresh completion from later diagnostics, feature queries and shutdown;
crossing spans are reported separately, without estimating a CPU split.
Refresh completion precedes the client-observed READY notification. It also
attributes graph serialization through parent links to project, header and FFI
payloads and preserves inclusive pipeline windows separately from residuals.
Both the JSON and sibling Markdown outputs must be new paths. The derivation
reads evidence only and invokes no compiler or server.

The Python analyzers write JSON and sibling Markdown reports. The probe
analyzer verifies retained source byte counts/hashes and request/execution
links. The demand analyzer retains all candidate origins and baseline edges;
use it for demand attribution. Its `--verify-sources` flag enables its own
source verification; omission leaves that result unavailable.

Check `probes.json.integrity_errors` is empty,
`demand.json.captureComplete` is true with no `anomalies`, and
`spans.json.integrity.passed` is true. The demand analyzer exits `2` on
incompleteness; the other analyzers report integrity failures in JSON without
necessarily returning a failing exit status. Check the compiler `profile_end`,
server `profile_summary`, sequence gaps, duplicate/orphan/open spans, missing
parents, clock validity, and the native harness's `summary.json.complete`.

Span residuals subtract the union of directly linked child intervals in each
clock coordinate. They represent CPU consumed outside linked child windows;
concurrent tasks and worker threads can contribute. Category sums can overlap
across unrelated branches. Inspect interval unions and non-ancestral overlap;
task identity is unavailable. Never estimate CPU from a wall-time proportion.
Missing metrics remain unavailable. Observer-overhead counters cover only
their measured subset, so these are instrumented-run timings.

## Optional diagnostic replay

Prepare a reviewable plan without invoking a compiler:

```sh
REPLAY=/tmp/titan-ffi-replay-unique
python3 -E "$TOOLS/replay-probes.py" prepare "$TRACE" \
  --out "$REPLAY" --module titan.ssl --limit 10
```

After reviewing `plan.json`, execute its bounded GCC diagnostic replays:

```sh
python3 -E "$TOOLS/replay-probes.py" run "$REPLAY/plan.json" \
  --execute --repeats 3 --timeout 60
```

Replays retain raw source identity, relocate temporary source/object paths,
and add `-ftime-report -time`. The tool checks prepared source/wrapper hashes
and current direct-header/compiler fingerprints. Original transitive header
bytes and the ambient environment were not snapshotted; missing temporary
wrapper targets can block replay. Diagnostic timing perturbs execution, and
GCC phase/detail rows may overlap. Inspect expected outcomes and timeouts in
`results.jsonl`; replay measurements supplement the original capture.

Reparse the committed evidence from the repository root using its relocated raw
stderr directory and a fresh output prefix:

```sh
EVIDENCE=docs/ffi-probe-profile-data/ssl-pilot
python3 -E "$TOOLS/replay-probes.py" summarize "$EVIDENCE/results.jsonl" \
  --stderr-dir "$EVIDENCE/gcc-stderr" --out /tmp/titan-gcc-reanalysis-unique
```

The override validates `<key>-repeat-<N>.stderr` names and file containment;
missing files do not fall back to historical absolute paths. New summary records
retain both the reported and actual read path plus the actual stderr SHA256.
Original result/stderr files are only read. Without `--stderr-dir`, the original
reported paths are used. See [REPLAY.md](REPLAY.md) for GCC16 wall-only versus
legacy CPU/wall reports and the distinction between parsing and preprocessing.

Run replay regressions outside timed captures:

```sh
python3 -E "$TOOLS/test-replay-parser.py"
python3 -E "$TOOLS/test-replay-lifecycle.py"
```

The lifecycle tests use non-compiler Python process trees. They cover SIGTERM
during a running invocation and during process creation, timeout cleanup,
restoring handlers, and an already-exited process group. Replay and compiler
version invocations share SIGINT/SIGTERM/timeout process-group cleanup.

## Validation

Run the [small validation fixtures](tests/README.md) after timed workloads
finish. They cover demand attribution and incomplete captures, span interval
arithmetic, observer patch replay, and profiling-off/on equivalence with fake
probe runners. The checked-in observer archive includes exact source/wrapper
bytes and prior outputs; no original temporary directory is required.

## Offline enum-selection grouping

After a completed probe analysis, derive the number of whole enum-carrier
selection questions represented by the existing individual candidate probes:

```sh
python3 -E "$TOOLS/analyze-enum-selection.py" \
  "$EVIDENCE/probe-analysis.json" \
  --out "$EVIDENCE/enum-selection-analysis.json"
```

Here `EVIDENCE` is the local native capture directory containing the complete
`probe-analysis.json`; its recorded compiler capture must still contain
`events.jsonl` and `sources/`. Choose a new output path if the report exists.
The command reads saved evidence only and never invokes a compiler.

The analyzer verifies source sizes and SHA256 keys, removes only the second
`extern` declaration from each candidate-pair shape, and retains every other
source byte. It joins complete observer batches through `carrier_index` and
`eligible_carrier_count`, then includes the ordered rendered eligibility list
when counting whole questions. It reports logical selection requests separately
from physical candidate keys and requires one accepted recorded carrier per
question. The `shape_sha256` field is an offline grouping identifier, not the
cache key for an implemented whole-selection source.

The native capture groups 501 physical candidate keys into 47 complete questions
(eight with nine eligible carriers, 39 with eleven), from 138 logical selections.
That is a count under equivalent whole-query reuse, not a measured optimization
speedup or a prediction of the separate combined-FFI header redesign.
