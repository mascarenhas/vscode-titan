# Native builds

This page owns the build system: SDK selection, the Make object graph, build
profiles, test execution, packaging inputs, CI and the experimental Windows
driver. For the user-facing commands, see the
[README](../README.md#build-and-test). `make help` lists the main targets.

## SDK selection

The build consumes an installed Titan SDK. `TITAN_PREFIX` selects its prefix.
Otherwise `scripts/titan-sdk.mjs` runs `titanc --print-root` from `PATH`. It
retries `--print-prefix` only when an older 0.6 release SDK rejects the new
option. The compiler finds its installed provider through `package.cpath` on
both Unix and Windows. The selected SDK supplies the compiler, the Lua
interpreter, the compiler's LuaRocks dependencies, headers, the standard-library
providers and `share/titan/LICENSE`. No Titan checkout or project-owned compiler
installation is needed:

```sh
make -j2 server TITAN_PREFIX="$HOME/.local/titan"
```

The SDK is immutable during consumer builds. In the compiler's environment
(`NATIVE_COMPILER_ENV` in the `Makefile`), `TITAN_ROCKS_ROOT` selects the
installed SDK assets. A child-only `TITAN_PREFIX` points C probes at the
writable `BUILD_ROOT/compiler-cache`. Prepare and update SDKs with Titan's own
installation workflow. On Linux that workflow needs Readline development
headers, or `LUA_PLATFORM=linux` to omit Readline. Use separate prefixes and
Titan build checkouts for production and validation SDKs.

Titan's system OpenSSL mode needs the host's OpenSSL 3 development files and
`pkg-config`. Set `OPENSSL_PKG_CONFIG` to use another pkg-config command. An
SDK with an `include/openssl` directory is a bundled-OpenSSL SDK: its provider
already carries the OpenSSL archive, and system SDKs omit that directory. For
a system SDK, Make repeats the ordered OpenSSL libraries after the native
objects and the standard archive at both final links. The effective OpenSSL
include and link flags, and the OpenSSL headers, take part in invalidation,
including inputs outside the SDK tree.

On macOS, put GNU Make 4.4.1 first on `PATH`, including for recursive `make`
invocations. Apple Make 3.81 can keep a stale generated include graph during
incremental checks. The Makefile does not check the Make version. With
Homebrew:

```sh
export PATH="$(brew --prefix make)/libexec/gnubin:$PATH"
```

macOS validation includes a native Apple Silicon M1 run, including the arm64
VSIX and Extension Host smoke tests. Use an SDK built for the host architecture.

## Object and link ownership

Authored sources stay under `src/`. The persistent stage trees
`BUILD_ROOT/server-src` and `BUILD_ROOT/test-src` (default `.build/`) hold the
staged sources plus generated C, objects and headers. Only changed staged
inputs are replaced. The build never clears these trees on its own and never
writes beside authored sources.

`scripts/generate-native-build.lua` parses each module with
`titan-compiler.parser` and reads its top-level imports and folder-module
constituents. It writes `BUILD_ROOT/native-modules.mk`. Titan source inside
fixture strings is therefore not an import of the enclosing test module.
Direct module dependencies decide which object recipes can run in parallel.
Make also tracks project C headers, generated producer companions, compiler
and SDK inputs, the configuration stamp `BUILD_ROOT/native.config` and the
source inventory.

Compilers with `driver.parse_parts_companion` publish a `.parts` inventory.
The graph preserves its `.partN.c`, `.partN.o` and `.priv.h` outputs, checks
them before reusing an object, and prunes them when the module disappears.
Changing `TITAN_C_PARTS` invalidates the configuration. Older SDKs keep their
single-object graph. Only stable companions participate in Make prerequisites
and postcompile checks, because recompilation may shrink the part inventory.

Each object recipe runs `titanc --static --source-first --incremental -j1 -c`;
test objects add `--test`. Make owns the parallelism, so `make -j2` means two
compilation slots, not two multithreaded compiler pipelines. The final links
reuse the objects with `--incremental`:

- `server` links `titan_language_server` with `--static --source-first` and
  installs it at `SERVER` (default `bin/titan-language-server`).
- `server-test-build` links `server.tests` with
  `--static --test --source-first --no-uv-bootstrap`. The compiler discovers
  test cases from the current objects.

`server-objects` and `server-test-objects` stop before linking. Native payloads
belong only at the final links: the exported Lua API flag (`-Wl,-E` on Linux,
`-Wl,-export_dynamic` on macOS), `compiler_io_clock.o`, the generated
embedded-interface object and the standard-library archive. Both graphs use
the ordinary installed provider, including compiled `titan.test`. The SDK needs
no Titan test sources, and the build compiles no special test-support module.
The production and test graphs stay separate, so their source stages, flags
and generated outputs can change independently.

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
flags follow the profile defaults. The configuration stamp records the
profile, compiler and SDK paths and the flag inputs, so switching profiles
rebuilds both graphs.

## Test execution

Lua derives its default module paths from its executable's location, and the
test executable lives under `BUILD_ROOT/tests`, outside the SDK's `bin`. The
execution targets (`NATIVE_TEST_ENV`) therefore follow Titan's own test harness:

1. Ask the selected `$(TITAN_LUA)` with `-E` for `package.path` and
   `package.cpath`.
2. Pass the answers as `LUA_PATH_5_5` and `LUA_CPATH_5_5`.
3. Unset `TITAN_PATH_0_6` and `TITAN_PATH`, so an unrelated provider cannot
   override the selected SDK.

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

## Rebuild behavior

An unchanged build keeps the timestamps of generated objects, headers and
executables. Changing a module rebuilds it and its importing closure;
unrelated branches stay reusable. A changed authored C header conservatively
invalidates all project objects. Added or removed constituents and changed
imports update the graph. Changed test cases rebuild their owner and regenerate
the runner.

The compiler's `--incremental` check compares only source and object
timestamps. The Make rules own flags, dependency objects, header contents and
compiler and SDK inputs, so use consistent `CC`, preprocessing, C and linker
flags within each graph. Missing generated companions are repaired through
their producer rules, not accepted as a complete build.

## Concurrent builds and packaging

One Make invocation owns a build directory. Independent concurrent builds in
one checkout need separate `BUILD_ROOT` values and, when they link servers,
separate `SERVER` destinations. Object-only and test-only builds need only
separate build roots.

`package` temporarily installs the selected `SERVER` at
`bin/titan-language-server` for `vsce` and restores the previous file
afterward. Run packaging jobs one at a time in a checkout. `make clean` removes
`BUILD_ROOT`, `SERVER`, `dist` and `dist-test`.

`npm run compile`, used by `extension` and `package`, runs
`scripts/stage-lua-modules.mjs`. That script copies four SDK trees under
`dist/titan/`:

- `share/lua/5.5` and `lib/lua/5.5`, restricted to an exact root allowlist;
- `include`;
- `src/lua-5.5.1`.

It then checks the copies byte for byte against the SDK. The allowlist
(`EXPECTED_SHARE_ROOT` and `nativeRootInventory` in
`scripts/stage-lua-modules.mjs`) keeps the compiler and its LuaRocks-installed
dependencies and leaves out LuaRocks's own modules and unrelated packages. No
`lib/titan` tree or provider archive is staged. `scripts/stage-notices.mjs`
collects licenses from the installation, using the rock versions and license
files in `compilerRocks` (`scripts/compiler-rocks.mjs`). `scripts/inspect-vsix.sh` and
`scripts/inspect-server.sh` check the package and the executable's native
linkage. `inspect-server` enforces `TITAN_MAX_GLIBC_VERSION` when it is set.

## Build regressions

`make incremental-build-test` (`scripts/test-incremental-build.mjs`) builds
small real Titan and C fixtures through this Makefile in a private source and
build tree. It checks:

- that unchanged builds keep timestamps and invoke the compiler zero times;
- importing-closure rebuilds and folder and import changes;
- header, OpenSSL, compile-flag and link-flag invalidation;
- changed test discovery and repair of missing generated companions;
- split-output repair, part-count changes, source shrinkage and module removal
  when the selected compiler supports `.parts`;
- native test execution with absent and with unrelated ambient Titan paths;
- a production build, then the return to validation.

Run it when you change Make rules or the compiler release.

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

1. **SDK.** Restore `.titan-validation` from the cache. The cache key covers the
   Lua, LuaRocks and Titan release versions, the build policy and a hash of the
   absolute prefix. There are no fallback keys, so another release is never a
   hit. On a miss, build Lua 5.5.1 from the
   [`v5.5.1-1` archive](https://github.com/mascarenhas/lua-5.5.1/archive/refs/tags/v5.5.1-1.tar.gz)
   and [LuaRocks](https://luarocks.org/#quick-start) 3.13.0. Then download the
   [Titan 0.6 source rock](https://github.com/mascarenhas/titan/releases/download/v0.6.0/titan-0.6.0-1.src.rock)
   and install it with `TITAN_BUILD_PROFILE=validation`. If the
   `TITAN_RELEASE_TOKEN` secret is set, the download uses
   `gh release download` with it; otherwise it uses the public release URL.
   Before caching, check the installation's files, its recorded build profile
   and `titanc --print-prefix`.
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

`scripts/build-windows.mjs` accepts the targets `plan`, `server`,
`server-test-build`, `server-test-run`, `stage` and `package`. From PowerShell,
with native Node on `PATH`:

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

`--sdk` or `TITAN_PREFIX` overrides discovery through `titanc` on `PATH`. SDK
prefixes with spaces or Unicode characters are supported. The resource
compiler is the `llvm-rc.exe` beside `--clang`. `--build-root` (default
`.build\windows`) and `--source-root` accept absolute paths.
`server-test-run --filter PATTERN` runs an existing aggregate with Titan's
test filter.

The driver starts native executables directly, without a shell. Each compiler
command runs the SDK's `bin/lua.exe -E` on the installed
`lib/luarocks/rocks-5.5/titan/0.6.0-1/bin/titanc` script (`windowsCompilerCommand`
in `scripts/build-windows.mjs`), so LuaRocks' batch wrapper is not needed. The
driver inherits the parent environment, removes conflicting Lua and Titan
search overrides and sets compiler paths only for its children. It installs
nothing and never changes the global `PATH`, accounts, privileges or execution
policy. The build writes only its own stages and outputs and the extension's
packaged payload.

`server-test-build` and `server-test-run` default to the `validation`
profile: `-O0 -fno-lto` for generated Titan code and native helpers, with no
LTO at link time. `server`, `stage` and `package` default to `production`,
which keeps the compiler's optimized defaults and builds the helpers at `-O3`.
The selection order is `--build-profile`, then `VSCODE_TITAN_BUILD_PROFILE`,
then `TITAN_BUILD_PROFILE`. Explicit `TITAN_EXTRA_CPPFLAGS`, `TITAN_EXTRA_CFLAGS`
and `TITAN_EXTRA_LDFLAGS` follow the profile defaults, and the driver splits
them with the compiler's own argument parser. The test aggregate reserves an
8 MiB stack (`-Wl,--stack,8388608` in `windowsApplicationLinkFlags`), which
matches Titan's stdlib harness: the unoptimized validation tests round-trip
protocol JSON through 128 nested containers. Explicit `TITAN_EXTRA_LDFLAGS`
come after that reserve and can override it.

The profile is part of the object and compiler-probe identities. A
`build.lock` file keeps two drivers from mutating the same build root. The
compiler graph comes from the same `generate-native-build.lua` plan as on Unix.
Windows builds the graph serially (`TITAN_JOBS=1`) and hashes source
constituents, headers, compiler and SDK inputs, dependency fingerprints and
effective settings. Compiler probes live under the build root in a
configuration-keyed cache. Test execution sets `TITAN_PROBE_CACHE_DISABLE=1`,
because independent fixtures may reuse header names. Production and test
objects use separate stages and native-helper directories.

The driver checks each stage's split companions from the generated plan's
`outputs` inventory before reusing an object. Missing files force the owner to
rebuild, and `TITAN_C_PARTS` changes invalidate its configuration. Postcompile
checks use only the stable inventory, allowing part counts to shrink.

The application is `bin/titan-language-server.exe` plus
`lib/titan/0.6/titan_language_server.dll` and `lib/titan/0.6/titan.dll`.
`lua55.dll` and five native runtime DLLs (`libuv-1.dll`, `libllhttp-9.4.dll`,
`libsqlite3-0.dll`, `libssl-3-x64.dll`, `libcrypto-3-x64.dll`) live in `bin`.
`lfs.dll`, `lpeglabel.dll` and `luv.dll` live in `dist/titan/lib/lua/5.5`.
Windows never packages a static Titan provider archive. The launcher can be
renamed within `bin` without changing logical module identity. Staging also
copies the compiler's Lua sources, the SDK headers and the matching Lua
sources. Staging and package inspection accept the libbacktrace header pair
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

### Windows embedded interfaces

On Windows the generator emits only the C type profile
(`--windows-profile`). `src/server/embedded_interfaces_windows.c` reads the
callable metadata from the standard-provider DLL that is actually loaded. It
checks every interface's ABI value before it invokes any Lua metadata callback.
It opens the provider with `FILE_SHARE_READ` only, which denies write and delete
sharing, and it confirms that the handle names the mapped provider image. The
provider's identity is built from the handle's canonical path, its volume and
file identifiers and its 100 ns timestamps. If construction fails, the handle
is closed immediately. Restart the server before you update or replace its
loaded standard provider.

### Windows packaging

Compiler dependency notices come from the installed LuaRocks rockspecs,
`rock_manifest` ownership and checksums, and license files in the selected SDK
(`compilerRocks` in `scripts/compiler-rocks.mjs`). Staging verifies the
selected versions and the deployed module and license bytes. Windows `luv`
1.52.1-0 carries its Apache 2.0 license. The notices for its statically bundled
libuv are Titan's `LICENSES/libuv-LICENSE`, `libuv-LICENSE-extra`,
`libuv-tree-LICENSE` and `libuv-inet-LICENSE`.

`scripts/inspect-windows-package.mjs` verifies the `win32-x64` VSIX target,
the exact DLL and EXE inventory, the compiler and SDK bytes and the PE
imports. The system-import allowlist (`systemDlls`) includes libuv's
`api-ms-win-core-synch-l1-2-0.dll` synchronization contract, documented by
[Microsoft's WaitOnAddress reference](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitonaddress).
Unreviewed API sets and compiler runtime DLLs fail inspection. Signing and
publishing are separate operations.

### Windows validation gates

Native process tests, SQLite cache reopen tests, stdio protocol tests, package
inspection and an interactive Extension Host (F5) session are separate gates. A
successful plan, a DLL helper test or an SSH-launched `code` command does not
establish them. Symlink checks skip when the account lacks symlink privilege.

For F5, the interactive account needs read and execute access to the SDK and
the tool prefix. It also needs its own writable workspace, build output, Node
dependencies, VS Code user state and analysis cache. Use a protected shared
tool installation or per-user copies; do not broaden another account's profile
permissions. Set `TITAN_PREFIX`, `CC`, `AR`, `RANLIB`, `RC` and the native Node
and tool `PATH` in the process that launches Code. The `npm: compile`
pre-launch task then stages the selected SDK's compiler payload. The Windows
launch configuration in `.vscode/launch.json` clears `TITAN_PREFIX` only in the
Extension Host, so the server uses its normal `.titan-ls` probe cache. Keep the
workspace on writable guest-local NTFS, and build the native server first.

Notifications on shared folders are best effort. Live file access is required,
but watcher correctness is validated only on guest-local NTFS, and a shared
folder may need an explicit refresh.
