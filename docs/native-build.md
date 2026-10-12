# Incremental native builds

The server and native test executable use [Titan PR #164](https://github.com/mascarenhas/titan/pull/164)'s
opt-in object mode plus [the cached-binding fix](https://github.com/mascarenhas/titan/pull/165).
The exact compiler revision is pinned in [the CI workflow](../.github/workflows/ci.yml).
Make owns the dependency graph and rebuild decisions; Titan restores source
metadata from current objects while compiling dependents and linking.

The build consumes an installed Titan SDK. `TITAN_PREFIX` selects its prefix;
otherwise `titanc` on `PATH` reports it with `--print-prefix`, using the
compiler's existing `package.cpath` provider discovery. The selected SDK supplies
the compiler, Lua interpreter, compiler dependencies, headers and providers.
No Titan checkout or project-owned compiler installation is required. For example:

```sh
make -j2 server TITAN_PREFIX="$HOME/.local/titan"
```

The SDK is immutable during consumer builds. Compiler C probes use
`BUILD_ROOT/compiler-cache`, rather than writing to the SDK. The compiler's
`TITAN_ROCKS_ROOT` selects its installed assets; the child-only `TITAN_PREFIX`
selects this writable probe-cache directory.

```sh
make -j2 server server-test-build
make server-test-sharded
```

Use `server-objects` or `server-test-objects` to build the corresponding object
graph without linking its executable. `server` links and installs the native
language server; `server-test-build` links the single test executable used by
both execution shards. `server-test-run` runs an already built test executable.

For opt-in production Titan line coverage, use the separate
`server-coverage` workflow in [coverage.md](coverage.md), or its separate
`server-coverage-build` and `server-coverage-run` phases. The covered native test
executable resets and reports its own counters. Compiler-owned `.coverage`
outputs stay separate from ordinary objects, so later production builds need no
coverage cleanup. Project module discovery includes unused production roots.

On macOS, put GNU Make 4.4.1 first on `PATH` before building, including for
recursive `make` invocations. With Homebrew's Make installed:

```sh
export PATH="$(brew --prefix make)/libexec/gnubin:$PATH"
make --version
```

Apple Make 3.81 can retain a stale generated include graph during incremental
checks. The local macOS validation used Intel x86_64; it does not establish
Apple Silicon runtime coverage.

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

Titan's system OpenSSL provider needs the selected host's OpenSSL 3 development
files and `pkg-config`. Make repeats its ordered OpenSSL libraries after the
native objects and standard archive at both final links. The installed SDK's
`include/openssl` directory identifies a bundled provider; that provider already
carries the OpenSSL archive payload. System SDKs omit the directory. Set
`OPENSSL_PKG_CONFIG` to select another pkg-config command when required.
Effective system include/link flags and OpenSSL headers participate in native
build invalidation, including inputs outside the SDK tree.

Production compilation and linking use `--static --source-first`; test objects
and their final link add `--test` consistently. Both graphs use the ordinary
installed standard-library provider, including compiled `titan.test`. The SDK
does not need to supply Titan test sources, and the consumer builds no special
test-support module. The final `--test --no-uv-bootstrap` command discovers cases
from the current objects and produces the runner. Production and test graphs
remain separate so their source stages, flags and generated outputs can change
independently.

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

Ordinary `server`, `package` and installation builds use
`BUILD_PROFILE=production`, with `-O3` and the compiler's platform LTO defaults
(fat LTO on Linux). Validation entry points (`test`, `verify`, native test,
protocol, extension-host and installation-smoke targets) automatically select
`BUILD_PROFILE=validation`: `-O0` without LTO for the server, test modules, native
helpers and final links. The selected SDK's already compiled providers, Lua and
compiler dependencies are unchanged. The whole Make invocation uses one profile,
including the ordinary server exercised by transcripts and disposable packages.
To build the server alone for quick iteration:

```sh
make -j2 server BUILD_PROFILE=validation
```

To validate standard-library providers with the same profile, prepare a separate
validation SDK with Titan's own installation workflow and select it with
`TITAN_PREFIX`. A production SDK is also supported for consumer validation; the
project's profile does not require the SDK to have been built with that profile.
Extra compiler and linker flags remain explicit overrides and follow the profile
defaults.
The configuration stamp includes the profile, compiler/SDK and flag inputs, so
switching either way rebuilds both graphs. The incremental gate also runs its
small fixture under production defaults and verifies the return to validation.

Routine CI explicitly prepares a validation SDK from the exact pinned Titan
commit before invoking the consumer build. It caches only that installation,
including its installed licenses, by commit, build policy and prefix identity.
It runs the complete validation profile and builds a disposable VSIX
only to inspect packaging. It uploads no VSIX or language-server binaries,
including on manual runs. A future release job must run only on `main` after
tests pass, use a separate production SDK/cache and rebuild the complete server
with full optimization; validation binaries cannot become release artifacts.

One Make invocation owns a build directory. Independent concurrent builds in
one checkout need separate `BUILD_ROOT` values and separate `SERVER` destinations
(the default is `bin/titan-language-server`). Object-only and test-only builds
need only separate build roots. Do not run multiple Make processes against the
same staged trees. Packaging temporarily stages the selected `SERVER` at
`bin/titan-language-server` for the VSIX, then restores the preceding file; run
packaging jobs sequentially in one checkout. `make clean` removes generated
state. Native test execution
remains split into the existing two shards, independently of object scheduling.

## Build regressions

`make incremental-build-test` builds small real Titan/C fixtures through this
Makefile in a private source/build tree. It checks unchanged timestamps and zero
compiler invocations, importing-closure rebuilds, folder/import changes, header
and flag invalidation, changed test discovery, and missing generated companions.
It also runs the native tests with absent and unrelated ambient Titan paths to
check that execution uses the selected SDK.
The fixture uses the validation profile for most checks, then exercises a small
production build and switches back. `make verify` builds and tests the full
server in validation; optimized defaults retain focused smoke coverage.

`make completion-protocol-test` exercises full document synchronization and
completion through the actual stdio server, including unsaved folder members,
saved dependency isolation, UTF-16 edits, and saved navigation. It reports cold
preparation and warm SQL selection timings separately, using an 800-field dirty
module and a competing saved refresh. This focused gate is also a prerequisite
of `server-protocol-test`, so CI and `make verify` include it. Pass matching
`BUILD_ROOT`, `SERVER`, and compiler flags when testing a separate development
build.

## Experimental Windows CompilerIO

The Windows CompilerIO path launches the compiler executable directly with
child-only `os.with_env("LANG", "C")` and `os.with_env("LC_ALL", "C")` options.
Unix retains its existing `/usr/bin/env` path. A Windows launch failure has
`started=false` without a fabricated child exit code; a successfully launched
program exiting with 126 or 127 remains `started=true`.

The source-private target constant also selects Windows path separators.
The existing native wall-clock boundary uses QueryPerformanceCounter on Windows;
public `os.clock` measures CPU time and `timer` has no monotonic clock query.
Linux and macOS retain their previous native clock implementations.

The portable `test/fixtures/compiler-io-process.c` executable supplies Windows
locale, binary-output, nonzero-exit, delayed/large-output, and cancellation
fixtures. Windows keeps the cancellation marker pathname in UTF-16 through
`wmain` and `_wfopen`; the CLANG64 fixture link uses `-municode`. Test execution
supplies its exact path through `TITAN_COMPILER_IO_PROCESS_FIXTURE`. Linux retains its existing shell-process
assertions. These source adaptations do not by themselves validate the complete
Windows language server, extension package, or interactive F5 workflow.

## Experimental Windows DLL build

Windows x64 uses native Node.js 24, the MSYS2 CLANG64/UCRT tools, and a separately
prepared Windows Titan SDK with the complete ABI-2 standard provider. It does
not use the Unix Make recipes. Supply an immutable SDK copy; the build writes
only its own source stages, outputs, and the extension's packaged payload.
Install JavaScript dependencies using native Windows npm in this checkout; do
not reuse a Linux `node_modules` tree.

Prepare that SDK with Titan's consolidated `Makefile.win` and ordinary
LuaRocks source-rock installation, following the upstream
[Windows build guide](https://github.com/mascarenhas/titan/blob/master/doc/implementation/windows-build.md).
Its standard provider includes `titan.path`; compiler dependencies include
the stock `luv` rock for native Windows process handling. Use separate SDK
prefixes and producer build directories when different provider profiles are
needed.

Windows uses the same prefix selection: `--sdk` or `TITAN_PREFIX` overrides
discovery from `titanc` on `PATH`. The selected compiler's `--print-prefix`
discovers its provider through `package.cpath`; it does not embed an installation
prefix in the compiler or runtime. An SDK whose prefix contains spaces or Unicode
characters is supported.

For example, from a normal PowerShell prompt with native Node on the process PATH:

```powershell
$sdk = 'C:\TitanSDK'
$tools = 'C:\CLANG64\bin'
$native = @('--sdk', $sdk, '--clang', "$tools\clang.exe",
            '--ar', "$tools\llvm-ar.exe", '--ranlib', "$tools\llvm-ranlib.exe")
node scripts/build-windows.mjs plan @native
node scripts/build-windows.mjs server @native
node scripts/build-windows.mjs server-test-build @native
node scripts/build-windows.mjs server-test-run @native
node scripts/build-windows.mjs package @native
```

The example locations must refer to the actual prepared SDK and tool prefix.
The driver starts native executables directly without a command shell. Compiler
commands invoke the selected SDK's `bin/lua.exe -E` with its installed
`lib/luarocks/rocks-5.5/titan/0.6.0-1/bin/titanc` script and native argument vector.
LuaRocks' installation-specific batch wrapper is not needed. The controlled Lua
runtime finds its compiler modules relative to the executable after relocation.
The driver inherits the parent environment, clears conflicting Lua/Titan search
overrides, and sets compiler paths only for its children. It neither installs
tools nor changes global PATH, accounts, privileges, or execution policy.

`server-test-build` and `server-test-run` default to the `validation` build
profile; `server`, `stage`, and `package` default to `production`. Validation
uses `-O0 -fno-lto` for generated Titan code and native helpers, with no LTO at
link time. Production retains the compiler's normal optimized defaults and
builds the native helpers at `-O3`. Select a profile explicitly with
`--build-profile validation|production` or `VSCODE_TITAN_BUILD_PROFILE`; the
shared `TITAN_BUILD_PROFILE` environment setting is also honored. Explicit
inherited `TITAN_EXTRA_CPPFLAGS`, `TITAN_EXTRA_CFLAGS`, and
`TITAN_EXTRA_LDFLAGS` follow profile defaults, preserving sanitizer and other
overrides. Native helper flags use the compiler's argument parser.

The Windows test aggregate also reserves an 8 MiB executable stack, matching
Titan's stdlib test harness. Its unbootstrapped validation tests round-trip
protocol JSON through 128 nested containers with unoptimized native frames.
Explicit `TITAN_EXTRA_LDFLAGS` follow this test-only reserve and can override it.
The server retains Titan's ordinary executable and Task stack policy; the stdio
transcript separately checks input at the same depth boundary on its Task.

The profile participates in object and compiler-probe identities. Test execution
uses the existing aggregate; build it with the selected profile first. The SDK
stays immutable: choose a separately prepared validation SDK when its standard
provider should also use validation flags, and a production SDK for packaging.

`--build-root` and `--source-root` accept absolute alternate paths;
`server-test-run --filter PATTERN` runs an existing aggregate with Titan's normal
test filter. A build-directory lock prevents two drivers from mutating the same
state. The compiler graph comes from the same parsed-import generator as Unix;
Windows executes the selected graph serially and hashes source constituents,
headers, compiler/SDK inputs, dependency fingerprints and effective settings.
Compiler probes live under the build directory in a configuration-keyed cache;
SDK/header/tool/flag changes select a fresh cache. Native test execution disables
persistent probe records because independent fixtures may reuse header names.
Missing generated companions force rebuilding. Production and test objects use
separate stages and separate native-helper directories. The default Unix graph
and recipes retain their existing static production behavior.

The application is `bin/titan-language-server.exe` plus
`lib/titan/0.6/titan_language_server.dll` and `lib/titan/0.6/titan.dll`.
The controlled Lua DLL and five native runtime DLLs live in `bin`; `lfs.dll`,
`lpeglabel.dll`, and `luv.dll` live in the compiler's `dist/titan/lib/lua/5.5` tree. Windows
never packages a static Titan provider archive. The build still stages the
compiler's Lua sources, SDK analysis headers, and matching Lua internal sources.
The tiny launcher can be renamed within `bin` without changing logical module
identity.

Fresh Windows runtime installations also include the paired libbacktrace SDK
headers, `backtrace.h` and `backtrace-supported.h`. Staging and package inspection
accept the complete regular-file pair or an older SDK that omits both, and
reject partial pairs, links, and unknown root entries. The packaged header tree
must still match the selected SDK byte for byte.

The Windows embedded-interface boundary reads callable metadata from the
**canonical, actually loaded standard provider**. All 23 plain-C ABI values are
checked before invoking any Lua metadata callback. The generated source contains
the C type profile, not a second serialized copy of the provider interfaces.
Provider path and identity use the retained native handle's canonical spelling,
complete volume/file identifiers and exact 100 ns timestamps. The handle denies
write/delete sharing and makes that transient identity snapshot immutable. The
boundary also verifies that this handle still names the mapped provider image.
Later Task-path revalidation compares
the full opaque identity and normalized provider pathname without synchronous
filesystem calls. Ordinary filesystem observations retain their existing async
path; the opaque field is not stored in SQLite and changes no cache schema.
Failed construction closes the handle immediately. Restart the server before
updating or replacing its loaded standard provider on Windows.

Compiler dependency notices come from the ordinary installed LuaRocks rockspecs,
`rock_manifest` ownership/checksums, and license files in the selected SDK.
Staging verifies the selected versions and deployed module/license bytes.
Windows `luv` 1.52.1-0 carries its Apache 2.0 license; its statically bundled
libuv notices are also included in Titan's `LICENSES/libuv-LICENSE`,
`libuv-LICENSE-extra`, `libuv-tree-LICENSE`, and `libuv-inet-LICENSE`. The unsigned
package target preserves these notices, then verifies the `win32-x64` VSIX
target, exact DLL/EXE inventory including `luv.dll`, compiler/SDK bytes and PE
imports. Its explicit Windows system imports include libuv's
`api-ms-win-core-synch-l1-2-0.dll` synchronization contract, documented by
[Microsoft's WaitOnAddress reference](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitonaddress).
The core API-set allowance uses that exact name; unreviewed contracts and
compiler runtime DLLs fail inspection. Signing and publishing are separate
operations.

Shared-folder notifications are best effort. Live file access is required, but
watcher correctness on a guest-local NTFS workspace is the supported validation
boundary; a shared folder may require an explicit refresh. Native process tests,
SQLite/cache reopen tests, stdio protocol tests, package inspection, and an actual
interactive Extension Host/F5 session are separate gates. A successful plan,
DLL helper test, or SSH-launched Code command does not establish those gates.

For F5, the interactive account needs read/execute access to the validated SDK
and the compiler tool prefix, plus its own writable workspace, build output,
Node dependencies, VS Code user state, and analysis cache. Use ordinary protected
shared tool installation or independent per-user copies. Do not broaden another
account's profile permissions. Set `TITAN_PREFIX`, `CC`, `AR`, `RANLIB`, `RC`, and the
native Node/tool PATH in the process launching Code; the existing F5 task then
stages the selected SDK's compiler payload. Its Windows debug-launch override
clears `TITAN_PREFIX` only in the Extension Host so the server selects its
normal project-owned `.titan-ls` cache; the prelaunch staging task retains the
selected SDK input. Keep the workspace on writable guest-local NTFS. Build the native
server first.
