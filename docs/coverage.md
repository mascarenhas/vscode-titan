# Native language-server line coverage

Coverage is opt-in and uses the native workflow from
[Titan #210](https://github.com/mascarenhas/titan/issues/210), pinned to
[Titan PR #213](https://github.com/mascarenhas/titan/pull/213) at
`e9d3855e3429bb526cf3924eb32c5002fa99b0d0`. It measures executable lines in
production Titan sources. A covered line does not establish branch, expression,
function, or behavior coverage.

## Prepare and build

Use the isolated validation SDK, GCC 14 or newer and matching gcov, Python 3,
and `gcovr==8.4`. On macOS use Homebrew GCC and GNU Make; see
[native-build.md](native-build.md) for the Make requirement. Windows CLANG64 is not supported by this
coverage backend; ordinary Windows validation remains a separate gate.

Prepare the validation SDK from a Titan checkout at the exact pin above. A
retained older SDK needs `toolchain-refresh`, rather than `toolchain`'s installed
executable reuse check:

```sh
make -j2 toolchain-refresh BUILD_PROFILE=validation \
  TITAN_REPO=/path/to/pinned/titan
```

```sh
python3 -m venv /tmp/vscode-titan-coverage-tools
/tmp/vscode-titan-coverage-tools/bin/pip install gcovr==8.4
make -j2 server-coverage-build BUILD_ROOT=.build/coverage-native \
  CC=gcc-14 SERVER_COVERAGE_GCOV=gcov-14
```

For Homebrew GCC, substitute its installed version in both tool names, for
example `gmake -j2 server-coverage-build BUILD_ROOT=.build/coverage-native
CC=gcc-16 SERVER_COVERAGE_GCOV=gcov-16`.

The build owns fresh copied sources, objects, notes and images under
`.build/coverage/build`. It never reuses ordinary server/test objects. Its
validation native helpers live under the separately selected `BUILD_ROOT`.
Reusing an existing coverage build directory is an error. Choose a new
`SERVER_COVERAGE_BUILD_DIR` after changing sources, tests, compiler, SDK, native
helpers, build settings or orchestration scripts.

`scripts/server-coverage.mjs` declares all 39 production modules explicitly,
including `titan_language_server` and modules no test imports. It separately
classifies test owners and support; an added or removed Titan source fails the
inventory check until classified. SDK standard-library code, Lua, native
helpers, native dependencies, test owners and generated test support stay
outside the denominator. Declaration-only contributors may have no executable
lines. Uncalled functions retain zero counts.

Both the native aggregate and the actual server select the same complete
production inventory. Staged sources map back to tracked `src/` files; sealing
checks their byte identity. Original/staged tests, native fixtures and execution
scripts are hashed as unmeasured inputs. Keep the selected SDK programs,
compiler/runtime modules, provider and sealed inputs unchanged through
collection/reporting. The SDK's `var/cache/titan-probes` and per-project cache
directories are mutable runtime state outside that seal; they are not coverage
counters. Counter directories are always fresh and owned by one run.

## Collect and report

On headless Linux:

```sh
xvfb-run -a make server-coverage-run
make server-coverage-report \
  SERVER_COVERAGE_GCOVR=/tmp/vscode-titan-coverage-tools/bin/gcovr
```

On macOS, run `make server-coverage-run` from a graphical session, then use
the same report command. The baseline below is Linux-specific.

The native aggregate runs unfiltered and checks that every test owner executed.
The actual server runs the stdio protocol, workspace-cache, unsaved-completion
and Extension Host tests. Each category has a separate fresh counter directory
and run receipt. Extension Host uses the selected measured server and validation
compiler SDK, and waits for native child exit. The ordinary packaging gate
continues to check packaged compiler discovery independently.

Preparation counters stay separate from test runs. Native children inherit only
their run's counter prefix; the harness joins them before reporting. The pinned
runner uses schema-2 receipts and confirms that its POSIX process group is empty
before accepting counters, including after a successful leader exits. Surviving
children force retirement and an incomplete collection. Reports reject legacy
receipts, unconfirmed groups and counters changed after collection. Receipts
retain the leader and collection exit statuses, along with logs and counters.
Missing or incomplete collection fails the workflow. Do not use incomplete
diagnostic reports as a
passing baseline. The detached Codex adapter and detached two-shard launcher are
not placed inside a coverage process group; their ordinary gates still run.

Run/report do not rebuild. Each `SERVER_COVERAGE_RUN_DIR` must be new. Use
`SERVER_COVERAGE_TIMEOUT` to set the per-category deadline in seconds (default
1200). Select `SERVER_COVERAGE_SCOPE=native` for a native-only collection or
report. To inspect native coverage separately after a complete run:

```sh
make server-coverage-report SERVER_COVERAGE_SCOPE=native \
  SERVER_COVERAGE_REPORT_DIR=.build/coverage/native-report \
  SERVER_COVERAGE_GCOVR=/tmp/vscode-titan-coverage-tools/bin/gcovr
```

Reports contain HTML, root-relative Titan LCOV, Cobertura XML, normalized line
counts and source/tool/build/run provenance. Compatible image manifests merge
only when the complete production inventory, source bytes, repository mapping,
compiler and profiler match. Never combine different repository revisions or
platform baselines to improve a percentage.

Local reporting requires no credentials or upload. CI runs the same workflow
and retains reports/logs as review artifacts, without publishing server or VSIX
binaries. Initial reporting has no arbitrary percentage threshold. Add tests
for useful uncovered behavior in the owning native/protocol layer, keeping
ordinary optimized, incremental, packaging and platform checks separate.

## Measured before and after

The 2026-10-09 Linux x86_64 baseline uses GCC/gcov 16.2.1, gcovr 8.4 and the
compiler pin above. Production sources are unchanged from vscode-titan
`9ffaa2a12ef9c75141d7318a5082acab2511560b`. The complete denominator is 12,740
executable lines across 39 explicitly selected production modules.

Both captures use the fixed runner at the pin above, fresh images/counters and
the same production source hashes and executable-line sets. The original scope
retains every native test owner byte-for-byte from that source base; its only
overlays prepare coverage and join the actual servers.

| Test scope | Original tests | Expanded tests | Executable lines |
| --- | ---: | ---: | ---: |
| Native aggregate | 11,255 (88.34%) | 11,357 (89.14%) | 12,740 |
| Native plus actual-server suites | 11,481 (90.12%) | 11,580 (90.89%) | 12,740 |

The original native run passed 469 tests and skipped 18 platform-specific tests;
the expanded run passed 522 and skipped 18. Both actual-server captures passed
protocol, workspace-cache, completion and 13 Extension Host tests; both measured
Extension Host servers exited normally in each capture. All ten schema-2
receipts confirm empty process groups and unchanged counter hashes. The
expanded suite also passes the complete ordinary local `make verify` gate.
The entry module illustrates the difference between scopes: native tests cover
0 of its 69 executable lines, while actual-server execution covers 49.

Coverage guided behavior tests for UTF-8 scalar boundaries and malformed input,
invalid source ranges and canonical file URI identities, exact header-size
limits, location-free compiler diagnostic routing, compiler-provided spans,
variadic completion and saved-file identity. The expanded tests also verify
metadata-only contextual owner restatting and external import-edge/manifest
retention through demand-driven cache restoration, without retaining external
ASTs or project semantic state.

| Production module | Original native covered | Expanded native covered | Executable lines |
| --- | ---: | ---: | ---: |
| `compiler_bridge` | 2,845 | 2,871 | 3,265 |
| `content_identity` | 15 | 25 | 26 |
| `diagnostics` | 122 | 125 | 125 |
| `framing` | 124 | 127 | 140 |
| `project_service` | 1,133 | 1,149 | 1,306 |
| `source_text` | 298 | 342 | 395 |

Native coverage gains 102 executable lines with none lost. Combined coverage
gains 100 lines and no longer observes one cancellation-handler line
([compiler_bridge:1362](../src/server/compiler_bridge.titan#L1362)), for a net
gain of 99. That baseline-only hit came from actual-server execution; both
captures pass. This timing variation remains visible in the comparison.

The largest remaining combined gaps are `compiler_bridge` (362 executable
lines), `project_service` (134), `application` (104), `compiler_io` (75),
`semantic_index` (68) and `semantic_features` (66). They include Windows paths,
defensive metadata validation, failed/cancelled operations and stale-result
fences, but also ordinary Linux behavior. Examples still untested include
[escaped-string folding](../src/server/semantic_features.titan#L533),
[unchanged C-header completion reuse](../src/server/completion_service.titan#L381),
[cached header restoration](../src/server/project_loader.titan#L226), and
[multiple contextual-owner ordering](../src/server/compiler_bridge.titan#L3909).
Malformed framing forms such as decimal overflow, unsupported Content-Type and
missing headers also remain gaps. This Linux baseline does not establish
Windows or macOS coverage, and line coverage does not establish every decision
or behavior on a covered line.
