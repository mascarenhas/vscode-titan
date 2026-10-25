# Native language-server line coverage

Coverage is opt-in and tracks [Titan PR #217](https://github.com/mascarenhas/titan/pull/217)
at `0bcdaeb8bc25bdd863cc39853f1af90ce178f503`. The compiler builds a covered
native test executable; ordinary execution resets its counters, runs the tests,
dumps counters and generates reports. It measures executable lines in production
Titan sources. A covered line does not establish branch, expression, function or
behavior coverage.

## Prepare and run

Use a compatible installed Titan SDK, GCC 14 or newer and matching gcov. Basic
reporting needs neither Python nor gcovr. On macOS use a prepared Homebrew GCC
SDK and GNU Make; see [native-build.md](native-build.md). This consumer's coverage
launcher currently targets Linux and macOS; platform validation remains a
separate gate.

Select the SDK with `TITAN_PREFIX`, or put its `titanc` on `PATH` for
`titanc --print-root` discovery. The consumer build does not prepare or refresh
that installation. CI prepares a validation SDK from the Titan v0.6 release
source rock; local coverage can also use a production SDK
because prebuilt providers are unmeasured:

```sh
make -j2 server-coverage BUILD_ROOT=.build/coverage-native \
  TITAN_PREFIX="$HOME/.local/titan" \
  CC=gcc-14 SERVER_COVERAGE_GCOV=gcov-14
```

The two phases can also run separately:

```sh
make -j2 server-coverage-build BUILD_ROOT=.build/coverage-native \
  CC=gcc-14 SERVER_COVERAGE_GCOV=gcov-14
make server-coverage-run
```

The build copies authored sources into `.build/coverage/direct/src` and compiles
there. Native helpers use the separately selected `BUILD_ROOT`. The compiler
places generated C, headers, objects and counters in source-adjacent `.coverage`
directories, separate from ordinary outputs. Release builds need no coverage
cleanup or artifact swapping. A coverage build starts with a fresh
`SERVER_COVERAGE_BUILD_DIR`; select another directory after changing inputs.
Running the same built aggregate again is supported: the executable resets its
own counters each time. Use independent build trees for concurrent sessions.
Embedded paths are absolute, so keep the build tree available during execution.

`scripts/server-coverage.mjs` discovers project module ownership from authored
sources, including folder modules. The basenames `tests`, `test_*` and `*_test`
are reserved for the aggregate, helpers and test owners. Other project modules
become requested roots, including modules no test imports. Derived module
selection keeps project test helpers outside the production count. Prebuilt
stdlib modules and native dependencies are automatically unmeasured. The
compiler automatically excludes every source
module owning a top-level `test_` function, even under explicit selection. The
launcher checks the resulting object metadata against discovered production
roots so such an exclusion cannot silently reduce the server denominator. New
production modules need no hardcoded coverage-list update. Uncalled bodies keep
zero counts.

The aggregate runs unfiltered and checks that every native test owner executed.
Its normal test cleanup owns child lifetimes. The launcher preserves failures,
rejects surviving children in its owned process group and applies `SERVER_COVERAGE_TIMEOUT`
seconds (default 1200). There are no seal/run manifests, separate counter
collections, or report-merging stages. Build and execution logs remain under the
coverage build directory.

## Reports

Successful execution prints the compiler's executable-line summary and writes
`report/coverage.gcov`. Set `SERVER_COVERAGE_REPORT_DIR` at build time to change
that location. Basic reporting invokes only matching gcov; it works with gcovr
unavailable.

HTML, LCOV and Cobertura are optional. Request them at build time, since report
settings are embedded in the executable:

```sh
python3 -m venv /tmp/vscode-titan-coverage-tools
/tmp/vscode-titan-coverage-tools/bin/pip install gcovr==8.4
make -j2 server-coverage BUILD_ROOT=.build/coverage-native-rich \
  SERVER_COVERAGE_BUILD_DIR=.build/coverage/direct-rich \
  CC=gcc-14 SERVER_COVERAGE_GCOV=gcov-14 \
  SERVER_COVERAGE_FORMATS='html lcov cobertura' \
  SERVER_COVERAGE_GCOVR=/tmp/vscode-titan-coverage-tools/bin/gcovr
```

The compiler writes `coverage.html`, `coverage.info`, `coverage.xml` and the
Titan-only `lines.json` trace when rich formats are requested. Paths describe the
copied source tree: `src/...` relative to the coverage build root. There is no
source-map or provenance-sealing API. Keep captures from different revisions,
toolchains or runs separate. Local reporting requires no credentials or upload.
CI requests rich formats and retains reports/logs without publishing server or
VSIX binaries. Initial reporting has no arbitrary percentage threshold.

Current measurement covers the native language-server tests. Protocol,
workspace-cache, completion, Extension Host, Codex adapter and packaging tests
continue through the ordinary validation gate. A covered standalone server
would reset counters on each launch and append report output to stdout, which
LSP reserves for framing; the producer supplies no external collection or merge
command. The earlier combined captures below remain historical evidence from
the retired workflow.

## Current direct-execution measurement

The 2026-10-09 Linux x86_64 direct aggregate uses the pinned producer above,
GCC/gcov 16.2.1 and a fresh validation SDK. Basic reporting passes with gcovr
unavailable: 522 tests pass, 18 platform tests skip, and 11,357 of 12,740
executable Titan lines are covered (89.14%). All 39 automatically discovered
production modules pass the compiler-object inventory audit, including the
uncalled entry module. Production Titan sources remain unchanged.

An independent fresh build requesting HTML, LCOV and Cobertura with gcovr 8.4
passes the same 522 tests with 18 skips and reports the same totals. These are
separate captures; their counters are not merged. The optional formats retain
the native test scope.

Independent auditing finds identical production source hashes, executable-line
sets and native hit sets between both current captures and the historical
expanded native capture. JSON, LCOV, Cobertura and HTML agree on the rich
capture's counts. The direct API introduces no denominator drift.

The historical comparison below is retained separately.

## Historical before and after (retired producer)

The 2026-10-09 Linux x86_64 baseline uses GCC/gcov 16.2.1, gcovr 8.4 and the
retired Titan producer `e9d3855e3429bb526cf3924eb32c5002fa99b0d0`. Production sources are unchanged from vscode-titan
`9ffaa2a12ef9c75141d7318a5082acab2511560b`. The complete denominator is 12,740
executable lines across 39 explicitly selected production modules.

Both historical captures use that fixed runner, fresh images/counters and
the same production source hashes and executable-line sets. The original scope
retains every native test owner byte-for-byte from that source base; its only
overlays prepare coverage and join the actual servers. The expanded capture
below was collected for vscode-titan `74e266f0427b2b831b0ea244ae14c11d7f231225`.

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

In the historical combined capture, the largest remaining gaps are `compiler_bridge` (362 executable
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
