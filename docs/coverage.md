# Native language-server line coverage

Coverage is opt-in. The compiler builds a covered native test executable.
Running it resets its counters, runs the tests, dumps the counters and writes
the reports. It measures executable lines in production Titan sources. A
covered line establishes nothing about branches, expressions, functions or
behavior.

Only the native test aggregate is measured. The protocol, workspace-cache,
completion, Extension Host, Codex adapter and packaging suites stay in the
ordinary validation gate. A covered standalone server would reset counters on
every launch and append its report to stdout, which LSP reserves for framing.
The compiler provides no external collection or merge command.

## Prepare and run

You need a compatible installed Titan SDK, GCC 14 or newer and the matching
gcov. Basic reporting needs neither Python nor gcovr. `scripts/server-coverage.mjs`
supports Linux and macOS; on macOS use a Homebrew GCC and GNU Make (see
[native builds](native-build.md#sdk-selection)). Select the SDK as for any
build. A production SDK works too, because the prebuilt providers are not
measured.

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

Coverage builds always use the validation profile. `server-coverage-build`
copies the authored `.titan`, `.c` and `.h` sources into
`SERVER_COVERAGE_BUILD_DIR/src` and compiles there. The directory defaults to
`.build/coverage/direct` and must not already exist, so choose another one after
inputs change. Native helpers come from the separately selected `BUILD_ROOT`.
The compiler puts generated C, headers, objects and counters in `.coverage`
directories beside the copied sources, apart from ordinary outputs, so
production builds need no coverage cleanup. You can run the same aggregate
again, because the executable resets its own counters. Concurrent sessions need
separate build directories. The embedded paths are absolute, so keep the build
tree in place while it runs.

`discoverProductionModules` in `scripts/server-coverage.mjs` finds production
modules from the authored sources, including folder modules. The basenames
`tests`, `test_*` and `*_test` are reserved for the aggregate, helpers and test
owners. Every other module is passed to `titanc --coverage` as an explicit
`--coverage-module`, including modules that no test imports; their uncalled
bodies keep zero counts. The compiler also excludes any module that owns a
top-level `test_` function, even under explicit selection. After the build,
the script checks each module's object metadata against the discovered list,
so a skipped production module cannot silently shrink the denominator. New
modules need no list update. Prebuilt standard-library modules and native
dependencies are never measured.

`server-coverage-run` runs the aggregate unfiltered. It checks that every
native test owner executed and that the summary line reports valid totals. The
tests' own cleanup owns child processes. The script keeps failures as failures
and rejects children that survive in its process group. It applies
`SERVER_COVERAGE_TIMEOUT` seconds (default 1200). Build and run logs go to
`logs/` in the build directory, and the build manifest to
`coverage-build.json`.

## Reports

A successful run prints the compiler's executable-line summary and writes
`report/coverage.gcov` in the build directory. To change the location, set
`SERVER_COVERAGE_REPORT_DIR` at build time. Basic reporting invokes only the
matching gcov.

HTML, LCOV and Cobertura reports are optional. Request them at build time,
because the report settings are embedded in the executable:

```sh
python3 -m venv /tmp/vscode-titan-coverage-tools
/tmp/vscode-titan-coverage-tools/bin/pip install gcovr==8.4
make -j2 server-coverage BUILD_ROOT=.build/coverage-native-rich \
  SERVER_COVERAGE_BUILD_DIR=.build/coverage/direct-rich \
  CC=gcc-14 SERVER_COVERAGE_GCOV=gcov-14 \
  SERVER_COVERAGE_FORMATS='html lcov cobertura' \
  SERVER_COVERAGE_GCOVR=/tmp/vscode-titan-coverage-tools/bin/gcovr
```

The compiler then writes `coverage.html`, `coverage.info`, `coverage.xml` and
the Titan-only `lines.json` trace. Paths describe the copied tree, so they read
`src/...` relative to the coverage build directory. Keep captures from
different revisions, toolchains or runs separate. Local reporting needs no
credentials and uploads nothing. [CI](native-build.md#continuous-integration)
requests all three rich formats and keeps the reports and logs as an artifact.
There is no percentage threshold.

The last recorded Linux run covered about 89% of the server's executable Titan
lines. The largest gaps were in `compiler_bridge`, `project_service`,
`application` and `compiler_io`. They include Windows paths, defensive metadata
validation, failed and cancelled operations and stale-result fences, but also
ordinary Linux behavior. When you close a gap, add a behavior test in the
existing owner. The captures are a
[retired record](benchmarks.md#retired-evidence-records).
