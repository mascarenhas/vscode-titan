# Using the Standalone Language Server

`titan-language-server` is a native stdio LSP router that supervises isolated
per-root worker processes. Use it directly from Neovim, Helix, Emacs, `omp`,
Codex, or custom tooling.

## Installing and compiler discovery

Build and install the executable from a checkout:

```sh
make -j2 server
make install-server INSTALL_PREFIX="$HOME/.local"
```

`install-server` installs `bin/titan-language-server` alongside the repository,
Titan, and third-party licenses under `share/doc/titan-language-server`. It
does not copy compiler Lua modules.

### Why compiler Lua stays external

The native binary statically links the Titan standard-library runtime, an
embedded Lua 5.5 interpreter, libuv, llhttp, SQLite, and metadata-only standard
interfaces (with OpenSSL following the build SDK), and exports the Lua C API so
compiler native dependencies (`lfs`, `lpeglabel`, `luv`) bind into the same Lua
state. Keeping `titan-compiler` external lets one executable serve multiple
installed Titan SDKs across workspace roots without rebuilding the server.

### Environment variables and CLI options

Configure the server environment to point at a compatible Titan SDK (Titan ABI
`2`, `LANGUAGE_SERVER_API_VERSION == 1`):

```sh
export TITAN_ROOT="$HOME/.local/titan"
export TITAN_LS_LUA_PATH="$TITAN_ROOT/share/lua/5.5/?.lua;$TITAN_ROOT/share/lua/5.5/?/init.lua"
export TITAN_LS_LUA_CPATH="$TITAN_ROOT/lib/lua/5.5/?.so"
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `TITAN_ROOT` | parent of executable directory | Default Titan SDK prefix supplying headers (`include/`), Lua sources (`src/`), and target providers (`lib/titan/0.6`, `lib/titan-browser/0.6`) |
| `TITAN_LS_LUA_PATH` | `./?.lua` | Complete `package.path` template for `titan-compiler` Lua modules, used verbatim without `;;` expansion (ambient `LUA_PATH` is ignored) |
| `TITAN_LS_LUA_CPATH` | `./?.so` (`./?.dll` on Windows) | Complete `package.cpath` template for compiler native Lua modules, used verbatim (ambient `LUA_CPATH` is ignored) |
| `TITAN_LANGUAGE_SERVER_LOG_LEVEL` | `info` | Structured stderr log level: `off`, `error`, `info`, `debug`, or `trace` (invalid values log `logging.invalid_level` and use `info`) |
| `TITAN_LS_TRUSTED_ROOTS` | empty | OS path-list (`:` on Unix, `;` on Windows) of absolute directories whose roots may honor `compiler_root` |
| `TITAN_LS_MAX_WORKERS` | `4` | Maximum concurrent worker processes (overridden by `initializationOptions.maxWorkers`) |
| `TITAN_PREFIX` | `<root>/.titan-ls` | Optional override relocating only the C probe cache; see [Cache and probe prefix layout](#cache-and-probe-prefix-layout) |

Supported command-line options (`parse_options` in
[`src/titan_language_server.titan`](../src/titan_language_server.titan)):

- **Default (no arguments):** Runs the multi-root LSP router over stdio.
- **`--print-paths` (`[--compiler-root PATH]`):** Prints resolved
  `package.path=...` and `package.cpath=...` to stdout and exits `0` without
  starting an LSP session.
- **`--worker --root PATH [--compiler-root PATH] [--target native|browser]`:**
  Internal single-root mode spawned by the router; clients always launch the
  default router mode.

### Stdout framing and stderr logging

`stdout` is reserved exclusively for `Content-Length`-framed JSON-RPC 2.0
messages. All diagnostic output goes to `stderr` as newline-delimited JSON
records prefixed with `titan-language-server ` (`format` in
[`src/server/logging.titan`](../src/server/logging.titan)):

```text
titan-language-server {"level":"info","event":"server.start","root":"/path/to/project","log_level":"info"}
```

Unstructured native dependency errors also go to `stderr` without corrupting
the JSON-RPC stream.

## Connecting an LSP client

Launch `titan-language-server` over stdio with UTF-16 position encoding
(`positionEncoding: "utf-16"`). The server advertises definition, references,
rename, hover, folding ranges, unsaved-buffer completion (trigger characters `.`
and `:`, full document sync with `save.includeText: false`), pull diagnostics
(unless disabled), and dynamic workspace folders (`initialize_result` in
[`src/server/lifecycle.titan`](../src/server/lifecycle.titan)).

### `initializationOptions`

Pass optional session settings inside `initialize.params.initializationOptions`:

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `insertCallSnippets` | `boolean` | `true` | Emit parameter-name snippet placeholders for callable completions when the client advertises snippet support |
| `pullDiagnostics` | `boolean` | `true` | Advertise `diagnosticProvider` (`textDocument/diagnostic`); set `false` to use pushed `textDocument/publishDiagnostics` exclusively (the VS Code extension sets `false` because `vscode-languageclient` separates pulled and pushed collections) |
| `trustedRoots` | `string[]` | `[]` | Absolute directory paths whose roots may honor `compiler_root`, merged with `TITAN_LS_TRUSTED_ROOTS` |
| `maxWorkers` | `integer` | `4` (or `TITAN_LS_MAX_WORKERS`) | Positive cap on simultaneous live workers |
| `idleTimeoutSeconds` | `number` | `600` | Seconds of idleness before an idle worker is evicted (fractional values accepted) |

### Indexing progress and readiness

- **Standard LSP progress (`window/workDoneProgress`):** When the client
  advertises `window.workDoneProgress`, the router sends one
  `window/workDoneProgress/create` request per contiguous indexing period,
  followed by `$/progress` `begin`, `report` updates with saved-file workset
  counts, and exactly one `end`. `end` arrives after the completed generation
  and its diagnostics publish, so any semantic request sent after `end` observes
  that generation without polling. Coalesced follow-up passes keep the active
  token.
- **Custom status (`titan/indexingStatus`):** Every client also receives
  `titan/indexingStatus` notifications (`state`: `"indexing"`, `"ready"`, or
  `"failed"`, `initial`, monotonic `epoch`, optional `generation`, `message`,
  `completed_files`, `total_files`) summarizing all claimed roots.

### Pull diagnostics and freshness barriers

With `pullDiagnostics` enabled, `textDocument/diagnostic` answers from the same
published rows that `textDocument/publishDiagnostics` pushes. Every pull acts as
a freshness barrier: it triggers one coalesced saved-file refresh pass before
returning the report, revalidating dependencies and sibling folder-module
contributors first.

When nothing changed on disk, the barrier performs only a metadata scan,
reuses the existing `resultId`, and returns `unchanged` when
`previousResultId` matches. A cancelled pull returns cancellation; a pull after
a failed pass runs the barrier pass (recovering a repaired project) or reports
the active failure; a `.titan` file outside the project returns an empty report.
See [protocol boundary](server-data-flow.md#protocol-boundary) and
[Chapter 5: Semantic Features](semantic-features.md).

## Multi-root routing and dynamic workspaces

One router session owns the client transport and spawns one isolated `--worker`
child process per Titan root. Each worker keeps its own embedded Lua compiler,
SQLite index, watchers, and caches.

### Root discovery and document ownership

- **Initial roots:** Every `file:` entry in `workspaceFolders` registers a root
  (falling back to `rootUri`, `rootPath`, or the launch directory when
  `workspaceFolders` is absent or empty). Non-`file:` URIs are ignored. Paths
  are canonicalized so symlinked folders share one root.
- **Dynamic folders:** Clients can add and remove roots at any time via
  `workspace/didChangeWorkspaceFolders`. Initial roots activate up to
  `maxWorkers`; roots beyond the cap and newly added folders stay `inactive`
  until a routed message touches them.
- **Nearest-ancestor routing:** Each document belongs to the most specific owner
  among known roots containing it and its nearest ancestor directory with
  `titan-config.lua`. A nested project isolates into its own worker without
  restarting an outer workspace folder, and an outer container directory (such
  as a monorepo root) spawns no worker until it directly owns a document.
- **Unowned documents:** A document with no containing root and no ancestor
  `titan-config.lua` has its notifications dropped and its requests rejected
  with an error naming the file.

### Warm retention, buffer replay, eviction, and crash backoff

- **Warm worker retention:** Removing a folder releases its root
  (`origin: "released"`) without terminating its worker. A released root serves
  only documents claimed by its own `titan-config.lua`. Re-adding the same
  folder reuses the warm worker without re-indexing and replays its diagnostics;
  an enclosing warm worker republishes when it regains documents from a released
  nested folder. Clients that temporarily add sibling checkouts pay cold
  indexing once.
- **Worker cap and idle eviction:** At most `maxWorkers` workers run at once. A
  worker is idle when its root has no open documents, no in-flight requests, and
  no active indexing pass. Idle workers stop after `idleTimeoutSeconds` or when
  capacity pressure requires a slot.
- **Editor buffer replay:** The router retains open unsaved buffers under the
  same size bounds as workers (oversized buffers are delivered as unavailable
  contributors rather than saved bytes). Buffers replay automatically across
  worker restarts, evictions, crashes, and root-ownership transfers, while stale
  diagnostics from any previous owner are cleared.
- **Crash recovery and automatic reloads:** A worker that exits unexpectedly
  fails its in-flight requests and clears its diagnostics until its replacement
  publishes an accepted generation. Three crashes of one root within 60 seconds
  halt automatic restarts until that root's settings change or the client sends
  `workspace/didChangeConfiguration`. Editing `titan-config.lua` without
  changing `compiler_root` or `target` rescans inside the live worker; changing
  `compiler_root`, `target`, or reinstalling the selected SDK restarts only that
  root's worker automatically.

## Per-root SDK selection and trust

Each root can select an installed Titan SDK independently through
`compiler_root` in `titan-config.lua` or in a gitignored
`titan-config.local.lua` beside it:

```lua
-- titan-config.local.lua (ignored by version control)
compiler_root = "/tmp/titan-314/slice-a/prefix"
```

`titan-config.local.lua` may assign only `compiler_root` and overrides any
tracked setting; any other key fails the root. Relative paths resolve from the
root. Native and browser (`target = "browser"`) roots run side-by-side inside
the same router session. See
[project configuration](vscode-extension.md#project-configuration) for all
`titan-config.lua` fields and browser-root requirements.

### Trust policy and SDK validation

Because loading a selected SDK executes its Lua and native C modules, the router
honors `compiler_root` only for trusted roots—roots whose canonical path equals
or lies inside a directory from `initializationOptions.trustedRoots` or
`TITAN_LS_TRUSTED_ROOTS`.

An untrusted root declaring `compiler_root` starts no worker: the router
returns a root-scoped error naming the root, setting, and trust options, and
publishes a `configuration` diagnostic on the file that set `compiler_root`
(cleared once trust is granted). Roots without `compiler_root` require no trust
configuration.

Before launching a worker, the router verifies that `compiler_root` contains a
complete installed SDK (`share/lua/5.5/titan-compiler/driver.lua`,
`lib/lua/5.5`, support module `lib/lua/5.5/titan.so` or `titan.dll`, standard
provider `lib/titan/0.6/titan.a` or `titan.dll` plus `bin/lua.exe` on Windows,
and `lib/titan-browser/0.6/{analysis-target,absent-modules,titan.a}` for
`target = "browser"`). Missing or incompatible SDKs fail only that root. See
[compiler compatibility](server-data-flow.md#compiler-compatibility).

### Inspecting live workers (`titan/workspaceStatus`)

Send the custom request `titan/workspaceStatus` (no parameters) to inspect every
root known to the router. The response returns `{ "roots": [ ... ] }`, with one
object per root:

| Field | Value |
| --- | --- |
| `root` | Canonical root directory path |
| `origin` | `"folder"`, `"discovered"`, or `"released"` |
| `trusted` | Boolean indicating whether the root falls inside a trusted directory |
| `compilerRoot` | Resolved `compiler_root` path, or `null` |
| `target` | `"native"` or `"browser"` (present once root settings load) |
| `state` | `"inactive"`, `"starting"`, `"ready"`, `"failed"`, or `"evicted"` |
| `failure` | Failure message string (present when failed) |
| `workerPid` | Live worker process ID, or `null` |
| `generation` | Restart generation counter for this root |
| `titanRoot` | Actual `TITAN_ROOT` reported by the running worker, or `null` |
| `probePrefix` | Actual `TITAN_PREFIX` reported by the running worker, or `null` |

Because `titanRoot` and `probePrefix` originate from the running worker process
itself, they verify live per-root SDK and probe-cache isolation directly. The
router also logs every root lifecycle transition to `stderr` with the root path.

## Agent harnesses

### `omp` multi-worktree configuration

Agent harnesses that share one language-server process across sibling checkouts
or compiler worktrees benefit from dynamic `workspace/didChangeWorkspaceFolders`
and warm worker retention. Configure `omp`'s `lsp` tool with `trustedRoots`
covering the parent directory that holds your worktrees:

```json
{
  "servers": {
    "titan": {
      "command": "/home/you/.local/bin/titan-language-server",
      "args": [],
      "fileTypes": [".titan"],
      "rootMarkers": ["titan-config.lua", ".git"],
      "initOptions": {
        "trustedRoots": ["/home/you/work"]
      }
    }
  }
}
```

`omp` inherits `TITAN_ROOT`, `TITAN_LS_LUA_PATH`, and `TITAN_LS_LUA_CPATH` from
the process environment for roots without an override. Each slice under
`/home/you/work` selects its own prefix in gitignored `titan-config.local.lua`,
and `titan/workspaceStatus` confirms which worker and SDK serve each slice.

### Codex

For Codex, the repository includes the skills-only `titan-lsp` plugin and the
one-shot `titan-lsp-query.mjs` client, which handles server launch, readiness
waiting, querying, and clean shutdown. See
[Codex Plugin and Query Client](codex.md).

## Cache and probe prefix layout

Each root persists its SQLite index at `<root>/.titan-ls/index.sqlite3` and, by
default, writes the compiler's C probe cache under
`<root>/.titan-ls/var/cache/titan-probes/2`.

Setting a nonempty `TITAN_PREFIX` in the server environment relocates only the
probe cache: the router assigns each root its own isolated subdirectory
`<TITAN_PREFIX>/roots/<digest>` keyed by a 16-hex-character digest of the
canonical root path (`probe_prefix` in
[`src/server/root_settings.titan`](../src/server/root_settings.titan)). Roots
never share a probe directory because probe results depend on each root's SDK
headers and preprocessing flags. See
[workspace storage](sqlite-backend-storage.md#location-and-opening) for cache
schema and invalidation rules.
