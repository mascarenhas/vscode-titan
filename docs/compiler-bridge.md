# Chapter 3: Crossing the Lua and C Boundaries — The Compiler Bridge

A `titan-language-server` executable does not compile the Titan compiler into its binary. Each worker process runs inside an embedded Lua 5.5 state and loads the selected SDK's compiler Lua modules (`titan-compiler.parser`, `checker`, `types`, `driver`, `completion`, and `documentation`) through `package.path` and `package.cpath`. Keeping the compiler external allows one binary to analyze workspaces targeting different Titan SDKs and build targets (see [Chapter 1](server-data-flow.md#compiler-compatibility)).

That design creates a sharp boundary between two worlds. On the compiler side live dynamic Lua tables, process-global registries, and raw C headers. On the server side live `const`-field Titan records, tagged unions, and cooperative `async` Tasks. The modules in [`src/server/compiler_bridge/`](../src/server/compiler_bridge/compiler_bridge.titan) and their four boundary companions—[`compiler_scheduler.titan`](../src/server/compiler_scheduler.titan), [`compiler_io.titan`](../src/server/compiler_io.titan), [`embedded_interfaces.titan`](../src/server/embedded_interfaces.titan), and [`selected_interfaces.titan`](../src/server/selected_interfaces.titan)—enforce that separation so untyped Lua values never leak into the rest of the server.

## Lua search paths and SDK isolation

Before any compiler module loads, [`src/server/lua_paths.titan`](../src/server/lua_paths.titan) configures the embedded Lua interpreter's module search paths. `configure` applies `TITAN_LS_LUA_PATH` and `TITAN_LS_LUA_CPATH` (defaulting to `./?.lua` and `./?.so`, or `./?.dll` on Windows). When a worker selects an external SDK prefix, `select_compiler_root` points `package.path` and `package.cpath` at `<prefix>/share/lua/5.5` and `<prefix>/lib/lua/5.5`, sets `TITAN_ROOT`, and calls `os.unsetenv` on `TITAN_PATH_0_6`, `TITAN_PATH`, and `TITAN_SOURCE_PATH`.

Removing those variables rather than assigning `""` is required by Lua truthiness. The compiler driver checks `platform.getenv("TITAN_PATH_0_6") or platform.getenv("TITAN_PATH")`, where `""` is truthy and would replace the selected SDK's default provider directory with an empty search path.

## The seven-file folder module and the initialization frontier

The compiler bridge is implemented as one logical Titan folder module, `server.compiler_bridge`, split across seven sibling `.titan` files under [`src/server/compiler_bridge/`](../src/server/compiler_bridge/compiler_bridge.titan):

| File | Responsibility and key symbols |
| --- | --- |
| [`compiler_bridge.titan`](../src/server/compiler_bridge/compiler_bridge.titan) | Folder main: imports, `local const` tables (`COMPILER_ABI`, `NORMALIZATION_YIELD_CADENCE`, `AST_CHILD_FIELDS`), exported and shared types (`Compiler`, `ModuleSnapshot`, `Node`, `SymbolOccurrence`, `CHeaderDependencyKind`, `Analysis`, `CompletionHole`), process-wide SDK selection state, and narrow Lua validators (`required_map`, `checked_function`). |
| [`loader.titan`](../src/server/compiler_bridge/loader.titan) | Compiler loading (`load`, `load_with`), ABI and language-server API validation, `DriverConfiguration` save/restore (`Compiler:install_configuration`, `DriverConfiguration:apply`), `Compiler:configure`, resolver context lifecycle (`Compiler:new_context`, `Compiler:close_context`, `Compiler:close_loader`), browser target bootstrap (`accept_browser_analysis`), and target-label helpers (`host_target`, `classify_source_filename`). |
| [`headers_and_providers.titan`](../src/server/compiler_bridge/headers_and_providers.titan) | C-probe trace normalization (`CProbeSemanticTrace`, `CProbeExecutionTrace`), Windows verbatim/UNC path checks (`metadata_absolute_path`), C-header dependency codecs (`normalize_c_header_dependencies`, `Compiler:restat_c_header_dependencies`), external topology resolution (`Compiler:resolve_external_modules`), contextual nominal owners, and binary provider identity fencing (`Compiler:validate_embedded_provider_baseline`). |
| [`hover_summaries.titan`](../src/server/compiler_bridge/hover_summaries.titan) | Cooperative yield accounting (`NormalizationWork`), `O(n log n)` bottom-up `stable_sort<|T|>`, type rendering (`Compiler:render_type`), `normalize_documentation`, declaration-shaped `Compiler:callable_signature`, and memoized module/aggregate hover summaries (`Compiler:module_summary`, `Compiler:aggregate_summary`). |
| [`ast_walker.titan`](../src/server/compiler_bridge/ast_walker.titan) | `Walker` and `Walker:visit_node` over `AST_CHILD_FIELDS`, exact `_name_loc` occurrence spans, shorthand union-part dual identity, `Compiler:imports_from_ast`, diagnostic parsing (`parse_diagnostic`), manifest serialization (`Compiler:serialize_manifest`), and `Compiler:snapshot_module`. |
| [`analysis.titan`](../src/server/compiler_bridge/analysis.titan) | Per-attempt `driver.imported` and `types.registry` isolation (`Compiler:run_attempt_inner`, `Compiler:run_attempt`), `compact_project_entry` body stripping, transitive failure propagation (`failed_projects`), browser foreign-owner tracking (`browser_foreign_owners`), and incremental orchestration (`Compiler:analyze_incremental`). |
| [`cache_and_completion.titan`](../src/server/compiler_bridge/cache_and_completion.titan) | Persistent cache adapter hooks (`Compiler:configure_cache`), project payload export/restore (`Compiler:export_projects`, `Compiler:restore_project_cache`), completion hole setup (`prepare_completion`), `defer`-restored `Compiler:observe_completion_facts`, closed-world `Compiler:analyze_completion`, binary catalog merging, and cache digests (`Compiler:cache_identity`, `Compiler:native_cache_identity`). |

Splitting into a folder module keeps every `local` field on `Compiler` and every private helper directly accessible across all seven files without creating intermediate modules or public escape hatches.

The layout follows Titan's **folder-main initialization frontier rule**. When `titanc` compiles a folder module, it orders top-level declarations with the folder main first, followed by contributors sorted bytewise by logical filename, followed by any root initializer. Types, records, unions, and functions are visible across the entire module regardless of order, whereas a module-variable declaration sees only *earlier* ordinary imports and module variables in its type annotation and initializer. Placing all imports, `local const` tables, module-scoped caches (`browser_analysis`, `selected_compiler_root`, `selected_snapshot`), and core types in [`compiler_bridge.titan`](../src/server/compiler_bridge/compiler_bridge.titan) places them ahead of every contributor's frontier.

## Serializing the shared Lua state

All bridge instances in a worker process share one embedded Lua state. Every compiler invocation temporarily replaces process-global fields on `driver` and `types`—`driver.imported`, `types.registry`, `TITAN_SOURCE_PATH`, `TITAN_BIN_PATH`, and `EXTRA_CPPFLAGS`—and yields cooperatively while `CompilerIO` awaits filesystem or C-preprocessor I/O. Only one Task may own that Lua state at a time.

[`src/server/compiler_scheduler.titan`](../src/server/compiler_scheduler.titan) provides a process-wide FIFO permit (`acquire`) backed by `Scheduler`. Rather than allocating a release closure on every uncontended acquisition, `Permit` stores `local const owner: Scheduler` and an idempotent `local released: boolean` flag:

```titan
record Permit
  local const owner: Scheduler
  local released: boolean
end

function Scheduler:acquire(): Permit
  if not self.active then
    self.active = true
    -- ...
    return Permit(self, false)
  end

  local waiter = Waiter(
    async.running(), async.ResumeToken("server.compiler_scheduler"),
    true, false)
  self.waiters[#self.waiters + 1] = waiter
  -- ...
  local abandon = function () self:abandon(waiter) end
  do
    async.suspend(waiter.resume_token, abandon)
    waiter.queued = false
    -- ...
    return Permit(self, false)
  catch
    self:abandon(waiter)
    raise
  end
end

function Permit:release()
  if self.released then return end
  self.released = true
  -- ...
  self.owner:release_owner()
end
```
*Source: [`src/server/compiler_scheduler.titan`](../src/server/compiler_scheduler.titan) — `Permit`, `Scheduler:acquire`, `Permit:release`*

When `Scheduler:grant_next` wakes a parked waiter, it sets `waiter.reserved = true` while leaving `waiter.queued = true` until the resumed Task clears it after `async.suspend`. Because libuv delivers resumes through a timer callback, cancellation can arrive after `grant_next` cleared the suspension hook and before the Task executes the line after `async.suspend`. The `catch` block calls `self:abandon(waiter)`, sees both `queued` and `reserved`, and forwards ownership to the next waiter instead of deadlocking the scheduler.

Inside a permit scope, every bridge entry point restores Lua globals lexically via `defer`—`defer permit:release()`, `defer previous_configuration:apply()`, `defer self.driver["imported"] = previous_imported`, and `defer self.types["registry"] = previous_registry` in `Compiler:run_attempt_inner` ([`src/server/compiler_bridge/analysis.titan`](../src/server/compiler_bridge/analysis.titan)). Resolver teardown (`Compiler:close_context` and `Compiler:close_loader` in [`src/server/compiler_bridge/loader.titan`](../src/server/compiler_bridge/loader.titan)) adds one more safeguard: if sticky cancellation aborts cleanup I/O on the unwinding Task, the `catch` arm spawns an uncancelled `async.run` Task that acquires the permit and completes the close.

## Narrow Lua table decoding and typed codecs

Every call across `titan.lua` returns `value`. Bridge code validates Lua tables at the boundary and constructs immutable Titan records or unions immediately, raising `BridgeError` through `fail<|T|>` on any schema mismatch. `load_with` in [`src/server/compiler_bridge/loader.titan`](../src/server/compiler_bridge/loader.titan) verifies `driver.TITAN_ABI_VERSION` (`"2"`), `driver.LANGUAGE_SERVER_API_VERSION` (`1`), and every required compiler function upfront via `checked_function`:

```titan
local function required_map(candidate: value, module_name: string,
                            subject: string): {string: value}
  if not (candidate is {string: value}) then
    return fail<|{string: value}|>(
      module_name, subject .. " must be a Lua table")
  end
  return candidate as {string: value}
end

local function checked_function(module: {string: value},
                                module_name: string, member: string,
                                type_of: TypeOfFunction): value
  local candidate: value = module[member]
  if type_of(candidate) ~= "function" then
    return fail<|value|>(module_name,
      "compiler API member '" .. member .. "' must be a function, found " ..
      describe(candidate, type_of) ..
      ". Install a Titan compiler implementing " ..
      COMPILER_LANGUAGE_SERVER_API_MARKER .. " " ..
      COMPILER_LANGUAGE_SERVER_API)
  end
  return candidate
end
```
*Source: [`src/server/compiler_bridge/compiler_bridge.titan`](../src/server/compiler_bridge/compiler_bridge.titan) — `required_map`, `checked_function`*

For numeric fields, `required_integer` assigns `candidate` directly to `local result: integer = candidate` inside a `catch` block instead of using `as integer`. Titan's implicit `value -> integer` projection enforces an exact Lua integer tag and rejects integral floats such as `2.0`, catching subtle Lua serialization drift early.

Enumerated compiler tags cross the boundary as tagged unions carrying their own codec methods so textual compiler strings and persisted SQLite integer codes live in one place:

```titan
union CHeaderDependencyKind
  file()
  search()
  origin()
end

--- Return the persisted SQLite integer code for a C-header dependency kind.
function CHeaderDependencyKind:code(): integer
  case self
  when file() then return 0
  when search() then return 1
  when origin() then return 2
  end
end
```
*Source: [`src/server/compiler_bridge/compiler_bridge.titan`](../src/server/compiler_bridge/compiler_bridge.titan) — `CHeaderDependencyKind`, `CHeaderDependencyKind:code`*

Paired functions `CHeaderDependencyKind:name`, `header_dependency_kind_from_name`, and `header_dependency_kind_from_code` complete the bidirectional mapping used by [`headers_and_providers.titan`](../src/server/compiler_bridge/headers_and_providers.titan) and [`src/server/header_store.titan`](../src/server/header_store.titan).

## DAG-safe AST walking, hover summaries, and cooperative yield budgets

After `driver.defaultloader` finishes checking a root module, `Compiler:snapshot_module` in [`src/server/compiler_bridge/ast_walker.titan`](../src/server/compiler_bridge/ast_walker.titan) normalizes each checked project module into flat `Node`, `SymbolOccurrence`, `Import`, and `HoverSummary` arrays. External source modules take a fast path: `Compiler:imports_from_ast` reads only top-level `Ast.TopLevelImport` nodes and discards the external AST immediately without walking bodies or formatting hover summaries. Immediately after snapshot extraction succeeds for a project module, `Compiler:run_attempt_inner` in [`src/server/compiler_bridge/analysis.titan`](../src/server/compiler_bridge/analysis.titan) calls `driver.compact_project_entry` to retain only the declared manifest in `Compiler.project_entries` and drop function bodies from memory.

Compiler-annotated ASTs are not strict trees. Lowering attaches backreferences and shared descriptors onto AST nodes—for example, `Ast.ExpSpreadIndex.spread` points back to the spread carrier emitted earlier in the same expression list, which could mis-parent that carrier if traversal order changed. `Walker:visit_node` therefore walks only the explicit lexical child list in `AST_CHILD_FIELDS` and tracks visited tables in `Walker.seen`:

```titan
local const AST_CHILD_FIELDS: const {string} = {
  "typeparams", "typeargs", "_nominal_typeargs",
  "_surface_named_args",
  "constraint", "class", "params",
  "argtypes", "rettypes", "varargtype", "flexrettype", "block",
  "decl", "decls", "value", "values", "type", "fields", "variants", "parts",
  "name",
  "members", "methods", "stats", "condition", "start", "finish",
  "inc", "exps", "vars", "callexp", "exp", "first", "last",
  "var", "arms",
  "elseblock", "thens", "elsestat", "catchblock", "finallyblock",
  "exp1", "exp2", "lhs", "rhs", "target", "args", "subtype",
  "base", "keystype", "valuestype", "basetype",
  "bindings", "index", "owner", "variant", "method",
}
```
*Source: [`src/server/compiler_bridge/compiler_bridge.titan`](../src/server/compiler_bridge/compiler_bridge.titan) — `AST_CHILD_FIELDS`*

During traversal, `exact_occurrence_span` accepts only identifiers carrying the compiler's `_name_loc` marker, preventing synthetic constructor or implicit coercion lowerings from turning diagnostic locations into navigation or rename spans. Shorthand named union `case` patterns (`when variant{part}`) record both their local binding identity (`declaration_id`) and the selected union payload part (`case_part_id`) on one `SymbolOccurrence` so rename can expand shorthands cleanly (see [Chapter 5](semantic-features.md)).

While compiler declaration graphs remain live, [`src/server/compiler_bridge/hover_summaries.titan`](../src/server/compiler_bridge/hover_summaries.titan) formats declaration-shaped `CallableSignature` strings (preserving parameter names omitted by flattened `TypeInfo` strings) and builds memoized `HoverSummary` tables for modules, records, unions, and interfaces—respecting non-transitive `.titan` source-import visibility (`include_source`). Large modules or multi-module batches could starve protocol I/O Tasks if normalization ran synchronously to completion, so every traversal step, diagnostic parse, and bottom-up `stable_sort<|T|>` comparison charges one shared `NormalizationWork` budget:

```titan
local record NormalizationWork
  pending: integer
end

local function NormalizationWork:account()
  self.pending = self.pending + 1
  if self.pending < NORMALIZATION_YIELD_CADENCE then return end
  self.pending = 0
  async.yield()
end
```
*Source: [`src/server/compiler_bridge/hover_summaries.titan`](../src/server/compiler_bridge/hover_summaries.titan) — `NormalizationWork`, `NormalizationWork:account`*

With `NORMALIZATION_YIELD_CADENCE` set to `1024`, a burst of many small snapshots yields at the same deterministic cadence as a single large module.

## Declaration documentation

Titan's compiler parses LDoc-style documentation comments attached to modules, top-level declarations, record fields, union variants, and Interface methods. The language server presents that documentation below the type, signature, and visibility block in hover, and in a completion item's documentation pane.

```titan
--- Select a count.
-- @param count The returned number.
-- @return The selected integer.
-- @usage functions.md#named-calls
function select(count: integer): integer
  return count
end
```

A leading module comment uses `@module` to distinguish itself from the first declaration's comment. Ordinary `--` comments and comment-like text inside string literals do not become documentation. The compiler's [documentation comment manual](https://github.com/mascarenhas/titan/blob/master/doc/language/modules.md#documentation-comments) defines attachment rules and supported comment forms.

### Rendering and manual-link sanitization

The compiler supplies a detached `summary`, `description`, and ordered list of `tags` from `titan-compiler.documentation`. `normalize_documentation` in [`src/server/compiler_bridge/hover_summaries.titan`](../src/server/compiler_bridge/hover_summaries.titan) validates that table into `documentation.Documentation` and `documentation.Tag` records. `Documentation:markdown` in [`src/server/documentation.titan`](../src/server/documentation.titan) formats `@param`/`@tparam`, `@field`/`@tfield` (through `named_tag`), `@return`/`@treturn`, `@usage`, `@see`, and arbitrary extension tags as Markdown in source order, retaining repeated tags and skipping structural tags (`@module`, `@name`, `@class`).

A `@usage` or `@see` value matching a safe relative Markdown path (`.md`, optionally with a `#fragment`, no leading `/`, and no `..`) resolves against `MANUAL_ROOT`, Titan's upstream `doc/language/` tree. Other `@usage` values render as fenced `titan` code blocks, and other `@see` values render as plain text. Because compiler metadata stores the relative path rather than a full URL, documentation hosting can change without rebuilding compiled providers:

```titan
local const MANUAL_ROOT = "https://github.com/mascarenhas/titan/blob/master/doc/language/"

local function manual_link(value: string): string?
  if strings.match(value, "^[A-Za-z0-9_./#-]+$") == nil or
      strings.sub(value, 1, 1) == "/" or
      strings.find(value, "..") ~= nil or strings.find(value, ".md") == nil then
    return nil
  end
  return MANUAL_ROOT .. value
end
```
*Source: [`src/server/documentation.titan`](../src/server/documentation.titan) — `MANUAL_ROOT`, `manual_link`*

````titan
function Documentation:markdown(): string
  local output = strings.writer()
  output:write(self.summary)
  if self.description ~= "" then output:write("\n\n" .. self.description) end
  for index = 1, #self.tags do
    local tag = self.tags[index]
    if tag.name ~= "module" and tag.name ~= "name" and tag.name ~= "class" then
      output:write("\n\n")
      if tag.name == "param" or tag.name == "tparam" then
        named_tag(output, "Parameter", tag.value, tag.name == "tparam")
      elseif tag.name == "field" or tag.name == "tfield" then
        named_tag(output, "Field", tag.value, tag.name == "tfield")
      elseif tag.name == "return" or tag.name == "treturn" then
        output:write("**Returns:** " .. tag.value)
      elseif tag.name == "usage" then
        local link? = manual_link(tag.value)
        if link ~= nil then
          output:write("[More information](" .. link .. ")")
        else
          output:write("**Usage:**\n\n```titan\n" .. tag.value .. "\n```")
        end
      elseif tag.name == "see" then
        local link? = manual_link(tag.value)
        if link ~= nil then output:write("[See also](" .. link .. ")")
        else output:write("**See also:** " .. tag.value) end
      else
        output:write("**" .. tag.name .. ":** " .. tag.value)
      end
    end
  end
  return output:drain()
end
````
*Source: [`src/server/documentation.titan`](../src/server/documentation.titan) — `Documentation:markdown`*

### Saved and unsaved documentation

Saved publication stores rendered Markdown beside scalar occurrences, completion members, and module descriptors. Hover and completion queries read those SQL columns directly without traversing ASTs or decoding compiler metadata. Compiled provider interfaces, retained project descriptors, and unchanged warm startups all preserve documentation. Editing a documentation comment changes the declared manifest, refreshing dependent source facts.

Unsaved documentation follows the completion capture rules in [Chapter 6](completion.md#input-and-publication-ownership). Private preparation renders documentation from the captured active module and committed dependency descriptors; an unsaved editor buffer for a dependency never overrides that dependency's saved documentation. Hover after completion shares the session, version, contributor, and saved-generation identity of its completion context, and editing a comment retires that context.

[`src/server/documentation_test.titan`](../src/server/documentation_test.titan) verifies Markdown formatting and manual-link sanitization (`test_documentation_formats_prose_tags_and_relative_manual_links`, `test_documentation_retains_literal_usage_and_absent_description`, `test_documentation_formats_typed_and_optional_parameters`). Bridge, store, and stdio protocol tests cover typed rejection, persistent and TEMP round trips, cached dependency completion, and comment-edit invalidation.

## C FFI ownership, Lua proxies, and child processes

Four small modules beside `compiler_bridge/` handle the remaining native and host-runtime boundaries.

### Owned C buffers for content digests

[`src/server/content_identity.titan`](../src/server/content_identity.titan) hashes saved source bytes, manifest comparisons, and cache keys through OpenSSL's `SHA256`, which is linked with the server's static provider. Allocating the 32-byte digest buffer as `owned unsigned char[]` hands lifetime management to Titan's GC while passing a raw C pointer directly to `ffi.SHA256`:

```titan
foreign import "openssl/sha.h"

function digest(contents: string): string
  local output: owned unsigned char[] = foreign unsigned char.new_array(32)
  if ffi.SHA256(contents, #contents, output) == nil then
    raise "cannot hash saved input"
  end
  return output as string
end
```
*Source: [`src/server/content_identity.titan`](../src/server/content_identity.titan) — `digest`*

### Raw Lua C API stack hygiene

When a worker uses its own build SDK, [`src/server/embedded_interfaces.titan`](../src/server/embedded_interfaces.titan) exposes the metadata-only standard-library interface table and native provider identity compiled into the executable via [`src/server/embedded_interfaces_native.h`](../src/server/embedded_interfaces_native.h). Neither `provider` nor `identity` initializes native `titan.*` modules. Every raw Lua C API entry records `ffi.lua_gettop(L)` on entry and restores it unconditionally with `defer ffi.lua_settop(L, top)`:

```titan
function provider(): ({string: value}, {string: value})
  local top = ffi.lua_gettop(L)
  defer ffi.lua_settop(L, top)
  if ffi.lua_checkstack(L, 2) == 0 then
    raise "cannot reserve Lua stack for embedded compiler interfaces"
  end
  local results = ffi.titan_ls_push_embedded_interface_provider(L)
  if results ~= 1 then
    raise "embedded compiler interface provider returned " ..
          (results as integer) .. " values instead of one"
  end
  local raw: value = ffi.lua_totvalue(L, -1)
  if not (raw is {string: value}) then
    raise "embedded compiler interface provider must return a Lua table"
  end
  return raw as {string: value}, pushed_identity()
end
```
*Source: [`src/server/embedded_interfaces.titan`](../src/server/embedded_interfaces.titan) — `provider`*

### Lua userdata proxy isolation in `CompilerIO`

[`src/server/compiler_io.titan`](../src/server/compiler_io.titan) supplies the Task-aware filesystem and process strategy passed to `driver.lua`. Because the compiler invokes `CompilerIO` through its standard Titan userdata proxy, every method on `CompilerIO` (`cwd`, `realpath`, `stat`, `lstat`, `readable`, `executable`, `read_file`, `write_file`, `list`, `mkdir`, `unlink`, `rmdir`, `rename`, `tmpname`, `yield`, `run`) returns only Lua-native scalars and Maps, and re-raises `async.CancellationReason` rather than turning cancellation into a compiler I/O error string.

Server-only observability and provenance state stays off the Lua proxy by combining `local` record fields with module-level lifecycle functions:

```titan
record CompilerIO
  local proxy_marker: boolean
  local next_attempt: integer
  local progress: CompilerProgress?
  local checkpoint_listener: CheckpointListener?
  local observing_lstats: boolean
  local lstat_observations: {string: LstatObservation}
end

function begin_lstat_observations(strategy: CompilerIO)
  strategy.observing_lstats = true
  strategy.lstat_observations = {}
end

function end_lstat_observations(strategy: CompilerIO)
  strategy.observing_lstats = false
  strategy.lstat_observations = {}
end
```
*Source: [`src/server/compiler_io.titan`](../src/server/compiler_io.titan) — `CompilerIO`, `begin_lstat_observations`, `end_lstat_observations`*

An empty public record receives no Lua-visible userdata member table, so the inert `proxy_marker` field ensures `CompilerIO` exposes the userdata proxy expected by `driver.lua`. Keeping `begin_lstat_observations`, `end_lstat_observations`, `consistent_lstat_identity`, `set_checkpoint_listener`, `begin_attempt`, and `finish_attempt` as module functions prevents Lua compiler code from inspecting or mutating bridge telemetry.

During incremental analysis, `CompilerIO:lstat` follows each candidate path with `fs.stat` to record a consistent `LstatIdentity`; if repeated lookups of a provider path disagree mid-analysis, `consistent_lstat_identity` returns `nil` so `project_service` rejects the publication instead of caching a torn binary provider. `CompilerIO:yield` notifies `checkpoint_listener` before calling `async.yield()` so cancellation cannot hide a module the compiler has published. `CompilerIO:run` launches external C preprocessors with `os.spawn`, drains stdout and waits for exit concurrently via `async.join_two`, measures child wall time through [`src/server/compiler_io_clock.h`](../src/server/compiler_io_clock.h) (`ffi.vscode_titan_monotonic_ms`), and kills the child on cancellation; `write_atomic`, `mkdir`, `unlink`, and `tmpname` hand rollback cleanup to uncancelled child Tasks whenever sticky cancellation blocks further I/O on the caller.

### Uncancelled child-process retirement for selected SDKs

On Windows, selecting an external `compiler_root` extracts that SDK's standard-library interface inventory in a separate `bin/lua.exe -E -` child process ([`src/server/selected_interfaces.titan`](../src/server/selected_interfaces.titan)), isolating incompatible provider DLLs from the server's own process. `Extraction:read` spawns the child, runs stdin program writing, bounded diagnostic reading, and process reaping concurrently through `async.join_three(writer, reader, waiter)`, and validates the decoded `graphcodec` payload with `content_identity.digest`.

Because the child Task owns both the live `os.Process` and a temporary output file (`defer fs.unlink(output)`), `extract` runs `job:read` in an uncancelled child Task. When the caller is cancelled, `extract` kills the child process through `job:cancel()` and blocks without a cancellation checkpoint in `wait_for_retirement` until the child closes every stream and unlinks its temporary file:

```titan
local function wait_for_retirement(task: async.Task<|ExtractionResult, value|>)
  if task:status():has_finished() then return end
  local remove: (function (): ())? = nil
  defer do if remove ~= nil then remove() end end
  async.await_cleanup<|nil, nil|>(function (resolve: function (nil): (),
      _: function (nil): (), _fatal: function (value, string): ())
    remove = task:add_terminal_listener(function (_: async.TaskStatus<|ExtractionResult, value|>)
      resolve(nil)
    end)
  end)
end
```
*Source: [`src/server/selected_interfaces.titan`](../src/server/selected_interfaces.titan) — `wait_for_retirement`*

With the compiler bridge serialized, validated, and isolated from Lua and native host failures, [Chapter 4](sqlite-backend-storage.md) follows those typed snapshots into incremental discovery, dependency invalidation, and SQLite storage.

---

← Previous: [Chapter 2](protocol-and-concurrency.md) | [Table of Contents](index.md) | Next: [Chapter 4: Incremental Indexing, Provenance, and SQLite Storage](sqlite-backend-storage.md) →
