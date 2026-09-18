# Incremental native builds

The server and native test executable use [Titan PR #164](https://github.com/mascarenhas/titan/pull/164)'s
opt-in object mode plus [the cached-binding fix](https://github.com/mascarenhas/titan/pull/165).
The exact compiler revision is pinned in [the CI workflow](../.github/workflows/ci.yml).
Make owns the dependency graph and rebuild decisions; Titan restores source
metadata from current objects while compiling dependents and linking.

```sh
make -j2 server server-test-build
make server-test-sharded
```

Use `server-objects` or `server-test-objects` to build the corresponding object
graph without linking its executable. `server` links and installs the native
language server; `server-test-build` links the single test executable used by
both execution shards. `server-test-run` runs an already built test executable.

## Object and link ownership

Authored source remains under `src/`. Persistent `.build/server-src` and
`.build/test-src` trees hold staged source plus generated C, objects and headers.
Only changed staged inputs are replaced. The build does not clear these trees
on every invocation and does not generate files beside authored sources.

`scripts/generate-native-build.lua` reads the compiler's parsed top-level
imports and module constituents to produce `.build/native-modules.mk`. Fixture
strings containing Titan source are not imports of their enclosing test module.
Direct module dependencies determine which object recipes can run in parallel.
Make also tracks project C headers, generated producer companions, compiler and
SDK/provider inputs, configuration, and source inventory changes.

Each object recipe invokes `titanc -c --incremental -j1`. Make controls object
parallelism, so `make -j2` uses two compilation slots rather than starting two
multithreaded compiler pipelines. The final commands use `--incremental` to reuse
the objects and perform the normal standalone/test link. Native payloads,
exported Lua API flags, the standard-library archive and bootstrap options
remain final-link inputs.

Production compilation and linking use `--static --source-first`. Test objects
have their own consistent `--test --source-first` policy. The test graph first
builds shared support at `.build/tests/titan/test__test_support.o`; the final
`--test --no-uv-bootstrap` command discovers cases from the current objects and
produces the runner. The test graph follows Titan's stdlib test policy without
`--static`: the source-backed `titan.test` support overrides that provider member,
so other stdlib imports use the corresponding DSO bindings. Production objects
and test objects are not interchangeable.

Lua derives default module paths from its executable's installation tree. Native
test executables live under `.build/tests`, outside the SDK's `bin` directory.
Both execution targets follow Titan's own test harness: query the selected
`$(TITAN_LUA)` with `-E` for `package.path` and `package.cpath`, then pass those
values as `LUA_PATH_5_5` and `LUA_CPATH_5_5` to the aggregate or its shards. The
launcher clears ambient `TITAN_PATH_0_6` and `TITAN_PATH` so an unrelated provider
cannot override the selected SDK. No SDK pathname is embedded in the executable
or fabricated from its build directory. Use the Make targets to run the tests;
direct execution outside the SDK tree needs the same queried Lua paths.

## Rebuild behavior

An unchanged build preserves generated-object, header and executable timestamps.
Changing a module rebuilds that module and its importing closure; unrelated
branches remain reusable. A changed authored C header conservatively invalidates
all project objects; module edits still invalidate only the importing closure.
Added or removed constituents and changed imports update the build graph.
Changed test cases rebuild their owner and regenerate the final runner.

Compiler, SDK/provider and effective build-setting changes invalidate the
relevant configuration. In particular, use consistent `CC`, preprocessing,
C and linker flags for each graph. Titan's object timestamp check alone does
not validate flags, dependency objects or header contents; the Make rules own
those inputs. Missing generated companions are repaired through their producer
rules rather than accepted as a complete build.

The pinned compiler defaults to `-O3` and Linux fat LTO. Final linking can still
be substantial after a small edit. For an intentional development override,
apply it consistently to compilation and linking:

```sh
make -j2 server \
  TITAN_EXTRA_CFLAGS='-O0 -fno-lto' \
  TITAN_EXTRA_LDFLAGS='-O0 -fno-lto'
```

The configuration change rebuilds affected artifacts. Removing the override
also invalidates them. The complete validation gate uses the shipping defaults.

One Make invocation owns a build directory. Independent concurrent builds in
one checkout need separate `BUILD_ROOT` values and separate `SERVER` destinations
(the default is `bin/titan-language-server`). Object-only and test-only builds
need only separate build roots. Do not run multiple Make processes against the
same staged trees. `make clean` removes generated state. Native test execution
remains split into the existing two shards, independently of object scheduling.

## Build regressions

`make incremental-build-test` builds small real Titan/C fixtures through this
Makefile in a private source/build tree. It checks unchanged timestamps and zero
compiler invocations, importing-closure rebuilds, folder/import changes, header
and flag invalidation, changed test discovery, and missing generated companions.
It also runs the native tests with absent and unrelated ambient Titan paths to
check that execution uses the selected SDK.
The fixture uses matching `-O0 -fno-lto` compile/link overrides to keep this gate
short. `make verify` also builds and tests the full server with shipping defaults.

`make completion-protocol-test` exercises full document synchronization and
completion through the actual stdio server, including unsaved folder members,
saved dependency isolation, UTF-16 edits, and saved navigation. It reports cold
preparation and warm SQL selection timings separately, using an 800-field dirty
module and a competing saved refresh. This focused gate is also a prerequisite
of `server-protocol-test`, so CI and `make verify` include it. Pass matching
`BUILD_ROOT`, `SERVER`, and compiler flags when testing a separate development
build.
