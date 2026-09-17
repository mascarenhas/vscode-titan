# Server configuration and data flow

The extension launches one native server per workspace folder. The native process fixes
its physical workspace root at startup; an LSP `initialize` message does not
retarget that process. The extension translates remote and symlinked workspace
URIs at the protocol boundary.

## Where compiler inputs come from

| Input | Owner and interpretation |
| --- | --- |
| Compiler Lua and native Lua module paths | The extension supplies `TITAN_LS_LUA_PATH` and `TITAN_LS_LUA_CPATH` from its packaged trees or explicit settings. `server.lua_paths` installs them before loading compiler modules. These are separate from Titan source/provider paths. |
| Saved project discovery and watching | `titan-config.lua` supplies `include` and `exclude`; `ProjectConfig` resolves their paths relative to the workspace. `include` selects saved project files; `exclude` only narrows watcher coverage and does not remove discovered modules. |
| Titan source module roots | `source_module_roots` is an ordered array in `ProjectConfig` and the bridge configuration. Only the compiler boundary serializes it to the driver's semicolon-separated source path. It also determines logical module names. |
| Titan binary providers | `binary_modules_root` is resolved by `ProjectConfig`, defaulting to the compatible compiler installation supplied by the loader. It is independent of the Lua native-module path. |
| C include directories | `extra_ffi_include_dirs` is an ordered, normalized project array. Resolver contexts receive it from the accepted bridge configuration in addition to the compiler's explicit SDK roots. There is no parent-directory SDK search. |
| Compilation flags | The compiler captures inherited `TITAN_EXTRA_CPPFLAGS`, `TITAN_EXTRA_CFLAGS`, and `TITAN_EXTRA_LDFLAGS`. Project `extra_ffi_cppflags` adds shell-parsed preprocessing words after inherited preprocessing flags. The project file does not override C or linker flags. |
| C probe cache | Native startup defaults an absent or empty `TITAN_PREFIX` to `workspace_cache.directory(root)`, currently `.titan-ls`. The extension leaves this policy to the server. A nonempty inherited override changes only the probe prefix, not compiler/provider/SDK discovery or the database location. |

The resulting default paths are `.titan-ls/index.sqlite3` and
`.titan-ls/var/cache/titan-probes/2`. Probe keys remain hashes of raw C source.
Removing the directory clears both stores; deleting only the database retains
probe results. A deliberately overridden probe prefix must be cleared separately.

## One production composition path

`project_loader` loads the compiler and one normalized project configuration,
validates workspace cache compatibility, and constructs the Service from that
accepted configuration. It constructs the real compiler callbacks, persisted
cache and restoration callbacks. Application owns the background restoration
Task lifecycle and the transaction that publishes the completed semantic view.
Service owns discovery, graph state and graph commits, invalidation and the
publication hooks used by that composition. Test fixtures inject callbacks through the same
Service constructor; tests requiring a real compiler use the production loader.

Initial Service construction copies the accepted configuration before discovery
can yield, then consumes that discovery once. Later scans reload configuration.
The rescan after watcher registration remains deliberate: it covers changes
between the initial scan and registration. `ProjectConfig:copy()` owns defensive
copying for published snapshots; consumers cannot mutate Service settings by
editing a returned snapshot.

The loader and independent rename preflight explicitly map normalized project
settings into the bridge's named `CompilerConfiguration` fields. The Compiler
owns the accepted copy and its effective driver values. Unchanged configuration
is compared before flag parsing or path conversion; changed configuration is
prepared once. Compiler operations install and restore driver globals under the
existing scheduler permit. Analysis, external resolution and native cache
identity derive resolver options from that same accepted state.

`ProjectModule:compiler_input()` converts saved module/source snapshots for the
loader's cache restoration/export and Application's snapshot preparation. Each
caller still selects its own module set. Service's incremental preparation uses
its mutable ProjectState through `bridge_project`, a separate work-state
boundary. These conversions do not retain compiler bodies or add another
cached representation.

## Boundaries retained by the refactor

Compiler Lua tables are normalized in `compiler_bridge`; ordinary server layers
use typed records. The AST walker retains lexical child order and excludes DAG
backreferences. Its shared child-field inventory avoids allocating the same
array for every visited node. Declaration-summary sorting shares one local
algorithm while preserving stable ordering and cooperative checkpoints.

Compilation and semantic extraction stay outside short SQL publication
transactions. Accepted publication releases transient checked bodies; unchanged
modules retain their SQL facts. Cancellation still drains owned work and
restoration before stores close. Structured SQLite, compiler and async errors
retain useful detail when converted to Service failures.

The persisted compiler kinds are `c-header-v5` and `ffi-conversion-v6` for the
pinned parser-overhaul compiler. A regression reads the installed compiler's
protocol identifiers and verifies publication/readback through SQLite, so a
future pin cannot silently discard a new artifact kind. API version `1` remains
unchanged during prerelease development; matching it alone is not a substitute
for the exact compiler pin.
