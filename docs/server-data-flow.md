# Server configuration and data flow

The extension launches one native server per workspace folder. The process runs
in one of two modes selected by `main` in `src/titan_language_server.titan`:

- The **router** (default) owns the client session. It reads the client's
  workspace folders, routes each document to the most specific root, and starts
  one **worker** process per root (`server/router.titan`,
  `server/roots.titan`, `server/worker_process.titan`). It never loads the
  compiler.
- The **worker** (`--worker --root PATH`) is one root's server: it changes its
  working directory to that root, and `application.create(root)` owns that
  root's project service, index, watchers and caches. `--compiler-root PREFIX`
  selects an installed SDK before any compiler module loads
  (`lua_paths.select_compiler_root`, `compiler_bridge.select_compiler_root`).

Process isolation is what makes several roots possible: compiler Lua, driver
globals, native modules, the probe prefix, the SQLite store and the Lua heap are
process-wide, so one process hosts exactly one root and one SDK. The router
sets each worker's `TITAN_PREFIX`, so probe caches never mix.

`server/root_settings.titan` also records each root's settings fingerprint and
the stat identity of the SDK files that decide its compiler. The router
re-observes them at most once per second, on the routing path and on a
periodic sweep, and immediately for every root on
`workspace/didChangeConfiguration`. A change stops that root's worker after a
bounded drain, starts a fresh worker with the accepted settings and replays the
root's open documents; no other root is touched. A tracked `titan-config.lua`
edit that leaves the effective selection alone restarts nothing, because the
worker rescans it.

The extension translates remote and symlinked workspace URIs at the protocol
boundary (`src/extension/workspaceUris.ts`).

Completion has a separate [unsaved input and TEMP publication path](completion.md).
Its dependency baseline is the committed saved publication. The saved-file
features read the `main` semantic facts described in
[workspace storage](sqlite-backend-storage.md).

## Where compiler inputs come from

The [README](../README.md#project-configuration) describes what each
`titan-config.lua` field means to users. This table gives the owner of each
input.

| Input | Owner and interpretation |
| --- | --- |
| Compiler Lua and native Lua module paths | The extension sets `TITAN_LS_LUA_PATH` and `TITAN_LS_LUA_CPATH` from its packaged trees or explicit settings (`readCompilerDiscoveryConfiguration` in `src/extension/clientConfig.ts`). `lua_paths.configure` assigns them, or the [standalone defaults](../README.md#standalone-server), to `package.path` and `package.cpath` before compiler modules load. A worker started with `--compiler-root` ignores both and takes the prefix's own `share/lua/5.5` and `lib/lua/5.5` instead (`lua_paths.select_compiler_root`), which also removes the inherited `TITAN_PATH`, `TITAN_PATH_0_6` and `TITAN_SOURCE_PATH`. Removing them matters: the driver treats an empty string as a configured path, so blanking them would replace the selected prefix's own default provider path with an empty list. These paths are separate from Titan source and provider paths. |
| Compiler installation root | The extension reports the packaged `dist/titan` payload, which `createServerLaunchOptions` passes as `TITAN_ROOT`. A root's `compiler_root` (tracked `titan-config.lua` or the `titan-config.local.lua` override) is resolved by the router before it starts that worker, checked for the SDK layout (`validate_prefix` in `server/root_settings.titan`) and passed as `--compiler-root`. The compiler takes its SDK headers, Lua sources and library layout from that root and never from a Lua search path; the server links the runtime archive, so the payload carries no `lib/titan` providers. |
| Root membership and trust | `server/roots.titan` owns canonical roots, folder references, discovered roots and most-specific ownership. `server/root_settings.titan` decides trust from `initializationOptions.trustedRoots` plus `TITAN_LS_TRUSTED_ROOTS`, and refuses an untrusted root's `compiler_root` before a worker exists. |
| Saved project discovery and watching | `project_config` loads `include` and `exclude` and resolves them against the workspace root. `project_discovery` scans `include` and selects target variants for the host target using the compiler driver's source-selection helpers (`TITAN_TARGET` is ignored); `exclude` narrows only the watcher set. |
| Titan source module roots | `source_module_roots` is an ordered array in `ProjectConfig` and `CompilerConfiguration`. Only `Compiler:configure` joins it with `;` into the driver's `TITAN_SOURCE_PATH`. It also determines logical module names and canonical `native_output` paths (`raw_source_descriptor` in `src/server/compiler_bridge.titan`). |
| Titan binary providers | `binary_modules_root` defaults to the compiler's installed root (`Compiler:installed_binary_modules_root`). It is independent of the Lua native-module path. |
| C include directories | `extra_ffi_include_dirs` is an ordered, normalized array. Resolver contexts receive it from the accepted compiler configuration, in addition to the compiler's explicit SDK roots. There is no parent-directory SDK search. |
| Compilation flags | The compiler driver captures the inherited `TITAN_EXTRA_CPPFLAGS`, `TITAN_EXTRA_CFLAGS` and `TITAN_EXTRA_LDFLAGS`. `Compiler:configure` splits `extra_ffi_cppflags` with the driver's `split_shell_words` and appends the words after the inherited preprocessing flags. The project file cannot change C or linker flags. |
| C probe cache | The router computes one prefix per root (`root_settings.probe_prefix`) and passes it as the worker's `TITAN_PREFIX` before the compiler loads: `<root>/.titan-ls` when nothing was inherited, otherwise `<TITAN_PREFIX>/roots/<digest>` keyed by the canonical root. A worker started without the router applies the same default to its own root. The prefix changes only probe storage, not compiler, provider or SDK discovery, and not the database location. |

With the default prefix, the compiler stores probe results under
`.titan-ls/var/cache/titan-probes/2`, beside `.titan-ls/index.sqlite3`. Probe
keys are hashes of the raw C source, while results also depend on a root's SDK
headers and flags, so no two roots share a probe directory. The README's
[workspace cache](../README.md#workspace-cache) section explains how to clear
the cache.

## Compiler compatibility

`compiler_bridge.load` requires the driver's `TITAN_ABI_VERSION` to equal
`COMPILER_ABI` (`"2"`) and its `LANGUAGE_SERVER_API_VERSION` to equal
`COMPILER_LANGUAGE_SERVER_API` (`1`). A matching ABI alone is rejected. The
bridge then checks every driver entry point it calls (`checked_function`).
Examples are `restat_c_header_dependencies`, `split_shell_words`, and the
project-entry codecs. `AGENTS.md` states the rule for keeping the API version
at `1`.

The check is the same for the executable's build SDK and for a root's selected
SDK, so a mismatch is a root-scoped error naming the prefix. The bridge records
which provider mode it loaded (`Compiler.embedded_provider`). A selected SDK
supplies no embedded interface inventory — that inventory describes the build
SDK — so the resolver parses the selected installation's `lib/titan/0.6/titan.a`
(`prefer_static`) and never loads another build's native provider. Its cache
compatibility fingerprints that archive by stat identity instead of content, and
revalidates the archive on every analysis attempt. Residual risk: the `titan`
support table comes from this executable's build, so an SDK whose compiler calls
a support function this build lacks fails that root with a clear error; running
a server built from a matching SDK fixes it.

`scripts/generate-embedded-interfaces.lua` accepts two exact standard-module
inventories: the published 0.6 SDK's original 23 modules, or the current master
SDK's 26, which add `titan.protobuf`, `titan.thread` and `titan.transfer`.
`EXPECTED_MODULES` and `validate_inventory` define the reviewed sets; partial
additional groups and unexpected modules are rejected.

On Unix, the script generates the embedded metadata-only interface provider
from the SDK's `lib/titan/0.6/titan.a`, including the build target's C type
profile. The compiler can therefore typecheck standard-library imports,
including reflection, without a C compiler or SDK. The generated C registers
only the compiler's bare `titan` support table in `package.preload`. It does
not register or initialize the native `titan.*` modules. On Windows,
`src/server/embedded_interfaces_windows.c` reads interfaces from the loaded
standard-provider DLL; see
[native builds](native-build.md#windows-embedded-interfaces).

## One production composition path

`project_loader.load` loads the compiler and one normalized project
configuration. It validates workspace-cache compatibility and wires the real
compiler callbacks, the persisted cache and the `Restoration` callbacks.
`project_service.create` builds the Service from that accepted
configuration. `Application` owns the background restoration Task and the
transaction that publishes the completed semantic view. Service owns
discovery, graph state and commits, invalidation and the publication hooks.
Test fixtures inject callbacks through the same constructor. Tests that need a
real compiler use the production loader.

Service construction copies the accepted configuration with `ProjectConfig:copy`
before discovery can yield, then consumes that discovery once. Later scans
reload the configuration. The rescan after watcher registration is
deliberate: it covers changes between the initial scan and registration.
Snapshots that the Service publishes are defensive copies, so consumers cannot
change Service settings by editing one.

The loader and the independent rename preflight map normalized settings into
the named `CompilerConfiguration` fields. The Compiler owns the accepted copy
and its effective driver values. `Compiler:configure` compares unchanged
configuration before it parses flags or converts paths, and prepares changed
configuration once. Compiler operations apply and restore the driver globals
(`DriverConfiguration:apply`) under the `compiler_scheduler` permit. Analysis,
external resolution and native cache identity all derive resolver options
from that same accepted state.

`ProjectModule:compiler_input` converts saved module and source snapshots for
the loader's cache restoration and export, and for Application's snapshot
preparation. Each caller selects its own module set. Service's incremental
preparation uses its mutable state through `bridge_project`, a separate
work-state boundary. These conversions keep no compiler bodies and add no
cached representation.

## Compiler boundary

`compiler_bridge` normalizes compiler Lua tables into typed records. The other
server layers never traverse untyped `value` maps. The AST walker visits only
the lexical child fields in `AST_CHILD_FIELDS`, in order, and excludes DAG
backreferences such as `Ast.ExpSpreadIndex.spread`. Changes to the compiler or
server content identity invalidate incompatible saved metadata, without
changing API or cache version numbers; see
[workspace storage](sqlite-backend-storage.md#location-and-opening).

Compilation and semantic extraction stay outside the short SQL publication
transactions. Cancellation still drains owned work and restoration before
stores close. Structured SQLite, compiler and async errors keep useful detail
when they become Service failures.

## Protocol boundary

`router.run` and `protocol.run` read stdin and write stdout, which carries only
`Content-Length`-framed JSON-RPC. The router reuses the worker's transport
(`protocol.new_input_queue`, `read_messages`, `write_messages`,
`response_queue`) and forwards original message bytes after decoding only what
it routes on. `logging` writes structured records to stderr.
`framing` limits the header block to 64 KiB and a message body to 16 MiB. It
rejects duplicate `Content-Length` or `Content-Type` headers. An optional
`Content-Type` must be `application/vscode-jsonrpc`, and may add only a
`charset` parameter of `utf-8` (or the legacy `utf8`). `wire`
decodes and encodes JSON with `titan.json`, using native Maps and Arrays, an
explicit null sentinel (`wire.null`) and a nesting limit of 128. `dispatcher`
turns request IDs into the nominal `RequestId` union and routes semantic
requests, completion and document notifications. `lifecycle` owns the
`initialize`/`shutdown`/`exit` states and the advertised capabilities; the
router enables its workspace-folder capability and only the router advertises
it. The custom `titan/indexingStatus` notification (`indexing_status`) drives
the extension's language-status item.

The router also filters diagnostics by ownership: a worker's
`textDocument/publishDiagnostics` for a URI is forwarded only when that worker
owns the URI, so a nested root's outer worker cannot publish for an inner root's
documents. It forwards `$/cancelRequest` to the worker that owns the request id,
and it remaps a worker-to-client request under a router-allocated id
(`router.worker_response_body` restores the worker's id on the reply), so a
later worker feature can ask the client questions. `titan/workspaceStatus`
reports the root registry, including the `titanRoot` and `probePrefix` each
worker reports for itself, and every root transition is logged with the root
path.
