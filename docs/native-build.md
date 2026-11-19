# Native builds

This page owns the build system: SDK selection, compiler-owned native builds,
profiles, test execution, packaging inputs, CI and the experimental Windows
driver. For the user-facing commands, see the
[README](../README.md#build-and-test). `make help` lists every target.

## SDK selection

The build consumes an installed Titan SDK. `TITAN_PREFIX` selects its prefix.
Otherwise `scripts/titan-sdk.mjs` runs `titanc --print-root` from `PATH`. It
retries `--print-prefix` only when an older 0.6 release SDK rejects the new
option. The selected SDK supplies the compiler, the Lua interpreter, the
compiler's LuaRocks dependencies, headers, the standard-library providers, the
runtime archive and `share/titan/LICENSE`. The compiler resolves Titan modules
through its Titan path, never through `package.cpath`; Lua's own native-module
path reaches only the SDK's `lib/lua/5.5`, where the `titan` support module is an
ordinary Lua C module. No Titan checkout or project-owned compiler installation
is needed:

```sh
make -j2 server TITAN_PREFIX="$HOME/.local/titan"
```

The SDK must support compiler-owned incremental builds, `--output`, `--exe`
and `--c-source`. It is immutable during consumer builds. In the compiler's
environment (`COMPILER_ENV` in the `Makefile`), `TITAN_ROOT` selects the
installed SDK assets. A child-only `TITAN_PREFIX` points C probes at the
writable `BUILD_ROOT/compiler-cache`. Prepare and update SDKs with Titan's own
installation workflow. On Linux that workflow needs Readline development
headers, or `LUA_PLATFORM=linux` to omit Readline. Use separate prefixes and
Titan build checkouts for production and validation SDKs.

Titan's system OpenSSL mode needs the host's OpenSSL 3 or 4 development files and
`pkg-config`. Set `OPENSSL_PKG_CONFIG` to use another pkg-config command. An
SDK with an `include/openssl` directory is a bundled-OpenSSL SDK: its provider
already carries the OpenSSL archive, and system SDKs omit that directory. For
a system SDK, Make passes the ordered pkg-config flags as `--cflag` and
`--ldflag` switches. Titan certifies their effective arguments, header inputs
and linked libraries; Make maintains no SDK or OpenSSL header inventory.

The `Makefile` needs GNU Make 4.2 or newer. It reads `.SHELLSTATUS` during SDK
discovery, which is the newest feature it uses, and it refuses older versions
before that discovery runs. CI's Ubuntu 24.04 runner satisfies this with its
stock 4.3. macOS ships GNU Make 3.81 as `/usr/bin/make`, so install Homebrew's
`make` and put it first on `PATH`:

```sh
export PATH="$(brew --prefix make)/libexec/gnubin:$PATH"
```

GNU Make 4.4 or newer additionally gives the compiler a FIFO jobserver it can
share with this Make process; on Linux the compiler also shares an older pipe
jobserver by reopening it privately. Older versions leave Titan on its local
`--jobs` cap, which changes scheduling and not correctness.

macOS validation includes a native Apple Silicon M1 run, including the arm64
VSIX and Extension Host smoke tests. Use an SDK built for the host architecture.

## Object and link ownership

Authored server sources stay under `src/`. Every compiler invocation uses `--tree`
for those original sources and `--output` for an owned generated tree:
`BUILD_ROOT/server` or `BUILD_ROOT/tests` (default `BUILD_ROOT=.build`).
There are no source mirrors, generated Make includes, module targets, Windows
JSON module plans or configuration stamps.

`server` always invokes one compiler on `titan_language_server`:

```sh
titanc --tree src --output .build/server --source-first --incremental \
  --static --exe bin/titan-language-server \
  -I src/server --c-source src/server/compiler_io_clock.c \
  --c-source .build/native/embedded_interfaces_native.c titan_language_server
```

Make supplies the selected SDK environment, exported Lua API linker flag
(`-Wl,-E` on Linux, `-Wl,-export_dynamic` on macOS), explicit standard archive
and applicable OpenSSL switches in addition to this sketch. The embedded
interface C refers to `luaopen_titan` directly, so the final link extracts the
metadata-free support member from the SDK's `lib/titan/0.6/libtitan.a`; the
server preloads that table as `require "titan"` and never loads it from
`package.cpath`. `SERVER` can select another executable destination without a
post-link move or copy. `TITAN_FLAGS=-v` exposes certification misses and
native commands.

`server-test-build` similarly invokes one compiler on `server.tests`, using
`--test --no-uv-bootstrap --exe .build/tests/server/tests`. The existing
aggregate imports select its test owners; no automatic directory discovery is
needed. `server-objects` and `server-test-objects` use the same source/output
selection with `-c` and omit link-only inputs. All Unix builds select the
ordinary installed static provider, including compiled `titan.test`, without
requiring Titan test sources or a special support module.

Titan discovers and schedules the requested import closure and certifies
objects, native C inputs and final outputs. `TITAN_JOBS` or `--jobs` through
`TITAN_FLAGS` bounds compiler work; supported parent Make jobservers share that
budget. The production and test output trees remain separate.

Make still runs `scripts/generate-embedded-interfaces.lua` when its generator
or selected standard archive changes. The generated C is a `--c-source`
input, as is `compiler_io_clock.c`; Titan owns their object/header
certification. The pure-C `compiler_io_process_fixture` executable stays
Make-owned. Its prerequisites are authored inputs, not installed compiler
mtimes. Packaging, npm, installation and test execution also remain outside
the compiler.

## Build profiles

`BUILD_PROFILE` covers the whole Make invocation. `TITAN_BUILD_PROFILE` from
the environment supplies a default, and Make exports the result to children:

- `production`, the default for `all`, `server`, `package` and
  `install-server`: `-O3` with the compiler's platform LTO defaults, adding
  `-flto=auto -ffat-lto-objects` on Linux.
- `validation`, selected automatically by the goals in `VALIDATION_GOALS`
  (`test`, `verify`, the `server-test*`, `server-coverage*` and protocol targets,
  `extension-host-test`, `incremental-build-test` and `install-server-test`):
  `-O0 -fno-lto` for the server, test modules, native helpers and final links.

Because the profile covers the whole invocation, `make verify` also packages a
validation-built server. To iterate on the server alone:

```sh
make -j2 server BUILD_PROFILE=validation
```

The profile never changes the SDK's prebuilt providers, Lua or compiler
dependencies. To validate standard-library providers with the same flags,
prepare a separate validation SDK and select it with `TITAN_PREFIX`. A
production SDK also works for consumer validation. Explicit `TITAN_EXTRA_*`
flags follow the profile defaults and remain supported ambient compiler inputs.
Titan's configuration certificate detects profile, toolchain and flag changes
without a Make configuration stamp.

## Test execution

Lua derives its default module paths from its executable's location, and the
test executable lives under `BUILD_ROOT/tests`, outside the SDK's `bin`. The
execution targets (`TEST_ENV`) therefore follow Titan's own test harness:

1. Ask the selected `$(TITAN_LUA)` with `-E` for `package.path` and
   `package.cpath`.
2. Pass the answers as `LUA_PATH_5_5` and `LUA_CPATH_5_5`.
3. Unset `TITAN_PATH_0_6` and `TITAN_PATH`, so an unrelated provider cannot
   override the selected SDK, and pass the selected SDK as `TITAN_ROOT`. The
   runtime default then keeps the executable-relative roots and falls back to
   `TITAN_ROOT`'s providers without starting a compiler.

The executable embeds no SDK path. Run the tests through the Make targets;
running them directly needs the same queried paths.

Protocol and Codex test servers receive the native build's selected `CC` and
effective preprocessing flags through `SERVER_TEST_ENV`, including system
OpenSSL's pkg-config includes. Live analysis can therefore resolve headers
from installations such as Homebrew without changing project configuration.

`server-test` runs the aggregate serially. `server-test-sharded` runs the
same executable in two parallel shards through `scripts/run-server-tests.mjs`.
`serverTestShards` there assigns each test module to exactly one shard.
`validateShards` fails when a module imported by `src/server/tests.titan` is
unassigned or assigned twice. Per-shard logs and `summary.json` go to
`.build/test-shards`. `server-test-run` runs the current aggregate without
rebuilding it.

Before VS Code starts, `.vscode-test.js` calls `prepareExtensionHostWorkspace`
in `scripts/extension-host-workspace.mjs`. The same config serves
`make extension-host-test`, direct `vscode-test` and the prepared
`scripts/run-extension-host-tests.mjs` runner. Folder settings, markers,
`.titan-ls` caches, VS Code user data and installed test extensions are private
to the invocation. Cleanup runs after VS Code closes. A killed run may leave
its directory behind, but no later run reuses it. Run Electron gates serially.
Set `TITAN_LSP_TEST_CODE` to the absolute path of an installed VS Code executable
to use the same config without downloading VS Code.
Lifecycle tests identify the fake server instance by its private loopback
listener and a per-process token, not by a PID which the OS may reuse. The
prepared native-server test uses the proxy's joined child-close receipt.

Router lifecycle tests also use `test/fixtures/router_worker_fixture.titan`, a
framed child peer built with the server's `framing` and `wire` modules. Make
invokes Titan with `--tree 'src;test/fixtures' --source-first --incremental`,
outputs under `BUILD_ROOT/router-worker`, and puts the executable at
`BUILD_ROOT/native/router_worker_fixture`. Native, protocol and coverage build
targets build this prerequisite; their execution environments pass its path as
`TITAN_ROUTER_WORKER_FIXTURE`. Direct filtered runs need that path too.
The peer always imports this checkout's server sources, even when `SOURCE_ROOT`
selects another application for an incremental-build test.

The final component of the worker's existing `--root` argument selects its
scenario: accept/reject initialize, exit before/during initialize or shutdown,
withhold indexing or shutdown, fail the first replay, exit during replay, or
keep alive after input EOF. `progress-controlled` advances
counted initial and refresh passes with hover barriers.
The `refresh-blocked` scenario holds a pull request until an outer-root hover,
allowing deterministic nested discovery and release/reclaim during busy.
`--router` serves the production router with this executable as its worker.
Neither the fixture nor its scenarios add a shipped-server option or an
environment-selected behavior. It is a test-only build product and is never
installed or included in the VSIX.

The protocol suite also verifies the [browser analysis fixture](../test/fixtures/browser-analysis/README.md).
It checks genuine Wasm interface metadata in a disposable SDK directory,
without running Emscripten. The fixture is for tests only and is excluded
from the VSIX.

## Rebuild behavior

An unchanged compiler invocation certifies and reuses module objects, native C
objects and the final executable without rewriting them. An implementation-only
producer edit recompiles that module, not consumers whose imported interfaces
are unchanged; changed public interfaces or copied C helpers invalidate their
consumers. A C header edit invalidates only code whose certified inputs changed.
Titan also owns folder membership, changed import closure, compiler/SDK/native
configuration, generated companions and final-link recovery. Use `TITAN_FLAGS=-v`
to inspect the actual misses rather than inferring them from Make prerequisites.

## Concurrent builds and packaging

Titan coordinates compiler invocations sharing an output tree and executable
destination with OS-backed locks. Make-owned generators, the process fixture
and packaging are separate ownership domains: independent Make processes still
need separate `BUILD_ROOT` values and server destinations. Packaging jobs in
one checkout remain serial.

`package` temporarily installs the selected `SERVER` at
`bin/titan-language-server` for `vsce` and restores the previous file
afterward. Run packaging jobs one at a time in a checkout. `make clean` removes
`BUILD_ROOT`, `SERVER`, `dist` and `dist-test`.

`npm run compile`, used by `extension` and `package`, runs
`scripts/stage-lua-modules.mjs`. That script selects five SDK trees under
`dist/titan/`:

- `share/lua/5.5` and `lib/lua/5.5`, restricted to an exact root allowlist;
- `include`;
- `src/lua-5.5.1`;
- `lib/titan-browser/0.6`, limited to `analysis-target`, `absent-modules` and `titan.a`.

It then checks the copies byte for byte against the SDK. The allowlist
(`EXPECTED_SHARE_ROOT` and `nativeRootInventory` in
`scripts/stage-lua-modules.mjs`) keeps the compiler and its LuaRocks-installed
dependencies, including `luv` on every platform, and leaves out LuaRocks's own
modules and unrelated packages. The allowlist names no `share/lua/5.5/titan`
tree: the standard modules are providers, not Lua sources. No native
`lib/titan` tree or archive is staged in this payload. The browser archive
supplies interfaces only; no Wasm runtime or Emscripten tools are shipped.
`scripts/stage-notices.mjs` includes the browser provider's licenses and
collects notices from the installed rocks (`scripts/compiler-rocks.mjs`).
`scripts/inspect-vsix.sh` and `scripts/inspect-server.sh` check the package
and the executable's native linkage. The VSIX inspector also validates the
full browser provider and exercises the extracted server without Emscripten.
`inspect-server` rejects dynamic language/runtime dependencies. A
system-OpenSSL SDK may link the OpenSSL 3 or 4 system libraries; a bundled-OpenSSL
SDK must not link OpenSSL dynamically. The inspection also enforces
`TITAN_MAX_GLIBC_VERSION` when it is set.

### Paired browser semantic pack

Use the source rock and `titan-0.6.0-1-browser-semantics.tar.gz` from the same
Titan release. Before building a package from a native-only SDK, provision it
with the companion and the recorded full Git commit and asset SHA-256 values:

```sh
node scripts/browser-semantic-pack.mjs --install "$TITAN_PREFIX" "$PACK" \
  "$PACK_SHA256" "$ROCK_SHA256" "$TITAN_COMMIT" production
```

Use `validation` instead of `production` for a deliberately built validation
companion. The offline verifier checks the compressed digest, exact regular
members, manifest pairing, notices from the installed rock and the compiler's
complete Wasm interface inventory. It installs only the three semantic files
in one directory rename and refuses an existing partial or different pack.
The package target never downloads or repairs inputs.

The checked-in smaller provider is for source-tree protocol tests, never
packaging. To exercise real foreign C work against an extracted package, set
`TITAN_LS_TEST_BROWSER_LIVE=1` and activate Emscripten 6.0.13 before inspection.
That adds live and offline cache transitions to the tool-free smoke.

## Build regressions

`make incremental-build-test` (`scripts/test-incremental-build.mjs`) is a small
application smoke. It builds a tiny server and native test through this
Makefile in a private source/output tree, runs both, checks an unchanged build,
and verifies that an implementation-only leaf edit preserves consumer objects.
It retains verbose compiler logs under `.build/incremental-smoke-*`.

The exhaustive module/header/configuration/failure/split-output contracts belong
to Titan's compiler suite, not a second application build-system implementation.
Run the smoke when changing Make rules or the selected compiler.

`make completion-protocol-test` drives completion through the real stdio
server. It covers unsaved folder members, isolation of saved dependencies,
UTF-16 edits, saved navigation, and a competing saved refresh against an
800-field dirty module. It is a prerequisite of `server-protocol-test`, which
then runs `scripts/test-server-protocol.mjs` and
`scripts/test-workspace-cache.mjs`. To test a separate development build, pass
the matching `BUILD_ROOT`, `SERVER` and compiler flags.

## Continuous integration

`.github/workflows/ci.yml` runs the single job `verify-linux-x64` on
`ubicloud-standard-2` (Ubuntu 24.04), with `BUILD_PROFILE=validation`,
`OPENSSL_MODE=system` and `TITAN_MAX_GLIBC_VERSION=2.39`. It runs on pushes to
`main`, on pull requests and on manual dispatch.

1. **SDK.** Resolve both exact assets, their SHA-256 values and the commit
   named by the release tag. Restore `.titan-validation` using a cache key
   covering the pair, the Lua and LuaRocks versions, the build policy and the
   absolute prefix. On a miss, install Lua 5.5.1, LuaRocks 3.13.0 and the
   digest-checked source rock with `TITAN_BUILD_PROFILE=validation`.
   Download the companion by asset ID even on a hit, verify it against the
   release and the installed compiler, and reject mismatched cached bytes.
   CI requires a production companion; its host compiler build can still
   use the validation profile. There are no fallback cache keys.
2. **Build and test.** Run `make -j2 server server-test-build`, then
   `server-test-sharded`, `incremental-build-test`, `server-protocol-test`,
   `codex-native-test`, `extension-test`, `shard-runner-test` and
   `xvfb-run -a make extension-host-test`.
3. **Package.** Build a disposable VSIX with `make package`, then run
   `inspect-vsix`, `inspect-server`, `plugin-validate` and
   `install-server-test`.
4. **Coverage.** Build and run the [covered aggregate](coverage.md) with
   `CC=gcc-14`, gcov 14 and gcovr 8.4 in HTML, LCOV and Cobertura formats. Upload
   the reports and logs as the `titan-language-server-line-coverage` artifact
   for 7 days.

CI needs no Titan checkout or deploy key. It publishes no VSIX or server
binaries, including on manual runs. A future release job must run only on
`main` after the tests pass. It must use a separate production SDK and cache
and rebuild the complete server with full optimization; validation binaries
must never become release artifacts. Release artifacts must be built on the
oldest supported Linux baseline, because packages inherit the build host's
glibc requirement.

## Experimental Windows build

Windows x64 builds use native Node.js 24, the MSYS2 CLANG64/UCRT tools and a
separately prepared Windows Titan SDK with the complete ABI-2 standard
provider. They do not use the Unix Make recipes. Prepare the SDK with Titan's
`Makefile.win` and an ordinary LuaRocks source-rock installation, following
the upstream
[Windows build guide](https://github.com/mascarenhas/titan/blob/master/doc/implementation/windows-build.md).
Its standard provider includes `titan.path`, and its compiler dependencies
include the stock `luv` rock for native process handling. Install the
JavaScript dependencies with native Windows npm in this checkout; do not reuse
a Linux `node_modules` tree.

`scripts/build-windows.mjs` accepts the targets `server`,
`server-test-build`, `server-test-run`, `stage` and `package`. From PowerShell,
with native Node on `PATH`:

```powershell
$sdk = 'C:\TitanSDK'
$tools = 'C:\CLANG64\bin'
$native = @('--sdk', $sdk, '--clang', "$tools\clang.exe",
            '--ar', "$tools\llvm-ar.exe", '--ranlib', "$tools\llvm-ranlib.exe")
node scripts/build-windows.mjs server @native
node scripts/build-windows.mjs server-test-build @native
node scripts/build-windows.mjs server-test-run @native
node scripts/build-windows.mjs package @native
```

`--sdk` or `TITAN_PREFIX` overrides discovery through `titanc` on `PATH`. SDK
prefixes with spaces or Unicode characters are supported. The resource
compiler is the `llvm-rc.exe` beside `--clang`. `--build-root` (default
`.build\windows`) and `--source-root` accept absolute paths.
`server-test-run --filter PATTERN` runs an existing aggregate with Titan's
test filter.

The driver starts native executables directly, without a shell. Each compiler
command runs the SDK's own `bin/titanc.exe` program (`windowsCompilerCommand` in
`scripts/build-windows.mjs`), which locates its installation root and the
`share/lua/5.5/titan-compiler/titanc.lua` frontend by itself; there is no batch
wrapper, `lua.exe` preamble or retained rock script to name. The driver inherits
the parent environment, removes conflicting Lua and Titan search overrides and
sets compiler paths only for its children. It installs nothing and never
changes the global `PATH`, accounts, privileges or execution policy. The build
writes only its own stages and outputs and the extension's packaged payload.

`server-test-build` and `server-test-run` default to the `validation`
profile: `-O0 -fno-lto` for generated Titan code and native helpers, with no
LTO at link time. `server`, `stage` and `package` default to `production`,
which keeps the compiler's optimized defaults and builds the helpers at `-O3`.
The selection order is `--build-profile`, then `VSCODE_TITAN_BUILD_PROFILE`,
then `TITAN_BUILD_PROFILE`. Ambient `TITAN_EXTRA_CPPFLAGS`, `TITAN_EXTRA_CFLAGS`
and `TITAN_EXTRA_LDFLAGS` remain compiler inputs. Only the Make-equivalent
pure-C process fixture needs the driver to split those flags. The test
aggregate adds an 8 MiB stack reserve with
`--ldflag=-Wl,--stack,8388608`: unoptimized validation tests round-trip protocol
JSON through 128 nested containers.

The driver invokes `titanc` once for the selected root with `--tree` on the
authored source, `--output` on its server/test tree, `--source-first`,
`--incremental` and `--exe`. It does not use `--static` on Windows. The clock
and generated Windows embedding profile are `--c-source` inputs; native
include/library switches select the SDK and crypto import library. Titan owns
module discovery, object/split-output completeness, configuration and link
certification, parallel scheduling and output-tree locks. No Windows JSON
module plan or application `build-state.json` is produced.

The driver's `build.lock` additionally protects generator/fixture/package work
outside the compiler. Compiler probes live under the build root. Test execution
sets `TITAN_PROBE_CACHE_DISABLE=1`, because independent fixtures may reuse
header names. Production and test outputs and native-helper directories remain
separate. DLL/license bundling and package inspection retain their existing
layout.

The application is `bin/titan-language-server.exe` plus
`lib/titan/0.6/titan_language_server.dll` and `lib/titan/0.6/titan.dll`.
The launcher is the generated executable; it preloads the application DLL and
statically links the runtime archive for the same `luaopen_titan` support the
Unix server links, so the payload needs no `lib/lua/5.5/titan.dll`.
`lua55.dll` and five native runtime DLLs (`libuv-1.dll`, `libllhttp-9.4.dll`,
`libsqlite3-0.dll`, `libssl-3-x64.dll`, `libcrypto-3-x64.dll`) live in `bin`.
`lfs.dll`, `lpeglabel.dll` and `luv.dll` live in `dist/titan/lib/lua/5.5`.
Windows ships no native static provider archive. It ships the same Wasm
semantic pack as Linux and macOS. The launcher can be renamed within `bin`
without changing logical module identity. Staging also copies the compiler's
Lua sources, the SDK headers and the matching Lua sources. Staging and
package inspection accept the libbacktrace header pair
`backtrace.h` and `backtrace-supported.h` only as a complete pair of regular
files, or both absent (`windowsBacktraceHeaders` in
`scripts/sdk-include-inventory.mjs`). They reject partial pairs, links and
unknown root entries.

### Windows CompilerIO

`src/server/compiler_io.titan` launches the compiler directly on Windows,
with child-only `os.with_env("LANG", "C")` and `os.with_env("LC_ALL", "C")`
options. A Windows launch failure reports `started=false` without an invented
exit code. A program that does launch and exits with 126 or 127 still reports
`started=true`. Unix launches through `/usr/bin/env LANG=C LC_ALL=C` instead and
treats exit codes 126 and 127 as "not started". `VSCODE_TITAN_WINDOWS` in
`compiler_io_platform.h` also selects Windows path separators. The wall clock
in `compiler_io_clock.c` uses `QueryPerformanceCounter` on Windows.

`test/fixtures/compiler-io-process.c` supplies the locale, binary-output,
nonzero-exit, delayed and large output, and cancellation fixtures. On Windows
it keeps the cancellation marker path in UTF-16 through `wmain` and `_wfopen`,
and the CLANG64 link uses `-municode`. Test execution passes the fixture's path
in `TITAN_COMPILER_IO_PROCESS_FIXTURE`.

The driver also builds the Titan router peer as a normal compiler-owned Windows
application under `tests/native/router-worker`, with its runtime/provider DLLs.
`server-test-run` passes `TITAN_ROUTER_WORKER_FIXTURE` to the native router cases.

### Windows embedded interfaces

On Windows the generator emits the build C type profile and the source of the
selected-SDK interface query (`--windows-profile`).
`src/server/embedded_interfaces_windows.c:ls_push_cache` reads the
callable metadata from the standard-provider DLL that is actually loaded. It
checks every interface's ABI value before it invokes any Lua metadata callback.
It opens the provider with `FILE_SHARE_READ` only, which denies write and delete
sharing, and it confirms that the handle names the mapped provider image. The
provider's identity is built from the handle's canonical path, its volume and
file identifiers and its 100 ns timestamps. If construction fails, the handle
is closed immediately. The support table itself does not come from that DLL:
`src/server/embedded_interfaces_windows.c` refers to `luaopen_titan` directly,
so the linker extracts the metadata-free support member from the SDK's
`lib/titan/0.6/libtitan.a`. Restart the server before you update or replace its
loaded standard provider.

`scripts/standard-interface-inventory.lua` owns the canonical module list and
queries ABI exports before type exports. The generator and the standalone
server use the same query. `selected_interfaces.read` runs the embedded
program in the selected SDK's `bin/lua.exe -E`. Results use a bounded binary
file and are decoded only after the helper exits successfully; stdout and
stderr are diagnostic streams, not metadata transport. The caller waits for
process and file retirement even on cancellation.

### Windows packaging

Compiler dependency notices come from the installed LuaRocks rockspecs,
`rock_manifest` ownership and checksums, and license files in the selected SDK
(`compilerRocks` in `scripts/compiler-rocks.mjs`). Staging verifies the
selected versions and the deployed module and license bytes. Windows `luv`
1.52.1-0 carries its Apache 2.0 license. The notices for its statically bundled
libuv are Titan's `LICENSES/libuv-LICENSE`, `libuv-LICENSE-extra`,
`libuv-tree-LICENSE` and `libuv-inet-LICENSE`.

`scripts/inspect-windows-package.mjs` verifies the `win32-x64` VSIX target,
the exact DLL and EXE inventory, compiler and SDK bytes, the browser pack
and its notices, and PE imports. It runs a browser analysis smoke from the
extracted ZIP. The system-import allowlist (`systemDlls`) includes libuv's
`api-ms-win-core-synch-l1-2-0.dll` synchronization contract, documented by
[Microsoft's WaitOnAddress reference](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitonaddress).
Unreviewed API sets and compiler runtime DLLs fail inspection. Signing and
publishing are separate operations.

### Windows validation gates

Native process tests, SQLite cache reopen tests, stdio protocol tests, package
inspection and an interactive Extension Host (F5) session are separate gates. A
successful compilation, a DLL helper test or an SSH-launched `code` command does
not establish them. Symlink checks skip when the account cannot create or
traverse the fixture links.
To qualify the Windows symlink case, run the Extension Host suite elevated
on local NTFS so the test can create and traverse its directory link.
Run the multi-root SDK cases in an elevated session on local NTFS so their
SDK farm symlinks can be created and traversed.

`scripts/test-server-protocol.mjs`, `scripts/test-workspace-cache.mjs`,
`scripts/test-multi-root.mjs` and `scripts/test-completion-protocol.mjs` each
take the built server executable as their first argument and need the
environment the Unix `SERVER_TEST_ENV` supplies. Set `TITAN_ROOT` to the
selected SDK, `TITAN_LS_LUA_PATH` to
`<sdk>/share/lua/5.5/?.lua;<sdk>/share/lua/5.5/?/init.lua`,
`TITAN_LS_LUA_CPATH` to `<sdk>/lib/lua/5.5/?.dll`, and
`TITAN_ROUTER_WORKER_FIXTURE` to the peer that `server-test-build` links at
`.build/windows/tests/native/router-worker/bin/router_worker_fixture.exe`.
`server-test-run` already gives the native aggregate `TITAN_ROOT` and both
fixtures, and the driver exports `LUA_PATH_5_5` and `LUA_CPATH_5_5` for it;
the stdio suites instead read the two `TITAN_LS_LUA_*` variables above. Clear
`TITAN_PREFIX`, which the server reads as an inherited probe prefix, so each
root keeps its own `.titan-ls` cache. The multi-root suite accepts one group
name as its second argument, so a failure can be rerun alone.

Run the automated `npm run test:vscode` gate from the interactive desktop
account with native Node and the compiler tools on `PATH`, `TITAN_PREFIX`
pointing to the SDK for staging, `TITAN_LSP_TEST_CODE` pointing to the installed
`Code.exe`, and `TITAN_LSP_TEST_SERVER` pointing to the freshly built
`titan-language-server.exe`. Do not run another Electron suite at the same time.

For F5, the interactive account needs read and execute access to the SDK and
the tool prefix. It also needs its own writable workspace, build output, Node
dependencies, VS Code user state and analysis cache. Use a protected shared
tool installation or per-user copies; do not broaden another account's profile
permissions. Set `TITAN_PREFIX`, `CC`, `AR`, `RANLIB`, `RC` and the native Node
and tool `PATH` in the process that launches Code. Titan parses those four tool
settings as shell words, so every value is a quoted forward-slash path such as
`"C:/tools/clang64/bin/clang.exe"`; a backslash path escapes the next character
instead of separating it ([Windows
compilation](https://github.com/mascarenhas/titan/blob/master/doc/language/modules.md#experimental-windows-compilation)).
The `npm: compile` pre-launch task then stages the selected SDK's compiler
payload. The Windows
launch configuration in `.vscode/launch.json` clears `TITAN_PREFIX` only in the
Extension Host, so the server uses its normal `.titan-ls` probe cache. Keep the
workspace on writable guest-local NTFS, and build the native server first.

Notifications on shared folders are best effort. Live file access is required,
but watcher correctness is validated only on guest-local NTFS, and a shared
folder may need an explicit refresh.
