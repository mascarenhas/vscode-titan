# Chapter 1: Process Architecture, Multi-Root Routing, and Configuration

Language-server state inside a Titan compiler process is process-wide: the embedded Lua interpreter, compiler driver globals (`TITAN_SOURCE_PATH`, `TITAN_BIN_PATH`, `EXTRA_CPPFLAGS`), native `.so`/`.dll` bindings, the C-probe cache directory, and the SQLite connection cannot safely host two roots with different SDKs or build targets at once. `vscode-titan` resolves that constraint with process isolation. One native executable operates in two modes, separating client session ownership from compiler execution.

## Two modes in one executable

`main` in [`src/titan_language_server.titan`](../src/titan_language_server.titan) parses CLI flags into an immutable `Options` record and selects one of two modes:

- **Router mode** (default) runs `run` in [`src/server/router/router.titan`](../src/server/router/router.titan). It owns the client stdio stream, tracks workspace folders, resolves each document to its most specific root, and supervises one **worker** process per active root. The router loads zero compiler Lua modules.
- **Worker mode** (`--worker --root PATH`) changes its working directory to the canonical root, locks its SDK (`--compiler-root PREFIX`) and analysis target (`--target native` or `--target browser`) before loading compiler Lua, sets `TITAN_PREFIX` for probe-cache isolation, and binds one `application.Application` to framed stdio through `protocol.run`.

Both modes configure structured stderr logging via `logging.start` with `defer logging.close()`. Inside `serve`, named arguments on `protocol.run` and Titan bound methods (`server:start_indexing`, `server:on_document`, `server:capture_completion`) wire the application directly to the protocol loop without boilerplate forwarding closures:

```titan
local record Options
  const worker: boolean
  const root: string?
  const compiler_root: string?
  const print_paths: boolean
  const target: string?
end

local function serve(root: string): integer
  -- ...
  do
    local server = application.create(root)
    defer server:close()
    -- ...
    return protocol.run {
      source = os.stdin,
      target = os.stdout,
      -- ...
      initialized_handler = server:start_indexing,
      shutdown_handler = server:stop_diagnostics,
      document_handler = server:on_document,
      completion_capture = server:capture_completion,
      hover_capture = server:capture_hover,
      startup_notification = wire.encode(info_envelope()),
    }
  catch
    log_server_failure(error, traceback)
    return 1
  end
end
```
*Source: [`src/titan_language_server.titan`](../src/titan_language_server.titan) — `Options`, `serve`*

Each bound method evaluates its `server` receiver once when `protocol.run` is invoked, and `defer server:close()` guarantees project watchers, restoration Tasks, and SQLite handles close on every exit path.

## Multi-root router as a folder module

The router owns four orthogonal concerns — session dispatch, root ownership, child lifecycle, and diagnostic reconciliation — over one shared state graph. Splitting `server.router` into a four-file **folder module** keeps each concern focused while preserving module-private encapsulation on `Router` and `Slot`:

- [`src/server/router/router.titan`](../src/server/router/router.titan) *(folder main)* — Declares all imports, constants, `WorkerState`, `Overlay`, `Forwarded`, `Outbound`, `Slot`, `LaunchOptions`, `Router`, `create`, `Router:handle`, `Router:close`, and `run`.
- [`src/server/router/client_routing.titan`](../src/server/router/client_routing.titan) — Owns document ownership lookup (`Router:owner_root`), `titan/workspaceStatus` reporting (`Router:status_value`), request and cancellation forwarding, and `workspace/didChangeWorkspaceFolders`.
- [`src/server/router/worker_lifecycle.titan`](../src/server/router/worker_lifecycle.titan) — Owns cooperative slot transitions (`Slot:begin_transition`), worker spawning, throttled settings/SDK revalidation (`Router:revalidate`), crash accounting, LRU cap eviction (`Router:make_room`), idle sweeps (`Router:run_housekeeping`), and shutdown.
- [`src/server/router/overlays_and_diagnostics.titan`](../src/server/router/overlays_and_diagnostics.titan) — Owns bounded open-buffer retention, diagnostic ownership reconciliation (`Router:reconcile`), and session-wide `titan/indexingStatus` aggregation (`Router:publish_indexing`).

In Titan, contributor files inside a folder module share the main file's private records, unions, constants, and `local function Owner:method` declarations without exporting them to external importers:

```titan
union WorkerState
  inactive()
  starting()
  ready()
  failed(string)
  evicted()
end

record Slot
  const root: roots.Root
  local worker: worker_process.WorkerProcess?
  local state: WorkerState
  local generation: integer
  -- ...
  local const published: {string: string}
  local transitioning: boolean
  local const token: async.ResumeToken
end

record Router
  const options: LaunchOptions
  const output: response_queue.ResponseQueue
  local const registry: roots.Roots
  local const slots: {string: Slot}
  local const overlays: {string: Overlay}
  local retired: {worker_process.WorkerProcess}
  -- ...
  local housekeeping: async.Task<|nil, value|>?
end
```
*Source: [`src/server/router/router.titan`](../src/server/router/router.titan) — `WorkerState`, `Slot`, `Router`*

Because both the client message loop (`run`) and the background housekeeping Task (`Router:run_housekeeping`) can inspect or stop a root's worker, every worker state mutation executes inside `Slot:begin_transition()` paired with `defer slot:end_transition()`. A competing caller suspends on `slot.token` until the active transition settles. When a worker is detached during a restart or failure, the router appends it to `self.retired` *before* any suspension point so a shutdown that cancels housekeeping closes every retired child process and relay Task.

`load` and `sdk_identity` in [`src/server/root_settings.titan`](../src/server/root_settings.titan) record each root's settings fingerprint and the stat tuple of the SDK files that select its compiler. The router re-observes them at most once per second on both the routing path and the housekeeping sweep, and immediately across all roots on `workspace/didChangeConfiguration`. A settings or SDK change drains forwarded requests for a bounded window, stops that root's worker, launches a replacement with the accepted selection, and replays open editor buffers without affecting other roots. Removing a workspace folder releases the root while leaving its warm worker alive (`Router:remove_root`) until idle timeout or worker-cap eviction stops it. A tracked `titan-config.lua` edit that leaves `compiler_root` and `target` unchanged triggers zero restarts; the worker reloads those project fields on its own scan.

## Supervising child worker processes

`spawn` in [`src/server/worker_process.titan`](../src/server/worker_process.titan) launches the same executable with `os.spawn(executable, arguments, os.with_env("TITAN_PREFIX", probe_prefix))` and starts three cooperative relay Tasks: `WorkerProcess:read_messages` decodes `Content-Length` frames from child stdout, `WorkerProcess:await_exit` calls `child:wait()` to observe exit codes or signals, and `WorkerProcess:read_diagnostics` drains structured stderr logs into the router's single stderr queue.

Because `os.InputStream` satisfies Titan's `io.ReaderCloser` Interface, `io.lines(source)` iterates complete lines without manual chunk buffering or newline splitting:

```titan
local function WorkerProcess:read_diagnostics(): nil
  if self.error_stream == nil then return nil end
  local source = self.error_stream
  self.error_stream = nil
  for line in io.lines(source) do
    logging.raw(line)
  end
  return nil
catch
  if error is async.CancellationReason then raise end
  return nil
end
```
*Source: [`src/server/worker_process.titan`](../src/server/worker_process.titan) — `WorkerProcess:read_diagnostics`*

Re-raising `async.CancellationReason` inside `catch` is a codebase-wide invariant: swallowing cancellation turns cooperative Task shutdown into a lost termination signal.

## Canonical roots and URI mapping

Editors may spell paths through symlinked workspace folders, remote URI schemes, or filenames whose parent directories do not yet exist on disk. The VS Code client translates symlinked workspace roots and documents to physical paths on the wire and maps returned locations back to the editor's workspace spelling (`createWorkspaceUriConverters` in [`src/extension/workspaceUris.ts`](../src/extension/workspaceUris.ts)). On Windows, `relativeWorkspaceUriPath` in [`src/extension/uriPaths.ts`](../src/extension/uriPaths.ts) and `isNestedWorkspace` in [`src/extension/extension.ts`](../src/extension/extension.ts) compare only the drive letter case-insensitively while treating the path suffix case-sensitively. Remote workspace URIs cross the same converter boundary.

On the server, `file_uri_to_path` in [`src/server/source_text.titan`](../src/server/source_text.titan) normalizes drives and separators, and `canonical` in [`src/server/roots.titan`](../src/server/roots.titan) computes physical identity by walking upward until `fs.realpath` resolves the deepest existing ancestor, then reattaching the unresolved suffix:

```titan
function canonical(path: string): string
  local candidate = normalize_platform(path)
  local suffix: {string} = {}
  while true do
    do
      local resolved = paths.to_slash(fs.realpath(candidate))
      for index = #suffix, 1, -1 do
        resolved = join(resolved, suffix[index])
      end
      return normalize_platform(resolved)
    catch
      if error is async.CancellationReason then raise end
    end
    local parent = parent_path(candidate)
    if parent == candidate then return candidate end
    local name = paths.basename(candidate)
    if name == "" then return candidate end
    suffix[#suffix + 1] = name
    candidate = parent
  end
  return candidate
end
```
*Source: [`src/server/roots.titan`](../src/server/roots.titan) — `canonical`*

Registered roots carry an `Origin` union (`folder`, `discovered`, or `released`). `Roots:owner` selects the claimed root with the longest canonical path containing the document, ignoring released roots until a folder addition or nested `titan-config.lua` discovery claims them again:

```titan
function Roots:owner(subject: string): Root?
  local best: Root? = nil
  for index = 1, #self.order do
    local entry = self.entries[self.order[index]]
    if entry:claimed() and contains(entry.path, subject) then
      if best == nil or #entry.path > #best.path then best = entry end
    end
  end
  return best
end
```
*Source: [`src/server/roots.titan`](../src/server/roots.titan) — `Roots:owner`*

`Router:owner_root` in [`src/server/router/client_routing.titan`](../src/server/router/client_routing.titan) pairs `Roots:owner` with `roots.discover` (memoized per containing root and directory in `Router.discovered`), so a nested project with its own `titan-config.lua` always becomes its own root rather than falling under an enclosing workspace folder.

## Where compiler inputs come from

User-facing `titan-config.lua` settings live in [Using the Titan VS Code Extension](vscode-extension.md) and [Using the Standalone Language Server](language-server.md). Each input crosses one authoritative server owner:

| Input | Owner and interpretation |
| --- | --- |
| Compiler Lua and native Lua module paths | The extension sets `TITAN_LS_LUA_PATH` and `TITAN_LS_LUA_CPATH` from its packaged trees or settings (`readCompilerDiscoveryConfiguration` in [`src/extension/clientConfig.ts`](../src/extension/clientConfig.ts)). `configure` in [`src/server/lua_paths.titan`](../src/server/lua_paths.titan) assigns them (or standalone defaults) to `package.path` and `package.cpath` before compiler modules load. A worker started with `--compiler-root` ignores both variables, selects the prefix's `share/lua/5.5` and `lib/lua/5.5` (`select_compiler_root`), and unsets `TITAN_PATH`, `TITAN_PATH_0_6`, and `TITAN_SOURCE_PATH`. Unsetting rather than blanking them is required because the driver treats `""` as an explicit empty provider path. |
| Compiler installation root | The extension passes its packaged `dist/titan` directory as `TITAN_ROOT` (`createServerLaunchOptions` in [`src/extension/clientConfig.ts`](../src/extension/clientConfig.ts)). A root's `compiler_root` (in `titan-config.lua` or `titan-config.local.lua`) is validated by `validate_prefix` in [`src/server/root_settings.titan`](../src/server/root_settings.titan) and passed as `--compiler-root`. The compiler resolves SDK headers, Lua sources, and library layout solely from that root; the server links the runtime archive statically, so the packaged payload carries no `lib/titan` providers. |
| Root membership and trust | [`src/server/roots.titan`](../src/server/roots.titan) owns canonical roots, folder references, discovery, released roots, and containment (`Roots:add_folder`, `Roots:remove_folder`, `Roots:drop`, `Roots:owner`, `roots.discover`). `Router:owner_root` in [`src/server/router/client_routing.titan`](../src/server/router/client_routing.titan) resolves each document to the most specific registered root or nearest ancestor `titan-config.lua`. `Trust:allows` in [`src/server/root_settings.titan`](../src/server/root_settings.titan) combines `initializationOptions.trustedRoots` and `TITAN_LS_TRUSTED_ROOTS`, and `root_settings.load` rejects an untrusted or malformed `compiler_root` before starting a worker. |
| Saved project discovery and watching | [`src/server/project_config.titan`](../src/server/project_config.titan) evaluates `include` and `exclude` in an empty Lua environment and resolves them against the project root. [`src/server/project_discovery.titan`](../src/server/project_discovery.titan) selects source variants for the worker's target via compiler-owned rules (ignoring `TITAN_TARGET`); `exclude` narrows only the watcher set. |
| Titan source module roots | `source_module_roots` is an ordered array in `ProjectConfig` and `CompilerConfiguration`. `Compiler:configure` in [`src/server/compiler_bridge/loader.titan`](../src/server/compiler_bridge/loader.titan) joins it with `;` into `TITAN_SOURCE_PATH`. It also determines logical module names and canonical `native_output` paths (`ProjectModule:raw_source_descriptor` in [`src/server/compiler_bridge/analysis.titan`](../src/server/compiler_bridge/analysis.titan)). |
| Titan binary providers | `binary_modules_root` defaults to the compiler's installed root (`Compiler:installed_binary_modules_root` in [`src/server/compiler_bridge/loader.titan`](../src/server/compiler_bridge/loader.titan)) and is independent of Lua native-module paths. |
| C include directories | `extra_ffi_include_dirs` is an ordered, normalized array supplied to resolver contexts alongside the compiler's explicit SDK roots, with zero parent-directory SDK search. |
| Compilation flags | The driver inherits `TITAN_EXTRA_CPPFLAGS`, `TITAN_EXTRA_CFLAGS`, and `TITAN_EXTRA_LDFLAGS`. `Compiler:configure` splits `extra_ffi_cppflags` via the driver's `split_shell_words` and appends those words after inherited preprocessing flags. Project configuration cannot alter C compiler or linker flags. |
| C probe cache | `probe_prefix` in [`src/server/root_settings.titan`](../src/server/root_settings.titan) assigns each root its own `TITAN_PREFIX` before compiler load: `<root>/.titan-ls` when unset, or `<TITAN_PREFIX>/roots/<digest>` keyed by canonical root. A direct `--worker` launch applies the same default. `TITAN_PREFIX` affects only probe storage, never compiler discovery or SQLite database placement. |

Under the default prefix, compiler C-probe caches live in `.titan-ls/var/cache/titan-probes/2` beside `.titan-ls/index.sqlite3`. Because probe keys hash raw C source while results depend on SDK headers and flags, per-root prefixes keep probe caches completely isolated.

## Compiler compatibility

`load` in [`src/server/compiler_bridge/loader.titan`](../src/server/compiler_bridge/loader.titan) checks that the loaded driver exports `TITAN_ABI_VERSION == COMPILER_ABI` (`"2"`) and `LANGUAGE_SERVER_API_VERSION == COMPILER_LANGUAGE_SERVER_API` (`1`), then verifies every required driver, parser, checker, and types entry point with `checked_function` ([`src/server/compiler_bridge/compiler_bridge.titan`](../src/server/compiler_bridge/compiler_bridge.titan)). Both the executable's default SDK and any per-root `compiler_root` pass the same gate, turning mismatches into root-scoped errors naming the failing prefix.

Provider interface discovery follows the host platform:

- **Selected Unix SDK:** Uses the SDK's static archive (`lib/titan/0.6/titan.a`) directly via `prefer_static`.
- **Selected Windows SDK:** `Compiler:selected_inventory` in [`src/server/compiler_bridge/loader.titan`](../src/server/compiler_bridge/loader.titan) invokes [`src/server/selected_interfaces.titan`](../src/server/selected_interfaces.titan) once per worker to read `lib/titan/0.6/titan.dll` in the selected SDK's own Lua interpreter, supplying the interface inventory without the build SDK's C profile. Each saved refresh resolves directory aliases (`project_config.physical_directory`) without rewriting the configured path, folds whether the alias matches the SDK directory into configuration and cache identity, and updates the completion catalog on retarget or removal. An explicit non-SDK `binary_modules_root` uses ordinary filesystem lookup. If project source overlaps the inventory, the compiler rejects the overlap and may inspect that SDK's DLL through ordinary lookup; the DLL stays mapped until worker exit while the worker's own native runtime remains unchanged.
- **Compiler support table:** Default workers register the executable's bare `titan` compiler support table in `package.preload` without initializing native `titan.*` modules; selected workers load `lib/lua/5.5/titan.so` or `titan.dll` from their SDK (matching the worker's Lua/Titan ABI). The router watches that file's stat identity for restarts, and the worker hashes its bytes into cache compatibility.
- **Standard-library inventory:** `inventory.validate` in [`scripts/standard-interface-inventory.lua`](../scripts/standard-interface-inventory.lua) accepts either the 23-module baseline or the full 26-module set including `titan.protobuf`, `titan.thread`, and `titan.transfer`. On Unix, build-time code generation embeds metadata-only interfaces from `lib/titan/0.6/titan.a` (including the target C type profile) so the compiler typechecks standard-library imports without a C compiler or SDK on disk. On Windows, [`src/server/embedded_interfaces_windows.c`](../src/server/embedded_interfaces_windows.c) reads interfaces from the loaded standard-provider DLL; see [Appendix A](native-build.md#windows-embedded-interfaces).

### Browser analysis

When `titan-config.lua` sets `target = "browser"`, the router validates and watches three SDK assets under `lib/titan-browser/0.6/`: `analysis-target`, `absent-modules`, and `titan.a`. The packaged VSIX ships its own pack at the same relative path; an explicit `compiler_root` uses its own pack exclusively.

The compiler bridge keeps one validated browser analysis handle per worker and supplies it to saved analysis, topology resolution, cache validation, rename preflight, and private completion. A default browser worker registers the executable's bare `titan` support table without opening its native standard-library inventory. Analysis reads Wasm type metadata directly and activates the lazy Emscripten 6.0.13 probe path only for sources that contain foreign C declarations, confining any missing-toolchain error to those files.

## One production composition path

Inside a worker, one linear composition chain owns startup and refresh:

1. `load` in [`src/server/project_loader.titan`](../src/server/project_loader.titan) loads the compatible compiler, evaluates `project_config.load`, validates the workspace cache against compiler and configuration identities, and wires the real analyzer, external resolver, header restater, publication hooks, and background `Restoration` handle.
2. `create` in [`src/server/project_service/project_service.titan`](../src/server/project_service/project_service.titan) builds the `Service` that owns discovery, dependency graph updates, provenance revalidation, and SQLite commits. Unit fixtures inject mock callbacks through the same constructor; tests requiring a real compiler call `project_loader.load`.
3. `create` in [`src/server/application/application.titan`](../src/server/application/application.titan) owns the background restoration Task, directory watchers, refresh chains, semantic view publication, and LSP request handlers. A second scan runs immediately after watcher registration to close the window between initial discovery and live watch events.

Every field on `ProjectConfig` ([`src/server/project_config.titan`](../src/server/project_config.titan)) and `Snapshot` ([`src/server/project_service/project_service.titan`](../src/server/project_service/project_service.titan)) is declared `const`, preventing consumers from rebinding configuration or snapshot members. When accepting initial settings or publishing a `Snapshot`, `Service` isolates its mutable path arrays with array spreads (`{...self.include}`, `{...self.catalog.issues}`) so external callers cannot mutate live service state.

Both the loader and independent rename preflight map normalized settings into named `CompilerConfiguration` fields ([`src/server/compiler_bridge/compiler_bridge.titan`](../src/server/compiler_bridge/compiler_bridge.titan)). `Compiler:configure` compares unchanged fields before parsing flags or joining paths, and `DriverConfiguration:apply` ([`src/server/compiler_bridge/loader.titan`](../src/server/compiler_bridge/loader.titan)) installs and restores driver globals under the `compiler_scheduler` permit ([Chapter 3](compiler-bridge.md)). Analysis, external resolution, and native cache identity all derive resolver options from that accepted state. Compilation and semantic extraction run outside short SQL publication transactions, cancellation drains owned work and restoration before stores close, and structured SQLite, compiler, and async errors preserve diagnostic detail when wrapped as `Service` failures. For cache export and snapshot preparation, `ProjectModule:compiler_input` produces body-free input records, while incremental analysis builds its workset directly from `Service` metadata via `bridge_project` in [`src/server/project_service/analysis_commit.titan`](../src/server/project_service/analysis_commit.titan). Saved-file queries read committed `main.*` SQLite tables ([Chapter 4](sqlite-backend-storage.md#location-and-opening), [Chapter 5](semantic-features.md)), while unsaved completion reads generation-fenced baselines into connection-local `temp.*` tables ([Chapter 6](completion.md#input-and-publication-ownership)).

## Protocol boundary

### Transport and capability negotiation

Both `router.run` and `protocol.run` read `Content-Length`-framed JSON-RPC from stdin and write framed replies exclusively to stdout through one writer Task. The router reuses `protocol.new_input_queue`, `protocol.read_messages`, `protocol.write_messages`, and `response_queue.ResponseQueue`, forwarding original client request bytes after decoding only the routing fields. [Chapter 2](protocol-and-concurrency.md) covers framing limits, `wire` encoding, queue backpressure, and outbound request ownership in detail.

Both modes answer `initialize` through `lifecycle.Lifecycle` ([`src/server/lifecycle.titan`](../src/server/lifecycle.titan)), with workspace-folder support enabled solely in the router. `lsp.client_capabilities` ([`src/server/lsp_types.titan`](../src/server/lsp_types.titan)) parses `window.workDoneProgress` and `initializationOptions.pullDiagnostics` once at initialization so the router advertises the exact capabilities its workers expect.

### Session indexing status aggregation

Clients display one status indicator across all active roots, driven by `titan/indexingStatus` notifications. `Router:publish_indexing` in [`src/server/router/overlays_and_diagnostics.titan`](../src/server/router/overlays_and_diagnostics.titan) folds every claimed root's latest snapshot onto a single monotonic session timeline:

- **Aggregate precedence:** `indexing` while any claimed root indexes; otherwise `failed` while any claimed root's latest snapshot failed (prefixing the root path when more than one root is claimed); otherwise `ready`.
- **Initial scope and counters:** Busy stays `initial = true` until the first session `ready`, and thereafter whenever any indexing root reports `initial = true`. File counters are summed (bounded by the safe integer limit `9007199254740991`) only when every indexing root supplies counts.
- **Epoch monotonicity:** Unchanged visible busy aggregates emit zero frames. After bare busy, the first counted snapshot emits a zero-count baseline in the same epoch; once counted, only non-regressing progress over an identical total stays in that epoch, while other visible busy transitions advance to a fresh bare-busy epoch. Session epochs never reset across worker restarts.
- **Session generation:** `Router.indexing_generation` increments when a claimed root accepts a new `ready` publication, even when hidden behind another root's busy state, and carries forward to the next visible `ready` frame. It is distinct from worker-local saved generations.
- **Lifecycle edge cases:** Starting a worker installs a synthetic initial busy snapshot until its first worker frame arrives. Terminal snapshots survive idle worker eviction; releasing a root excludes its snapshot until reclaimed. Settings or admission failures before worker startup emit an initial bare-busy frame before `failed`, and repairing settings clears prior failure state before any worker restarts.

### Overlay replay and diagnostic ownership

Worker callbacks are fenced by each slot's captured `generation` so frames whose canonicalization suspended across worker exit or replacement cannot resurrect retired state. Diagnostic notifications (`textDocument/publishDiagnostics`) pass through to the client only when `Router:owner_root` confirms the sender owns the document URI.

Every message that can shift ownership (folder add/remove, release, nested discovery, or worker stop) ends in one reconciliation pass (`Router:reconcile` in [`src/server/router/overlays_and_diagnostics.titan`](../src/server/router/overlays_and_diagnostics.titan)):

1. **Buffer migration:** Open documents whose owner changed are closed in the previous owner (`textDocument/didClose`) and opened in the new owner using the router's retained text. Buffers exceeding `document_buffers.limits` are retained as versioned unavailable markers and replayed via `titan/documentUnavailable` rather than falling back to saved bytes.
2. **Stale diagnostic clearing:** Any URI a root published that belongs to another root — or to a stopped worker — is cleared with an empty `textDocument/publishDiagnostics` before the entry is removed from `Slot.published`. After reconciliation, a slot without a worker tracks zero publications. Worker loss clears owned or unowned URIs synchronously (`Slot:clear_worker_diagnostics`) while leaving transferred URIs for ordered reconciliation.
3. **Warm diagnostic replay:** Every worker started while its root is released owes a replay when ownership returns. After old-owner rows clear, any claimed ready worker marked `replay_diagnostics` receives `titan/republishDiagnostics`, which reattaches `Application:set_diagnostics_listener` ([`src/server/application/application.titan`](../src/server/application/application.titan)). Listener attachment is immediate, while replay requires a completed publication for the current saved epoch without a failed refresh; a watcher hint or replacement view arriving during the SQL read invalidates that replay, and the attached listener receives the next accepted publication. A rejected replay stays pending for the next reconciliation; a timed-out replay suppresses retries for that worker generation (`replay_unavailable_generation`).

The router also forwards `$/cancelRequest` to the worker holding the forwarded request ID, remaps worker-to-client requests under router-allocated IDs (`worker_response_body` in [`src/server/router/client_routing.titan`](../src/server/router/client_routing.titan) restores the worker's ID on reply), and answers `titan/workspaceStatus` from the root registry combined with each worker's observed `titan/workerInfo` report (`pid`, `titanRoot`, `probePrefix`).

### Work-done progress and pull diagnostics

`Reporter` in [`src/server/indexing_progress.titan`](../src/server/indexing_progress.titan) owns one `$/progress` period per contiguous refresh chain, embedding the worker's process ID in each progress token so the router forwards `$/progress` verbatim without token rewriting.

Pull diagnostics (`textDocument/diagnostic`) route by document URI to `Application:handle_diagnostic` in [`src/server/application/handlers.titan`](../src/server/application/handlers.titan), which acts as a freshness barrier via `Application:fresh_view_for` in [`src/server/application/indexing_lifecycle.titan`](../src/server/application/indexing_lifecycle.titan). Calling `note_saved_change()` coalesces with any active refresh chain and revalidates every saved input affecting the document (sibling contributors and transitive dependencies) without inspecting a single `FileStamp` shortcut. A clean scan reuses the existing generation and `resultId` so `unchanged` responses work without reanalysis; answers read from `published_diagnostics.read_uri` ([`src/server/published_diagnostics.titan`](../src/server/published_diagnostics.titan)) and encode through `diagnostics.report` ([`src/server/diagnostics.titan`](../src/server/diagnostics.titan)).

---

[Table of Contents](index.md) | Next: [Chapter 2: Framing, JSON-RPC Transport, and Cooperative Concurrency](protocol-and-concurrency.md) →
