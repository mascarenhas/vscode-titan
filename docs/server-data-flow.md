# Server configuration and data flow

The extension launches one native server per workspace folder. The process
takes its workspace root from its working directory at startup (`main` in
`src/titan_language_server.titan` calls `fs.pwd()`); an LSP `initialize`
message does not retarget it. The extension translates remote and symlinked
workspace URIs at the protocol boundary (`src/extension/workspaceUris.ts`).

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
| Compiler Lua and native Lua module paths | The extension sets `TITAN_LS_LUA_PATH` and `TITAN_LS_LUA_CPATH` from its packaged trees or explicit settings (`readCompilerDiscoveryConfiguration` in `src/extension/clientConfig.ts`). `lua_paths.configure` assigns them, or the [standalone defaults](../README.md#standalone-server), to `package.path` and `package.cpath` before compiler modules load. These paths are separate from Titan source and provider paths. |
| Saved project discovery and watching | `project_config` loads `include` and `exclude` and resolves them against the workspace root. `project_discovery` scans `include`; `exclude` narrows only the watcher set. |
| Titan source module roots | `source_module_roots` is an ordered array in `ProjectConfig` and `CompilerConfiguration`. Only `Compiler:configure` joins it with `;` into the driver's `TITAN_SOURCE_PATH`. It also determines logical module names. |
| Titan binary providers | `binary_modules_root` defaults to the compiler's installed root (`Compiler:installed_binary_modules_root`). It is independent of the Lua native-module path. |
| C include directories | `extra_ffi_include_dirs` is an ordered, normalized array. Resolver contexts receive it from the accepted compiler configuration, in addition to the compiler's explicit SDK roots. There is no parent-directory SDK search. |
| Compilation flags | The compiler driver captures the inherited `TITAN_EXTRA_CPPFLAGS`, `TITAN_EXTRA_CFLAGS` and `TITAN_EXTRA_LDFLAGS`. `Compiler:configure` splits `extra_ffi_cppflags` with the driver's `split_shell_words` and appends the words after the inherited preprocessing flags. The project file cannot change C or linker flags. |
| C probe cache | If `TITAN_PREFIX` is absent or empty, `main` sets it to `workspace_cache.directory(root)` before the compiler loads. The extension passes its environment through unchanged. A nonempty inherited value changes only the probe prefix, not compiler, provider or SDK discovery, and not the database location. |

With the default prefix, the compiler stores probe results under
`.titan-ls/var/cache/titan-probes/2`, beside `.titan-ls/index.sqlite3`. Probe
keys are hashes of the raw C source. The README's
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

The embedded metadata-only interface provider is generated at build time by
`scripts/generate-embedded-interfaces.lua` from the SDK's
`lib/titan/0.6/titan.a`. It covers the 23 canonical standard modules listed in
`EXPECTED_MODULES` and includes the build target's C type profile. The
compiler can therefore typecheck standard-library imports, including
reflection, without a C compiler or SDK. The generated C registers only the
compiler's bare `titan` support table in `package.preload`. It does not
register or initialize the native `titan.*` modules. On Windows,
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

`protocol.run` reads stdin and writes stdout, which carries only
`Content-Length`-framed JSON-RPC. `logging` writes structured records to stderr.
`framing` limits the header block to 64 KiB and a message body to 16 MiB. It
rejects duplicate `Content-Length` or `Content-Type` headers. An optional
`Content-Type` must be `application/vscode-jsonrpc`, and may add only a
`charset` parameter of `utf-8` (or the legacy `utf8`). `wire`
decodes and encodes JSON with `titan.json`, using native Maps and Arrays, an
explicit null sentinel (`wire.null`) and a nesting limit of 128. `dispatcher`
turns request IDs into the nominal `RequestId` union and routes semantic
requests, completion and document notifications. `lifecycle` owns the
`initialize`/`shutdown`/`exit` states and the advertised capabilities. The
custom `titan/indexingStatus` notification (`indexing_status`) drives the
extension's language-status item.
