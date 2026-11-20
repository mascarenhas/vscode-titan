# Appendix A: Build System, Static Providers, Testing, and Packaging

`Makefile` and [`scripts/build-windows.mjs`](../scripts/build-windows.mjs) own SDK selection, compiler-owned native builds, build profiles, test execution, packaging inputs, continuous integration, and the experimental Windows build. For quick-start commands, see the [README](../README.md); run `make help` for the complete target list.

## SDK selection

The build consumes an installed Titan SDK selected by `TITAN_PREFIX`. When `TITAN_PREFIX` is unset, [`scripts/titan-sdk.mjs`](../scripts/titan-sdk.mjs) invokes `titanc --print-root` from `PATH` (falling back to `--print-prefix` when an older 0.6 release SDK rejects `--print-root`). The SDK provides the compiler, Lua interpreter, compiler LuaRocks dependencies, headers, standard-library providers, runtime archive, and `share/titan/LICENSE`. The compiler resolves Titan modules solely through its Titan search path; Lua's `package.cpath` reaches only the SDK's `lib/lua/5.5`, where the `titan` support module lives as an ordinary Lua C module. No Titan checkout or local compiler build is required:

```sh
make -j2 server TITAN_PREFIX="$HOME/.local/titan"
```

The SDK must support compiler-owned incremental builds, `--output`, `--exe`, and `--c-source`, and remains read-only during consumer builds. In `COMPILER_ENV` ([`Makefile`](../Makefile)), `TITAN_ROOT` points to the installed SDK assets while a child-only `TITAN_PREFIX` directs C probes to the writable `BUILD_ROOT/compiler-cache`. Prepare production and validation SDKs in separate prefixes and Titan checkouts using Titan's installation workflow (on Linux, install Readline development headers or pass `LUA_PLATFORM=linux`).

System-OpenSSL SDKs require host OpenSSL 3 or 4 development headers and `pkg-config` (override with `OPENSSL_PKG_CONFIG`). An SDK containing `include/openssl` is a bundled-OpenSSL SDK whose static provider already embeds OpenSSL; system SDKs omit that directory, and Make queries `pkg-config` to pass ordered `--cflag` and `--ldflag` switches. Titan certifies those flags, header inputs, and linked libraries directly.

[`Makefile`](../Makefile) requires GNU Make 4.2 or newer because SDK discovery reads `.SHELLSTATUS` and guards the Make version before running discovery. Ubuntu 24.04 ships 4.3; on macOS, install Homebrew Make to replace `/usr/bin/make` 3.81 and place it first on `PATH`:

```sh
export PATH="$(brew --prefix make)/libexec/gnubin:$PATH"
```

GNU Make 4.4 or newer shares a FIFO jobserver with `titanc`; on Linux, `titanc` also shares an older pipe jobserver by reopening it privately. Older Make versions leave Titan on its local `--jobs` cap, affecting scheduling rather than correctness.

macOS validation runs natively on Apple Silicon, including arm64 VSIX packaging and Extension Host smoke tests, using a host-architecture SDK.

## Object and link ownership

Authored Titan sources reside under `src/`. Every compiler invocation passes `--tree` on those sources and `--output` on a dedicated generated tree (`BUILD_ROOT/server` or `BUILD_ROOT/tests`, defaulting `BUILD_ROOT` to `.build`), without source mirrors, generated Make includes, module-plan files, or Make configuration stamps.

`make server` invokes `titanc` once on `titan_language_server`:

```sh
titanc --tree src --output .build/server --source-first --incremental \
  --static --exe bin/titan-language-server \
  -I src/server --c-source src/server/compiler_io_clock.c \
  --c-source .build/native/embedded_interfaces_native.c titan_language_server
```

Make adds `COMPILER_ENV`, the Lua C API export linker flag (`-Wl,-E` on Linux, `-Wl,-export_dynamic` on macOS), the explicit standard archive (`lib/titan/0.6/titan.a`), and system OpenSSL switches when applicable. Because the generated embedding C references `luaopen_titan` directly, the link extracts the metadata-free support object from `lib/titan/0.6/libtitan.a`; the server preloads `require "titan"` from that symbol rather than loading `package.cpath`. Override `SERVER` to place the executable directly at another path, and pass `TITAN_FLAGS=-v` to inspect certification misses and native commands.

### Folder-module C header resolution

The server organizes its largest subsystems into five multi-file folder modules (`src/server/router/`, `src/server/application/`, `src/server/compiler_bridge/`, `src/server/project_service/`, and `src/server/semantic_features/`) whose files sit one level below `src/server/`. Modules across both depths import shared local C headers (`compiler_io_platform.h`, `compiler_io_clock.h`). Native builds supply `-I src/server` in `TITAN_COMPILE_OPTIONS` ([`Makefile`](../Makefile)), while [`titan-config.lua`](../titan-config.lua) declares the matching `extra_ffi_include_dirs = { "./src/server" }` so self-hosted language-server indexing resolves the exact same headers inside folder modules without duplicating paths.

### Test aggregate and white-box seams

`make server-test-build` invokes `titanc` once on [`src/server/tests.titan`](../src/server/tests.titan) with `--test --no-uv-bootstrap --exe .build/tests/server/tests`. Its explicit imports select all 41 test owners. `server-objects` and `server-test-objects` run the matching compile-only `-c` step. Unix builds link the ordinary installed static provider — including compiled `titan.test` — without special test-support builds.

Module boundaries follow a strict split between production code and tests:

- **Production modules** (`src/titan_language_server.titan` and all non-test modules under `src/server/`) import peer modules strictly through compiled public interfaces (`import "server.<name>"`).
- **Native test owners** (`src/server/*_test.titan`) selectively use white-box source imports (`import "server.<name>.titan"`) when testing `local` helpers, private constructors, or `*_for_testing` hooks without exposing test seams on the public module interface.

Titan discovers and schedules the full import closure and certifies objects, C sources, and linked executables. `TITAN_JOBS` or `--jobs` in `TITAN_FLAGS` bounds compiler parallelism, sharing a parent Make jobserver when available. Production and test output trees remain disjoint.

Make owns three non-Titan build artifacts: regenerating `embedded_interfaces_native.c` through [`scripts/generate-embedded-interfaces.lua`](../scripts/generate-embedded-interfaces.lua) when the generator, [`scripts/standard-interface-inventory.lua`](../scripts/standard-interface-inventory.lua), or `titan.a` changes; compiling the pure-C `compiler_io_process_fixture` executable from authored inputs; and running npm, packaging, installation, and test drivers. Both `embedded_interfaces_native.c` and `compiler_io_clock.c` enter `titanc` via `--c-source` so Titan certifies their object and header dependencies.

## Build profiles

`BUILD_PROFILE` governs an entire Make invocation, defaulting from `TITAN_BUILD_PROFILE` or from the requested goals, and Make exports the effective value to child processes:

- **`production`** (default for `all`, `server`, `package`, `install-server`): compiles with `-O3` and Titan's platform LTO defaults, adding `-flto=auto -ffat-lto-objects` on Linux.
- **`validation`** (selected automatically by `VALIDATION_GOALS`: `test`, `verify`, `server-test*`, `server-coverage*`, protocol targets, `extension-host-test`, `incremental-build-test`, and `install-server-test`): compiles server modules, tests, native helpers, and final links with `-O0 -fno-lto`.

Because one profile covers the entire invocation, `make verify` builds and packages a validation server. To iterate on a validation server binary alone:

```sh
make -j2 server BUILD_PROFILE=validation
```

The profile applies only to consumer compilation and leaves the SDK's prebuilt providers, Lua, and compiler dependencies untouched. Prepare a separate validation SDK and pass `TITAN_PREFIX` when validating providers with matching flags; a production SDK works for consumer validation as well. Ambient `TITAN_EXTRA_*` flags follow profile defaults, and Titan's configuration certificate detects profile, toolchain, and flag changes automatically.

## Test execution

Lua derives default module paths from its executable directory, whereas the test binary lives under `BUILD_ROOT/tests`. `TEST_ENV` ([`Makefile`](../Makefile)) therefore mirrors Titan's harness:

1. Query `$(TITAN_LUA) -E` for `package.path` and `package.cpath`.
2. Export those values as `LUA_PATH_5_5` and `LUA_CPATH_5_5`.
3. Unset `TITAN_PATH_0_6` and `TITAN_PATH`, and set `TITAN_ROOT` to the selected SDK so the executable keeps executable-relative lookup and falls back to `TITAN_ROOT` providers without invoking `titanc`.

Because the test binary embeds no SDK path, invoke it through Make or supply the same environment manually.

Protocol and Codex test targets run under `SERVER_TEST_ENV`, passing the build's `CC` and effective preprocessing flags (including system OpenSSL pkg-config includes) so live analysis resolves system headers such as Homebrew OpenSSL without altering workspace configs.

### Two-shard native runner

`make server-test` runs the native aggregate serially; `make server-test-run` runs the current executable without rebuilding. `make server-test-sharded` drives the same executable in two parallel processes via [`scripts/run-server-tests.mjs`](../scripts/run-server-tests.mjs):

- `serverTestShards` partitions all 41 test modules into two balanced shards (keeping heavy compiler-backed owners separated) and passes per-module `--filter` patterns to each child.
- `validateShards` parses [`src/server/tests.titan`](../src/server/tests.titan) before launch and fails if any imported test module is omitted or assigned to both shards.
- Each shard executes in its own fresh temporary working directory so compiler fixtures cannot collide; stdout/stderr logs (`shard-1.log`, `shard-2.log`) and `summary.json` are written to `.build/test-shards`, and teardown signals each shard's entire process group.

### Extension Host and router fixtures

Before VS Code launches, [`.vscode-test.js`](../.vscode-test.js) calls `prepareExtensionHostWorkspace` in [`scripts/extension-host-workspace.mjs`](../scripts/extension-host-workspace.mjs) (shared by `make extension-host-test`, direct `vscode-test`, and [`scripts/run-extension-host-tests.mjs`](../scripts/run-extension-host-tests.mjs)). Folder settings, markers, `.titan-ls` caches, VS Code user data, and installed test extensions are isolated per invocation and cleaned up after VS Code exits. Run Electron gates serially; set `TITAN_LSP_TEST_CODE` to an installed VS Code binary to avoid downloading VS Code. Lifecycle tests identify fake servers via a private loopback listener and per-process token rather than OS PIDs, and the native-server test awaits the proxy's joined child-close receipt.

Router lifecycle tests spawn [`test/fixtures/router_worker_fixture.titan`](../test/fixtures/router_worker_fixture.titan), a framed peer built with the server's `framing` and `wire` modules via `--tree 'src;test/fixtures' --source-first --incremental` into `BUILD_ROOT/router-worker` with executable `BUILD_ROOT/native/router_worker_fixture`. Native, protocol, and coverage builds supply its path in `TITAN_ROUTER_WORKER_FIXTURE`; the peer always imports this checkout's server sources regardless of `SOURCE_ROOT`. The final path component of `--root` selects its test scenario — accepting or rejecting `initialize`, exiting before or during lifecycle transitions, withholding indexing or shutdown, failing or exiting during overlay replay, keeping alive past EOF, advancing counted passes via hover barriers (`progress-controlled`), or holding a pull diagnostic until an outer-root hover (`refresh-blocked`). Passing `--router` serves the production router against this fixture. The fixture is strictly a test build artifact and is never installed or packaged.

The protocol suite also verifies the [browser analysis fixture](../test/fixtures/browser-analysis/README.md), validating genuine Wasm interface metadata in a disposable SDK directory without Emscripten; this fixture is excluded from VSIX packages.

## Rebuild behavior

Unchanged invocations certify and reuse module objects, C helper objects, and final executables without rewriting them. An implementation-only edit recompiles only that module while preserving consumers whose imported interfaces are unchanged; public interface or copied C helper edits invalidate affected consumers. C header edits invalidate only targets whose certified inputs changed. Titan tracks folder membership, import closures, compiler/SDK/flag configurations, companion outputs, and final-link recovery. Inspect exact misses with `TITAN_FLAGS=-v`.

## Concurrent builds and packaging

Titan serializes concurrent `titanc` invocations sharing an output tree or executable path using OS-backed locks. Make-owned generators, native fixtures, Electron runs, and packaging remain separate domains: independent Make invocations in one checkout require distinct `BUILD_ROOT` and `SERVER` values, and packaging jobs run serially.

When running `make verify` as a single command, parallelize compilation with `TITAN_FLAGS="-jN"` (or `TITAN_JOBS=N`) rather than top-level `make -j`:

```sh
xvfb-run -a make verify TITAN_FLAGS="-j4"
```

Top-level `make -j` would overlap `package` (which stages `dist/` and temporarily swaps `bin/titan-language-server`), `extension-test`, `extension-host-test` (which launches Electron), and `inspect-server` / `install-server-test` in the same checkout. `TITAN_FLAGS="-jN"` gives `titanc` full multi-core parallelism inside each compile step while keeping test suites, Electron, and packaging serial. Pure build goals such as `make -j2 server server-test-build` safely run with `-j2`.

`make package` temporarily places `SERVER` at `bin/titan-language-server` while `vsce` builds the VSIX and restores the previous file in its exit trap. `make clean` removes `BUILD_ROOT`, `SERVER`, `dist`, and `dist-test`.

`npm run compile` (invoked by `extension` and `package`) runs [`scripts/stage-lua-modules.mjs`](../scripts/stage-lua-modules.mjs) to copy five SDK trees under `dist/titan/` and verify them byte for byte:

- `share/lua/5.5` and `lib/lua/5.5`, restricted to `EXPECTED_SHARE_ROOT` and `nativeRootInventory` (the compiler and its pinned LuaRocks dependencies including `luv`, omitting LuaRocks itself and unrelated packages);
- `include`;
- `src/lua-5.5.1`;
- `lib/titan-browser/0.6`, limited to `analysis-target`, `absent-modules`, and `titan.a`.

No native `lib/titan` archive, `share/lua/5.5/titan` source tree, Wasm runtime, or Emscripten tool is staged. [`scripts/stage-notices.mjs`](../scripts/stage-notices.mjs) bundles browser provider licenses and rock notices verified through [`scripts/compiler-rocks.mjs`](../scripts/compiler-rocks.mjs). [`scripts/inspect-vsix.sh`](../scripts/inspect-vsix.sh) and [`scripts/inspect-server.sh`](../scripts/inspect-server.sh) validate package contents, browser provider metadata, offline extracted-server execution, and native linkage: rejecting dynamic language/runtime dependencies, allowing dynamic OpenSSL 3/4 only for system-OpenSSL SDKs, and enforcing `TITAN_MAX_GLIBC_VERSION` when set.

### Paired browser semantic pack

Pair the Titan source rock with `titan-0.6.0-1-browser-semantics.tar.gz` from the same release. Provision a native-only SDK with the companion's recorded Git commit and SHA-256 digests before packaging:

```sh
node scripts/browser-semantic-pack.mjs --install "$TITAN_PREFIX" "$PACK" \
  "$PACK_SHA256" "$ROCK_SHA256" "$TITAN_COMMIT" production
```

Pass `validation` for a deliberately built validation companion. The offline installer verifies the archive digest, exact regular members, manifest pairing, rock notices, and complete Wasm interface inventory, atomically moving only the three semantic files into place and refusing partial or conflicting installations. `make package` never downloads or repairs inputs.

The checked-in smaller browser fixture serves only source-tree protocol tests. To exercise live foreign C work against an extracted package, activate Emscripten 6.0.13 and set `TITAN_LS_TEST_BROWSER_LIVE=1` before running `inspect-vsix`.

## Build regressions

`make incremental-build-test` ([`scripts/test-incremental-build.mjs`](../scripts/test-incremental-build.mjs)) smoke-tests this Makefile in an isolated source/output tree, verifying initial build and run, unchanged reuse, and object preservation across an implementation-only leaf edit, keeping verbose logs under `.build/incremental-smoke-*`. Exhaustive compiler certification contracts live in Titan's own test suite.

`make completion-protocol-test` exercises unsaved folder members, saved-dependency isolation, UTF-16 edits, saved navigation, and a competing saved refresh against an 800-field dirty module over framed stdio. `make server-protocol-test` runs it as a prerequisite alongside [`scripts/test-server-protocol.mjs`](../scripts/test-server-protocol.mjs), [`scripts/test-workspace-cache.mjs`](../scripts/test-workspace-cache.mjs), and [`scripts/test-multi-root.mjs`](../scripts/test-multi-root.mjs). Pass matching `BUILD_ROOT`, `SERVER`, and compiler flags to test an alternate build.

## Continuous integration

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs `verify-linux-x64` on `ubicloud-standard-2` (Ubuntu 24.04) with `BUILD_PROFILE=validation`, `OPENSSL_MODE=system`, `TITAN_JOBS=2`, and `TITAN_MAX_GLIBC_VERSION=2.39` on pushes to `main`, pull requests, and manual dispatch:

1. **SDK:** Resolves exact release asset IDs, SHA-256 digests, and commit SHA for the release tag; restores `.titan-validation` under an exact cache key (no fallback keys) covering rock, pack, Lua 5.5.1, LuaRocks 3.13.0, pinned `compiler-rocks.mjs`, build policy, and prefix; installs on a miss with `TITAN_BUILD_PROFILE=validation`; re-downloads and verifies the production browser semantic pack on every run.
2. **Build and test:** Runs `make -j2 server server-test-build`, then serially runs `server-test-sharded`, `incremental-build-test`, `server-protocol-test`, `codex-native-test`, `extension-test`, `shard-runner-test`, and `xvfb-run -a make extension-host-test`.
3. **Package:** Runs `make package`, followed by `inspect-vsix`, `inspect-server`, `plugin-validate`, and `install-server-test`.
4. **Coverage:** Builds and runs the [covered aggregate](coverage.md) with `CC=gcc-14`, gcov 14, and gcovr 8.4 (HTML, LCOV, Cobertura), uploading reports and logs as `titan-language-server-line-coverage` for 7 days.

CI requires no Titan checkout or deploy key and publishes no binaries or VSIX packages. Release publishing belongs in a dedicated `main`-only job after validation passes, building from a separate production SDK on the oldest supported Linux glibc baseline with full optimization.

## Experimental Windows build

Windows x64 builds use native Node.js 24, MSYS2 CLANG64/UCRT tools, and a Windows Titan SDK containing the complete ABI-2 standard provider built via Titan's `Makefile.win` and LuaRocks source rock (see Titan's [Windows build guide](https://github.com/mascarenhas/titan/blob/master/doc/implementation/windows-build.md)), including `titan.path` and the stock `luv` rock. Install `node_modules` with native Windows npm rather than reusing a Linux tree.

[`scripts/build-windows.mjs`](../scripts/build-windows.mjs) drives `server`, `server-test-build`, `server-test-run`, `stage`, and `package` directly from PowerShell without Unix Make:

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

`--sdk` or `TITAN_PREFIX` overrides `titanc` discovery on `PATH`, supporting prefixes with spaces or Unicode characters. The driver locates `llvm-rc.exe` beside `--clang`, accepts `--build-root` (default `.build\windows`) and `--source-root`, and supports `server-test-run --filter PATTERN`.

Each compiler invocation launches `bin/titanc.exe` directly without a shell (`windowsCompilerCommand` in [`scripts/build-windows.mjs`](../scripts/build-windows.mjs)), scrubbing conflicting Lua and Titan search overrides in child environments while leaving global `PATH` and user state untouched. `server-test-build` and `server-test-run` default to `validation` (`-O0 -fno-lto`) and add `--ldflag=-Wl,--stack,8388608` (8 MiB stack reserve for unoptimized 128-deep JSON round-trip tests); `server`, `stage`, and `package` default to `production` (`-O3`). Profile precedence is `--build-profile`, `VSCODE_TITAN_BUILD_PROFILE`, then `TITAN_BUILD_PROFILE`. Ambient `TITAN_EXTRA_*` flags pass through to `titanc` (split by the driver only for the pure-C process fixture).

`titanc` runs once per target with `--tree`, `--output`, `--source-first`, `--incremental`, and `--exe` (omitting `--static`), taking the clock helper and generated Windows embedding profile as `--c-source` inputs. Titan owns module discovery, certification, scheduling, and output locks; `build.lock` protects generator, fixture, and packaging steps outside `titanc`. Compiler probes stay under the build root, and test runs set `TITAN_PROBE_CACHE_DISABLE=1` so independent fixtures can reuse header names.

The Windows application ships `bin/titan-language-server.exe` (renameable within `bin`), `lib/titan/0.6/titan_language_server.dll`, `lib/titan/0.6/titan.dll`, `lua55.dll`, and five runtime DLLs (`libuv-1.dll`, `libllhttp-9.4.dll`, `libsqlite3-0.dll`, `libssl-3-x64.dll`, `libcrypto-3-x64.dll`) in `bin`, plus `lfs.dll`, `lpeglabel.dll`, and `luv.dll` in `dist/titan/lib/lua/5.5`. The launcher statically links `luaopen_titan` from `libtitan.a`, omitting `lib/lua/5.5/titan.dll` and native static archives while shipping the same Wasm browser semantic pack as Unix. Staging and inspection accept `backtrace.h` and `backtrace-supported.h` (`windowsBacktraceHeaders` in [`scripts/sdk-include-inventory.mjs`](../scripts/sdk-include-inventory.mjs)) only as a complete regular-file pair or both absent.

### Windows CompilerIO

[`src/server/compiler_io.titan`](../src/server/compiler_io.titan) spawns `titanc` directly on Windows with child-only `os.with_env("LANG", "C")` and `os.with_env("LC_ALL", "C")`. Launch failures report `started = false` without fabricating an exit code, whereas launched programs exiting 126 or 127 report `started = true` (Unix launches through `/usr/bin/env` and treats 126/127 as not started). `VSCODE_TITAN_WINDOWS` in [`src/server/compiler_io_platform.h`](../src/server/compiler_io_platform.h) selects Windows path semantics, and [`src/server/compiler_io_clock.c`](../src/server/compiler_io_clock.c) reads `QueryPerformanceCounter`.

[`test/fixtures/compiler-io-process.c`](../test/fixtures/compiler-io-process.c) compiles with `-municode` (`wmain` and `_wfopen`) so cancellation marker paths stay UTF-16, passed via `TITAN_COMPILER_IO_PROCESS_FIXTURE`. The driver also builds the Titan router fixture under `tests/native/router-worker` and passes `TITAN_ROUTER_WORKER_FIXTURE` to `server-test-run`.

### Windows embedded interfaces

On Windows, `--windows-profile` generates the build C type profile and the selected-SDK query script. `ls_push_cache` in [`src/server/embedded_interfaces_windows.c`](../src/server/embedded_interfaces_windows.c) reads callable metadata directly from the loaded standard-provider DLL after verifying every interface's ABI value, opening the DLL with `FILE_SHARE_READ` only, confirming the handle matches the mapped image, and fingerprinting canonical path, volume/file IDs, and 100 ns timestamps (closing the handle immediately on failure). Because `embedded_interfaces_windows.c` links `luaopen_titan` from `lib/titan/0.6/libtitan.a`, restart the server before updating a loaded standard provider.

[`scripts/standard-interface-inventory.lua`](../scripts/standard-interface-inventory.lua) owns the canonical module list and checks ABI exports before type exports. `selected_interfaces.read` executes the embedded script in the selected SDK's `bin/lua.exe -E`, reading results from a bounded binary file only after clean exit and awaiting process and file retirement on cancellation.

### Windows packaging

Dependency notices come from installed rockspecs, `rock_manifest` checksums, and SDK license files (`compilerRocks` in [`scripts/compiler-rocks.mjs`](../scripts/compiler-rocks.mjs)); Windows `luv` 1.52.1-0 bundles Apache 2.0 and Titan's four `libuv` license files.

[`scripts/inspect-windows-package.mjs`](../scripts/inspect-windows-package.mjs) validates the `win32-x64` VSIX target, exact EXE/DLL/compiler/SDK/browser-pack inventories, PE imports against `systemDlls` (including libuv's `api-ms-win-core-synch-l1-2-0.dll` per [Microsoft's WaitOnAddress reference](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitonaddress)), and an extracted-ZIP browser analysis smoke. Signing and publishing remain separate steps.

### Windows validation gates

Native tests, SQLite cache reopen tests, stdio protocol suites, package inspection, and interactive Extension Host (F5) sessions are independent gates. Symlink tests skip unless run elevated on local NTFS; qualify both the Extension Host symlink case and multi-root SDK-farm symlink cases in an elevated local-NTFS session.

[`scripts/test-server-protocol.mjs`](../scripts/test-server-protocol.mjs), [`scripts/test-workspace-cache.mjs`](../scripts/test-workspace-cache.mjs), [`scripts/test-multi-root.mjs`](../scripts/test-multi-root.mjs), and [`scripts/test-completion-protocol.mjs`](../scripts/test-completion-protocol.mjs) take the server executable as their first argument and require `TITAN_ROOT`, `TITAN_LS_LUA_PATH` (`<sdk>/share/lua/5.5/?.lua;<sdk>/share/lua/5.5/?/init.lua`), `TITAN_LS_LUA_CPATH` (`<sdk>/lib/lua/5.5/?.dll`), `TITAN_ROUTER_WORKER_FIXTURE` (`.build/windows/tests/native/router-worker/bin/router_worker_fixture.exe`), and an unset `TITAN_PREFIX` so each root keeps its private `.titan-ls` cache. `test-multi-root.mjs` accepts an optional group name as its second argument to rerun one group.

Run `npm run test:vscode` serially from an interactive desktop session with native Node and CLANG64 tools on `PATH`, `TITAN_PREFIX` set for staging, `TITAN_LSP_TEST_CODE` pointing to `Code.exe`, and `TITAN_LSP_TEST_SERVER` pointing to `titan-language-server.exe`.

For interactive F5 debugging, give the interactive account read/execute access to the SDK and tools alongside its own writable workspace, build tree, `node_modules`, VS Code state, and analysis cache on local NTFS. Set `TITAN_PREFIX`, `CC`, `AR`, `RANLIB`, `RC`, and `PATH` before launching VS Code, quoting the four tool paths with forward slashes (such as `"C:/tools/clang64/bin/clang.exe"`) because Titan parses them as shell words (see Titan's [Windows user guide](https://github.com/mascarenhas/titan/blob/master/doc/language/windows-build.md)). The `npm: compile` pre-launch task stages the compiler payload, and `.vscode/launch.json` clears `TITAN_PREFIX` inside the Extension Host. Filesystem watcher validation applies only to guest-local NTFS; shared folders may require an explicit refresh.

---

← Previous: [Chapter 6](completion.md) | [Table of Contents](index.md) | Next: [Appendix B: Executable Line Coverage](coverage.md) →
