# Appendix B: Executable Line Coverage

Line coverage is opt-in. `titanc --coverage` compiles an instrumented native test aggregate that resets its counters on startup, executes the test suite, dumps counter data, and generates reports covering executable lines in production Titan sources. Line coverage records statement execution only, not branch, expression, function, or behavioral coverage.

Only the native test aggregate is instrumented; protocol, workspace-cache, completion, Extension Host, Codex, and packaging suites run under the ordinary validation gate. An instrumented standalone stdio server would reset counters on each launch and emit its summary to stdout, colliding with LSP framing, and the compiler provides no external counter-merge command.

## Prepare and run

Coverage requires a compatible installed Titan SDK, GCC 14 or newer, and the matching `gcov` binary; basic reporting requires neither Python nor `gcovr`. [`scripts/server-coverage.mjs`](../scripts/server-coverage.mjs) supports Linux and macOS (use Homebrew GCC and GNU Make on macOS; see [SDK selection](native-build.md#sdk-selection)). Production and validation SDKs work identically because prebuilt standard-library providers are excluded from measurement:

```sh
make -j2 server-coverage BUILD_ROOT=.build/coverage-native \
  TITAN_PREFIX="$HOME/.local/titan" \
  CC=gcc-14 SERVER_COVERAGE_GCOV=gcov-14
```

Build and execution also run as separate steps:

```sh
make -j2 server-coverage-build BUILD_ROOT=.build/coverage-native \
  CC=gcc-14 SERVER_COVERAGE_GCOV=gcov-14
make server-coverage-run
```

Coverage builds always use the `validation` profile. `buildCoverage` copies authored `.titan`, `.c`, and `.h` files (omitting generated `.ffi.h` and `.titan.h` headers) into `SERVER_COVERAGE_BUILD_DIR/src` for stable report attribution and compiles with `--tree` on that snapshot and `--output SERVER_COVERAGE_BUILD_DIR/out`. The default directory is `.build/coverage/direct` and must be fresh for every build; choose a new directory after editing inputs, and keep concurrent sessions in separate directories. The generated embedding C and test fixtures come from `BUILD_ROOT`, with `compiler_io_clock.c` and `embedded_interfaces_native.c` passed via `--c-source`. Generated C, headers, objects, and `.gcno`/`.gcda` counters live inside `.coverage` subdirectories under `out`, keeping ordinary builds untouched. Because embedded source paths are absolute, leave the coverage build tree in place until execution finishes; the executable can be rerun repeatedly because it resets its own counters.

### Automatic production and folder-module discovery

`discoverProductionModules` in [`scripts/server-coverage.mjs`](../scripts/server-coverage.mjs) scans `src/` to build the exact production module list without maintaining a manual inventory:

- Directories containing a folder-module main (`basename(dir) == basename(file, ".titan")`) group the main file and every sibling contributor under one logical module name (`server.<name>`), matching the compiler's folder-main precedence and skipping any flat `.titan` file shadowed by a folder.
- Modules whose leaf name is `tests`, starts with `test_`, or ends with `_test` are excluded as test harness or test-owner modules; the compiler also excludes any module owning a top-level `test_` function.
- Every discovered production module is passed explicitly via `--coverage-module server.<name>` and included on the `titanc` module list, ensuring even unimported production modules remain in the denominator with zero hit counts.

After compilation, `auditModules` inspects each module's compiled object through `titan-compiler.objectmetadata`, verifying that every discovered folder contributor and multi-part generated C unit is instrumented and has a matching `.gcno` file.

`runCoverage` (`make server-coverage-run`) runs the aggregate unfiltered under `SERVER_COVERAGE_TIMEOUT` seconds (default 1200), confirms through `validateNativeOwners` that every test owner in `serverTestShards` executed, validates the printed `Titan executable lines:` totals, and rejects any child process surviving in the runner's process group. Logs live under `logs/` and the build manifest in `coverage-build.json`.

## Reports

A passing run prints the executable-line summary and writes `report/coverage.gcov` (override with `SERVER_COVERAGE_REPORT_DIR` at build time) using only `gcov`.

Optional HTML, LCOV, and Cobertura outputs must be requested at build time because report configuration is embedded in the test binary:

```sh
python3 -m venv /tmp/vscode-titan-coverage-tools
/tmp/vscode-titan-coverage-tools/bin/pip install gcovr==8.4
make -j2 server-coverage BUILD_ROOT=.build/coverage-native-rich \
  SERVER_COVERAGE_BUILD_DIR=.build/coverage/direct-rich \
  CC=gcc-14 SERVER_COVERAGE_GCOV=gcov-14 \
  SERVER_COVERAGE_FORMATS='html lcov cobertura' \
  SERVER_COVERAGE_GCOVR=/tmp/vscode-titan-coverage-tools/bin/gcovr
```

`titanc` then writes `coverage.html`, `coverage.info`, `coverage.xml`, and the Titan-only `lines.json` trace with `src/...` paths relative to the coverage build directory. Keep captures from different revisions or toolchains in separate directories. Local reporting uploads nothing; [CI](native-build.md#continuous-integration) enables all three rich formats and uploads the reports and logs as a workflow artifact without enforcing a percentage gate.

The recorded Linux baseline covered roughly 89% of executable Titan lines, with the largest gaps in `compiler_bridge`, `project_service`, `application`, and `compiler_io` across Windows branches, defensive metadata checks, cancellation/failure paths, stale-view fences, and some Linux edge cases. Close gaps by adding behavioral tests in the corresponding module's `*_test.titan` owner; see the [retired coverage record](benchmarks.md#retired-evidence-records).

---

← Previous: [Appendix A](native-build.md) | [Table of Contents](index.md) | Next: [Appendix C: Performance Measurement and Retired Evidence](benchmarks.md) →
