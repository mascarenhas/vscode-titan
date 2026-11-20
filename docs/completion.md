# Chapter 6: Unsaved Buffers — Private Completion and Live Hover

Completion analyzes unsaved editor buffers against one committed saved baseline, and once a completion request activates private analysis, hover follows edits to the active module as well. Definition, references, rename, folding, and diagnostics remain anchored to saved files.

At startup, `Coordinator:configure_completion` in [`src/server/coordinator.titan`](../src/server/coordinator.titan) enables document synchronization and completion routing. `initialize_result` in [`src/server/lifecycle.titan`](../src/server/lifecycle.titan) advertises full-document sync (`change: 1`), `.` and `:` trigger characters, and `labelDetailsSupport`. Explicit completion invocation works in lexical, import-name, qualified-type, and foreign-type positions. Inside a `foreign function`, where signatures and bodies write C types without a `foreign` prefix, types after `:` (parameters, results, locals, numeric `for`) and casts after `as` are foreign-type positions determined from tokens before the caret; those positions offer only C primitives and the module's C environment.

Candidates originate from compiler lookup at the caret: lexical bindings, visible module members, constructors and static functions, record and interface fields, instance methods, C aggregate fields, and the `ffi` value binding. Foreign types occupy a separate C namespace unaffected by local `ffi` shadowing. Direct `.titan` source imports retain their private Titan visibility, and C include inheritance follows compiler rules. Declaration and module doc comments appear in completion documentation and hover; see [Declaration documentation](compiler-bridge.md#declaration-documentation).

Completion edits replace the entire active identifier, including any suffix after the caret. Foreign-type completions replace only the name leaf while preserving pointer and qualifier syntax, and multiword C primitives insert their complete spelling. Comments and unrelated string literals produce no candidates, and unresolved receivers or syntax errors can yield empty or incomplete lists.

Private analysis inherits the worker's accepted target and committed saved baseline; shadowed and inactive target variants never contribute candidates. For a browser root, import completion includes the accepted SDK's eligible module inventory even before any source file is saved (`Compiler:completion_binary_catalog` with `seed_browser`), and member completion reads Wasm interfaces from that captured catalog. If saved source overlaps a browser archive module, its catalog siblings stay hidden until the overlap is removed and a new saved view commits. Changing the target starts a fresh worker and replays open editor buffers without carrying over the previous worker's temporary completion or hover facts.

## Callable presentation and insertion

`Compiler:completion_presentation` in [`src/server/compiler_bridge/cache_and_completion.titan`](../src/server/compiler_bridge/cache_and_completion.titan) formats callables appearing in value and foreign-value positions. `label` and `filterText` remain the bare identifier, `detail` carries the full declaration signature (parameter names, generic parameters, and results), and clients advertising `labelDetailsSupport` receive the signature suffix in `labelDetails.detail`.

For snippet-capable clients, callable items carry a call snippet such as `choose(${1:first}, ${2:second})$0` using declared parameter names as placeholders (`arg1`, `arg2`, and so on when parameters are unnamed, without inventing names in the displayed signature). Placeholders escape `\`, `$`, and `}`. Bound methods include only explicit arguments; zero-argument callables insert `name()$0`; a variadic-only callable inserts a single empty tab stop (`$1`). Type positions, including function type aliases, always insert plain names. `completion_call_snippet` in [`src/server/lsp_types.titan`](../src/server/lsp_types.titan) suppresses the snippet when call or generic arguments (`(`, `{`, `<|`, quoted or long-bracket strings) already follow the identifier across whitespace or comments while keeping the whole-token replacement range.

`titan.completion.insertCallSnippets` defaults to `true` (standalone clients send `initializationOptions.insertCallSnippets: false`). Disabling it inserts plain identifiers when taking function or bound-method references, because the compiler's completion context does not expose an expected callable type at the caret. Clients lacking `snippetSupport` always receive plain text; signature display is independent of insertion policy.

Because the compiler's scalar completion facts omit declaration parameter names, private preparation attaches a scoped observer around `titan-compiler.completion`'s `fact` function while specialized types and declarations are live. `Compiler:analyze_completion` installs the wrapper under the compiler permit and restores the original function via `defer` on every exit, keeping saved compiler descriptors untouched:

```titan
local function Compiler:observe_completion_facts(): function (): ()
  local module = completion_module()
  local previous: value = module["fact"]
  local original = previous as function (...: value): (...: value)
  module["fact"] = function (name: value, candidate: value, declaration: value,
      domain: value, owner: value, mode: value, depth: value,
      private: value, spelling_only: value): value
    local fact: value = original(name, candidate, declaration, domain, owner,
      mode, depth, private, spelling_only)
    if fact ~= nil then
      local row = required_map(fact, "titan-compiler.completion", "candidate")
      self:completion_presentation(row, name, candidate, declaration)
    end
    return fact
  end
  return function () module["fact"] = previous end
end
```
*Source: [`src/server/compiler_bridge/cache_and_completion.titan`](../src/server/compiler_bridge/cache_and_completion.titan) — `Compiler:observe_completion_facts`*

## Hover from recent completion

Each accepted private preparation also writes per-occurrence rendered Markdown (`PreparedView:completion_hovers`) for every captured contributor of the active logical module. Hover queries read those scalar TEMP rows without rechecking source or decoding compiler descriptors. `completion_hovers` in [`src/server/completion_service.titan`](../src/server/completion_service.titan) maps byte spans back across the synthetic hole delta and drops any span touching the dummy identifier, preserving original UTF-16 coordinates before and after the hole.

The first completion request activates live private hover for the active document and logical module. Subsequent buffer edits — including accepting a call snippet — coalesce behind a 200 ms trailing debounce (`HOVER_DEBOUNCE_MS`). Newer edits cancel superseded preparation, and explicit completion requests preempt queued hover refreshes. Debounced hover preparation checks the raw captured editor bytes without a completion hole, so newly inserted callees and arguments gain exact hover facts without another completion trigger while imports read one committed saved baseline.

When a usable preparation finishes, it atomically replaces the accepted `HoverContext`. During debounce, compilation, or transient syntax errors, the preceding accepted snapshot stays queryable with its original version and saved-generation provenance. `HoverContext:follow` records one conservative common-prefix/common-suffix `ByteChange` (`changed_bytes`) per full-sync edit, up to 64 changes per contributor (`exhausted` beyond that). `Service:read_hover` maps the current caret byte backward (`HoverFile:original_offset`), queries `temp.retained_hovers` under the SQLite lease, maps the hit span forward (`HoverFile:current_span`), and rejects the match if any edit touched the occurrence, altered its token bytes, or joined adjacent identifier characters at either boundary. Two disjoint edits inside one full-sync payload conservatively omit occurrences between them. Untouched occurrences display their retained type and documentation without ever being relabeled as current-version facts, and provisional completion candidates never authorize hover.

```titan
local const HOVER_DEBOUNCE_MS = 200
-- ...
function Service:hover(capture: buffers.Capture): dispatcher.SemanticOutcome?
  for _ = 1, 2 do
    local context? = self.hover_context
    if self.closed or context == nil or not self.buffers:current(capture) then return nil end
    local outcome? = self:read_hover(capture, context)
    if outcome ~= nil then return outcome end
    -- An accepted artifact may change while the lookup waits for SQL. Retained
    -- original rows cover that handoff; retry once also finds a newly available
    -- occurrence that was absent from the previous completion-hole snapshot.
    if self.hover_context == context then return nil end
  end
  return nil
end
```
*Source: [`src/server/completion_service.titan`](../src/server/completion_service.titan) — `HOVER_DEBOUNCE_MS`, `Service:hover`*

Hover requests capture exact editor inputs synchronously in `Application:capture_hover` before scheduling a `Task`, rejecting results superseded during SQL reads. Closing and reopening a document or exceeding a contributor's buffer cap retires its context; reopening the active path schedules fresh analysis under a new session that cannot borrow prior occurrences. Saving keeps the accepted hover active while the watcher reindexes disk; committing the new saved generation queues reanalysis against the updated baseline.

Dirty text before the first completion returns no hover result, as does any occurrence without a safe edit mapping. Clean open text matching committed bytes and closed documents use saved hover (`Features:matches_source`). Preparations that depend on unsaved-only C headers (`volatile_headers`) are never retained for hover because those headers lack watcher-owned freshness.

Optional hover rows are capped at 4 MiB and 100,000 occurrences (`MAX_HOVER_BYTES` and `MAX_HOVER_ROWS` in [`src/server/completion_types.titan`](../src/server/completion_types.titan)), counted inside the shared TEMP snapshot budget. Dedicated `temp.retained_hover_*` tables isolate accepted hover from candidate eviction and saved-generation cleanup. `Store:publish_hover` retains one preceding artifact (`previous_id`) across pointer swap so a lookup queued behind SQL publication finishes cleanly against its captured snapshot ID; the following publication retires it, and `Service:hover` retries once if `hover_context` advanced during the wait. Fresh completion candidates become visible only after their usable hover artifact is accepted, covering immediate snippet selection. Exceeding a hover cap preserves valid completion candidates and retains the prior accepted hover artifact; process exit drops all TEMP rows.

## Input and publication ownership

`BufferStore` in [`src/server/document_buffers.titan`](../src/server/document_buffers.titan) assigns a fresh monotonic `session` to each open document, accepts strictly increasing versions, and tracks retained byte totals. Before the coordinator spawns a request `Task`, `BufferStore:capture` freezes an immutable `Capture` containing `const {Input}` and `const {string}` views:

```titan
record Capture
  const document: Input
  const inputs: const {Input}
  const unavailable_paths: const {string}
  const epoch: integer
  const position: source_text.Position
end
-- ...
function BufferStore:capture(path: string, position: source_text.Position): Capture?
  if self.capacity_exceeded then return nil end
  local state? = self:find(path)
  if state == nil or state.input == nil then return nil end
  local unavailable: {string} = {}
  for index = 1, #self.documents do
    if self.documents[index].input == nil then
      unavailable[#unavailable + 1] = self.documents[index].path
    end
  end
  local unavailable_paths = unavailable as const {string}
  return Capture {
    document = state.input,
    inputs = self:inputs(),
    unavailable_paths = unavailable_paths,
    epoch = self.revision,
    position = position,
  }
end
```
*Source: [`src/server/document_buffers.titan`](../src/server/document_buffers.titan) — `Capture`, `BufferStore:capture`*

Every open selected contributor of the active folder module participates in private analysis (`Request:active_module`), while open inactive target variants contribute nothing and receive no semantic completion. Editor text in other modules is ignored so imports resolve against one committed saved baseline.

For an unsaved file not yet present in `main.semantic_files`, `find` in [`src/server/completion_discovery.titan`](../src/server/completion_discovery.titan) proves unambiguous module ownership purely from captured roots, include/exclude filters, inactive-variant paths, open paths, and the committed baseline — without filesystem I/O. It imports `server.project_discovery` through its ordinary compiled public interface (`relative_parent`, `valid_path_components`, `valid_module_name`, `module_path`, `terminal_component`, `module_owner`), avoiding production `.titan` source imports across server modules. Known saved ownership remains authoritative; untitled, unmapped, inactive, ambiguous, excluded, and uncovered paths yield no candidates.

The watcher commits `main.completion_*` configuration, provenance, source and header inventories, scalar members, and body-free descriptors (`completion_store.publish_saved`) in the same SQLite transaction as saved semantic facts. Completion reads only committed baselines, never mutable graph rows, and warm startup retains the committed catalog without waiting for background compiler-manifest restoration.

`Service:prepare` runs a disposable `Compiler` configured with `analysis_only`, `completion_closed_world`, and `transient_caches`. It restores only the transitive dependency closure reported by `bridge.completion_dependencies(active)` through `Store:read_descriptor`, reading persisted C-header caches through `Store:read_saved_cache` fenced by `saved_generation` while discarding all cache writes. Shared Lua global state remains serialized by `compiler_scheduler`.

An ordinarily selected static archive contributes its complete inventory, even if saved source imported only one member. `merge_completion_catalog` in [`src/server/compiler_bridge/cache_and_completion.titan`](../src/server/compiler_bridge/cache_and_completion.titan) replaces that inventory as a group when `CompletionBinary.complete_archive` is set. By contrast, the compiler may inspect a public nominal from an unselected provider; those contextual captures merge by member so independent roots can retain different owners from one file without admitting its other exports.

At saved publication, `completion_catalog` in [`src/server/project_loader.titan`](../src/server/project_loader.titan) admits a detached contextual descriptor only when a clean project still reaches a clean compiled exposer whose committed observation matches the owner name, provider kind, and physical path. An observation alone cannot authorize a dormant sibling or grant source-private visibility; ordinary selections and source overlap retain their priority. Authorized descriptors survive unrelated refreshes and warm restarts, retiring whenever the exposer fails or detaches or the observation changes. Unlike the C-header revalidation below, private completion uses the captured public interface without disk provider lookup or reopening binaries.

Before and after private analysis, `Service:prepare` validates every captured and observed C header with `Compiler:restat_c_header_dependencies`. Newly introduced unsaved headers are recorded in `volatile_headers`; subsequent requests re-stat them before treating a prepared result as fresh, while serving usable provisional candidates during revalidation.

`bridge.prepare_completion` inserts a marked dummy identifier into a disposable copy of the active file while preserving surrounding operator and foreign-type syntax, captures scope and receiver facts before the expected dummy lookup failure, and leaves ordinary checking untouched. Persisted descriptors carry their own format version, independent of language-server API version `1`.

## TEMP storage and selection

Completion shares the workspace's serialized SQLite connection; see [Connection ownership](sqlite-backend-storage.md#connection-ownership). `workspace_store.open` sets `PRAGMA temp_store = MEMORY`, and `completion_store.open` verifies that `PRAGMA temp_store` reads back `2` before creating any TEMP table. Saved publications, TEMP writes, and logical reads each hold the connection lease for their entire unit of work.

`write_candidates` in [`src/server/completion_store.titan`](../src/server/completion_store.titan) inserts 11 rows of 17 bindings per statement (187 parameters), staying below Titan's 200-argument variadic call limit; optional `call_snippet` and `documentation` fields pass empty blobs restored to SQL `NULL` by `NULLIF(?, X'')`. A superseded TEMP publication returns `false` and rolls back its entire transaction. `main.completion_descriptors` is a rowid table rather than `WITHOUT ROWID` so child foreign-key probes read only the compact primary-key index instead of multi-megabyte descriptor overflow pages.

TEMP tables (`open_documents`, `completion_snapshots`, `completion_inputs`, `covered_modules`, `completion_scopes`, `completion_candidates`, `completion_hovers`, and `retained_hover_*`) enforce cascading foreign keys exclusively within `temp`. Explicit `covered_modules` rows cover empty or errored analyses so obsolete saved declarations cannot leak through under another prefix.

Fresh selection runs strictly qualified `SELECT` statements over scalar TEMP columns under one lease: validating `saved_generation`, `context_key`, `prefix`, and live `open_documents`, deduplicating shadowed bindings with `ROW_NUMBER() OVER (PARTITION BY lookup_domain, lookup_key ORDER BY scope_depth DESC, declaration_order DESC, ordinal)`, and filtering prefixes with a binary, case-sensitive range (`label COLLATE BINARY >= ? AND label COLLATE BINARY < ?` using `prefix_upper`) so `_` matches literally. Selection caps responses at 200 items and sets `isIncomplete` on truncation or non-`complete` quality:

```titan
function Store:select(snapshot_id: string, context_key: string,
                       prefix: string, limit: integer, current: Current): facts.Selection?
  if self.closed then return nil end
  local access = self.store:acquire()
  defer access:release()
  local connection = access.connection
  local snapshots = sql.rows(connection,
    "SELECT saved_generation,quality FROM temp.completion_snapshots WHERE id=? AND context_key=? AND prefix=?",
    blob(snapshot_id), blob(context_key), prefix)
  if #snapshots ~= 1 or not current() or
      not current_generation(connection, snapshots[1]:get(1)) then return nil end
  if sql.scalar_integer(connection,
      "SELECT count(*) FROM temp.completion_inputs AS i WHERE i.snapshot_id=? AND i.session>0 " ..
      "AND NOT EXISTS(SELECT 1 FROM temp.open_documents AS d WHERE d.filename=i.filename " ..
      "AND d.session=i.session AND d.version=i.version AND d.contents=i.contents)", blob(snapshot_id)) ~= 0 then
    return nil
  end
  return select_candidates(connection, snapshot_id, prefix, limit, snapshots[1]:get(2), current)
end
```
*Source: [`src/server/completion_store.titan`](../src/server/completion_store.titan) — `Store:select`*

While replacement preparation runs after an edit, a saved refresh, or header revalidation, `Service:provisional` reuses the last prepared TEMP snapshot for the same document and open session whenever the source bytes preceding the active token match `ready.anchor` verbatim. Provisional selection (`Store:select_provisional`) reads only that retained TEMP snapshot — never mixing old candidates with newer saved rows — filters with the current prefix, computes the whole-token replacement range from current UTF-16 text, and always marks `isIncomplete: true`.

When neither a fresh nor a provisional result is available, `Service:answer` polls for up to 150 ms (15 iterations of `timer.sleep(10)`) without waiting for workspace restoration, returning an empty incomplete list if preparation has not finished. Request cancellation detaches only the caller; `Store:write` executes every TEMP transaction in an independent `Task` so cancellation cannot strand an uncommitted SQLite transaction, and `Service:close` joins all writers before closing the store. Input changes cancel superseded private preparation tasks.

Saving a file never promotes TEMP facts: the watcher reindexes disk independently. Closing a document retires its TEMP rows, and reopening opens a new session that cannot reuse old snapshots. A newer saved generation disqualifies older snapshots from fresh selection while allowing bounded provisional reuse across ordinary saves; the first accepted `View` and any later semantic configuration change advance `minimum_saved_generation` (`Service:saved_changed`), retiring earlier provisional completion and retained hover. Other database connections cannot see TEMP tables.

## Bounds and checks

| Bound | Value | Owner |
| --- | --- | --- |
| Editor text per document, per workspace, tracked documents | 4 MiB, 32 MiB, 256 | `document_buffers` |
| Derived snapshot size, total, count, candidates per snapshot | 16 MiB, 64 MiB, 16, 100,000 | `completion_store` |
| Captured saved baseline source, interfaces | 32 MiB, 64 MiB | `completion_store` |
| Detached descriptor preparation | 64 MiB | `completion_service` |

Oversized editor text retains a version watermark so a later bounded full-sync update recovers cleanly. Exceeding the 256-document cap disables completion until restart (`capacity_exceeded`) because dropping an open contributor could falsely substitute saved bytes. Exceeding a preparation cap leaves completion incomplete. `make_snapshot_room` evicts the oldest snapshots across both completion and retained hover inventories by monotonic `serial`. These limits cap server-owned data rather than total process RSS.

Native tests beside each module (`*_test.titan`) and `make completion-protocol-test` exercise buffers, discovery, TEMP storage, isolation across connections, restart disposal, rollback, stale identities, empty coverage, binary-prefix shadowing, contextual binary owners (`testContextualBinaryCompletion` in [`scripts/test-completion-protocol.mjs`](../scripts/test-completion-protocol.mjs)), and live stdio interactions. Compiler tests own lexical and receiver lookup semantics. For measured request and preparation timings, see [Completion timings](benchmarks.md#completion-timings).

## Design precedents

- [LSP 3.17 completion](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/language/completion.md) keeps `label` as the bare name, places signatures in `labelDetails.detail` and `detail`, gates snippets on `snippetSupport`, and uses explicit whole-token `textEdit` plus `filterText` to avoid client word guessing.
- [LuaLS](https://luals.github.io/wiki/settings/#completionshowparams), [rust-analyzer](https://rust-analyzer.github.io/book/configuration#rust-analyzercompletioncallablesnippets), and [gopls](https://go.dev/gopls/settings#completeFunctionCalls) separate signature display from call insertion so users can take function references without snippet expansion.
- The [Haskell Language Server](https://github.com/haskell/haskell-language-server/blob/5327ae014b5fa7fce028f22c55499ddd9f0d2de7/ghcide/src/Development/IDE/Core/PositionMapping.hs) serves retained semantic results across edits via conservative position mapping, matching retained live hover here.
- [clangd](https://clangd.llvm.org/design/threads) debounces rebuilds across a 50–500 ms window; the fixed 200 ms `HOVER_DEBOUNCE_MS` sits within that range.

---

← Previous: [Chapter 5](semantic-features.md) | [Table of Contents](index.md) | Next: [Appendix A: Build System, Static Providers, Testing, and Packaging](native-build.md) →
