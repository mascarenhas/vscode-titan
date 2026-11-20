# Chapter 5: Saved-File Intelligence — Navigation, Hover, Folding, Diagnostics, and Rename

Saved-file features answer from one committed SQLite generation without re-invoking the compiler or retaining AST graphs in memory. Definition, references, hover, folding, diagnostics, and rename share two invariants: every span is validated against exact saved bytes during publication, and every read verifies that the workspace's `published_generation` matches the immutable `View` held by the request.

## Coordinate conversion

The compiler locates symbols by one-based LF line numbers and one-based byte columns, whereas LSP identifies positions by zero-based lines and zero-based UTF-16 code units. `CoordinateIndex` in [`src/server/source_text.titan`](../src/server/source_text.titan) bridges both conventions in a single linear scan over an immutable source string.

Each `IndexedLine` stores its byte boundaries, its UTF-16 line length, and an array of `ScalarCheckpoint` records holding only the non-ASCII scalars where byte width and UTF-16 width diverge:

- **ASCII lines** have an empty checkpoint list and convert between byte offsets and UTF-16 characters in constant time once `CoordinateIndex:indexed_line_for_offset` locates the line by binary search.
- **Unicode lines** binary-search their compact checkpoint array (`CoordinateIndex:completed_byte_checkpoints` and `CoordinateIndex:completed_utf16_checkpoints`) to compute the cumulative byte-to-UTF-16 delta.
- **Boundary errors** are rejected explicitly: offsets inside a multi-byte UTF-8 scalar or between `\r` and `\n`, and UTF-16 positions splitting a surrogate pair, return a typed `Error`.
- **Compiler LF lines** are tracked alongside UTF-16 lines in `lf_line_starts` and `lf_line_finishes` (`CoordinateIndex:lf_line_start`, `CoordinateIndex:offset_for_lf_byte_position`), even after a malformed UTF-8 byte stops scalar decoding, so diagnostics on invalid-UTF-8 files resolve accurately.

Indexing callers pass a work-accounting callback through `coordinate_index_with_account` so building line tables for large files shares the publication's cooperative yield budget.

## The saved semantic index

[`src/server/semantic_index.titan`](../src/server/semantic_index.titan) transforms checked `ModuleSnapshot` values from the compiler bridge into qualified SQLite rows owned by one published generation.

### Preparation and validation

`prepare` and `prepare_update` run outside any SQLite lease. For each replaced clean module, `append_snapshot_occurrences` drops symbols whose source file belongs to an imported module, then calls `validate_span` to verify that the compiler's exact span stays on one line, falls within `CoordinateIndex`, matches `symbol.name` byte for byte in saved source, and converts cleanly to UTF-16 coordinates. Hover summaries for modules, records, unions, and interfaces are pre-rendered to Markdown (`render_hover_summary`) so request handlers perform only scalar lookups.

When a `PublicationPlan` (`publication_plan`) accompanies an update, it inspects `main.semantic_projects` before schema recreation. Modules whose `(revision, state)` pair matches the committed generation retain their existing `semantic_files`, `semantic_summaries`, and `semantic_occurrences` rows.

### Staging and generation-fenced queries

`Prepared:publish` writes replacement occurrences into `main.semantic_occurrence_inputs` in 19-column batches via `workspace_store.batch`. Before copying staged rows into `main.semantic_occurrences`, `validate_published` enforces three SQL-level invariants:

1. Exact duplicates are collapsed by `MIN(rowid)` across all occurrence columns.
2. Overlapping spans in any file fail publication using a window query (`LAG(byte_finish) OVER (PARTITION BY filename ORDER BY byte_start, ...)`).
3. Declaration identities (`role IN (0, 1)`) must be unique both within the staged batch and across retained modules in `main.semantic_occurrences`.

Every read on `Index` (`occurrence_at`, `definition`, `occurrences`, `hover_summary`, `project_modules`, `file_names`) acquires the connection lease and calls `check_generation`. If a newer save committed a higher `published_generation`, `check_generation` raises `StaleView`, letting the caller retry or report a retryable failure instead of blending two generations.

### Shorthand union patterns and `SharedCaseName`

Titan union variants can carry multiple named payload parts (see Titan's [unions manual](https://github.com/mascarenhas/titan/blob/master/doc/language/unions.md)):

```titan
union Result
  pair(left: integer, right: string)
  item(string)
  empty()
end

local positional = Result.pair(1, "one")
local named = Result.pair{right = "two", left = 2}

function describe(result: Result): string
  case result
    when pair{label = right, left} then return label
    when item(text) then return text
    when empty() then return "empty"
  end
  return ""
end
```

`item(string)` declares a single part named `value`. In a named pattern, the local binding sits on the left of `=` and the declared part name sits on the right. The shorthand `when pair{left}` binds a local `left` from the part `left`, so one source span simultaneously acts as a local definition and a part reference.

The compiler bridge walks union `parts`, case-arm `bindings`, and constructor `values` via `AST_CHILD_FIELDS` in [`src/server/compiler_bridge/compiler_bridge.titan`](../src/server/compiler_bridge/compiler_bridge.titan). Part declarations, named constructor labels, and named pattern selectors share one declaration identity within their variant; a same-named part in another variant is independent, and a pattern alias (`label` above) has its own local binding identity. Saved-file analysis records every part's type reference and case binding; variant hover displays all declared part names and types, and generic constructor hover preserves applied payload types (for `Packet<|integer|>.moved`, a part declared `x: T` displays as `x: integer`) because analysis-only mode inspects the checked source expression prior to runtime generic erasure. The TextMate grammar in [`syntaxes/titan.tmLanguage.json`](../syntaxes/titan.tmLanguage.json) scopes variant names as `entity.name.tag.titan` and part names as `variable.parameter.titan` (see [Using the Titan VS Code Extension](vscode-extension.md) for line-scanner notes on contextual names such as `end`).

To avoid overlapping spans in `main.semantic_occurrences`, a shorthand token is stored once under its local binding's `declaration_id` while persisting the selected part in `case_part_id` (indexed by the partial index `semantic_occurrences_case_part`). Workspaces built against an incompatible schema rebuild on startup; see [Location and opening](sqlite-backend-storage.md#location-and-opening). `SharedCaseName` represents this dual role at the query boundary: `occurrence_at` resolves the local binding at the caret, whereas `Index:occurrences` also matches `case_part_id` and projects the row as `SharedCaseName.part`:

```titan
union SharedCaseName
  binding(part_id: string)
  part(binding_id: string)
end
-- ...
function Index:occurrences(symbol_id: SymbolId, include_declaration: boolean): {Occurrence}
  local access = self.store:acquire()
  defer access:release()
  check_generation(access.connection, self.published_generation)
  local predicate = " WHERE (declaration_id=?"
  if not include_declaration then predicate = predicate .. " AND role NOT IN (0,1)" end
  predicate = predicate .. ") OR case_part_id=?"
  local statement = access.connection:prepare("SELECT " .. OCCURRENCE_COLUMNS ..
    " FROM main.semantic_occurrences" .. predicate .. SOURCE_ORDER)
  defer statement:close()
  local cursor = statement:query(blob(symbol_id.declaration_id), blob(symbol_id.declaration_id))
  defer cursor:close()
  return collect(cursor, symbol_id.declaration_id)
end
```
*Source: [`src/server/semantic_index.titan`](../src/server/semantic_index.titan) — `SharedCaseName`, `Index:occurrences`*

## Saved feature queries (`src/server/semantic_features/`)

`server.semantic_features` is a three-file folder module layered directly over `server.semantic_index`:

- [`semantic_features.titan`](../src/server/semantic_features/semantic_features.titan) owns module imports, `FOLDABLE_TAGS`, schema DDL for `main.semantic_hovers` and `main.semantic_folds`, `Features` query dispatch (`definition`, `references`, `matches_source`), and `PreparedView:publish`.
- [`hover_and_folding.titan`](../src/server/semantic_features/hover_and_folding.titan) extracts hover type layers, formats hover Markdown, exports scalar hover rows for unsaved completion, and scans long-bracket comments for folding.
- [`rename.titan`](../src/server/semantic_features/rename.titan) builds in-memory edited modules, expands shorthand union patterns, and verifies compiler preflight results.

`Features:definition` and `Features:references` resolve `occurrence_at` and map project-owned occurrences to `Location` records; symbols declared in external or foreign sources yield no navigation target. During publication, `PreparedView:publish` prunes `semantic_hovers` and `semantic_folds` by joining `main.semantic_files` *before* calling `self.index:publish`, ensuring removed folder contributors or files reassigned to another module leave no stale rows behind.

### Hover extraction and long-comment folding

During `prepare_internal`, `hover_nodes` indexes AST nodes by `(filename, byte_offset, name)` and `materialize_hover` walks up enclosing `semantic_container` nodes (`expression`, `variable`, `type_syntax`) to capture `inferred_type`, `declared_type`, and coercion pairs (`original_type` -> `coerced_type`). Persisting those four scalar type slots in `main.semantic_hovers` lets `Features:hover` serve complete Markdown via `Hover:markdown` — summary or callable signature or type, optional `Cast to` line, visibility (`block`, `module`, `exported`), and LDoc documentation — without holding ASTs in memory. `PreparedView:completion_hovers` reuses `Hover:markdown` for unsaved completion hover under the `MAX_HOVER_ROWS` and `MAX_HOVER_BYTES` caps.

Folding combines two sources in deterministic order. First, `prepare_internal` converts non-synthetic AST nodes whose tag appears in `FOLDABLE_TAGS` (functions, methods, records, unions, interfaces, blocks, loops, `if`, `try`, `case`) into ranges ending at `converted.finish.line - 1` so closing `end` lines remain visible. Second, because the compiler AST discards comments, `SavedFile:append_long_comment_folds` scans raw saved bytes for `--[=[ ... ]=]` blocks while skipping short quoted strings and non-comment long-bracket string literals:

```titan
local record LongBracket
  const level: integer
  const contents_start: integer
end
-- ...
local function SavedFile:append_long_comment_folds(filename: string,
                                                   folds: {MaterializedFold},
                                                   state: ExtractionState)
  local source = self.contents
  local index = 1
  while index <= #source do
    state:account()
    local byte: integer = strings.byte(source, index)
    if byte == 34 or byte == 39 then
      index = skip_short_string(source, index, state)
    elseif byte == 91 then
      local literal? = long_bracket(source, index, state)
      if literal == nil then
        index = index + 1
      else
        local finish? = literal:finish(source, state)
        if finish == nil then return end
        index = finish
      end
    elseif byte == 45 and index < #source and
        strings.byte(source, index + 1) == 45 then
      local comment? = long_bracket(source, index + 2, state)
      if comment == nil then
        index = index + 2
        while index <= #source and strings.byte(source, index) ~= 10 do
          state:account()
          index = index + 1
        end
      else
        local finish? = comment:finish(source, state)
        if finish == nil then return end
        self:append_comment_fold(filename, index - 1, finish - 1, folds, state)
        index = finish
      end
    else
      index = index + 1
    end
  end
end
```
*Source: [`src/server/semantic_features/hover_and_folding.titan`](../src/server/semantic_features/hover_and_folding.titan) — `LongBracket`, `SavedFile:append_long_comment_folds`*

`SavedFile:append_comment_fold` pulls `end_line` back by one line if non-whitespace code follows the closing `]=]` on the same line. Because structural ranges are appended first and `PreparedView:publish` writes `semantic_folds` with `INSERT OR IGNORE`, a structural fold takes precedence whenever both share the same start and end line.

### Shorthand-preserving rename and compiler preflight

Rename is split into two nominal types in [`src/server/semantic_features/semantic_features.titan`](../src/server/semantic_features/semantic_features.titan) so unverified edits cannot reach JSON-RPC encoding. `Features:rename` validates `lsp.valid_identifier(new_name)`, confirms the symbol is declared in project source, rewrites each affected file in memory with `edited_file`, and returns a `RenameCandidate` whose edit arrays are `local const`.

When an occurrence carries `SharedCaseName`, `edited_file` expands the shorthand into `alias = part` so renaming one identity leaves the other intact: renaming local `left` in `when pair{left}` to `first` produces `when pair{first = left}`; renaming declared part `left` to `first` produces `when pair{left = first}` without touching the local binding or its uses:

```titan
local function edited_file(source: string,
                           occurrences: const? {indexer.Occurrence},
                           new_name: string):
    (string, {PendingRenameAnchor}, {lsp.TextEdit})
  local output = strings.writer()
  local anchors: {PendingRenameAnchor} = {}
  local edits: {lsp.TextEdit} = {}
  local cursor = 0
  local delta = 0
  for index = 1, #occurrences do
    local occurrence = occurrences[index]
    if occurrence.byte_span.start < cursor then
      raise Error("rename occurrences overlap")
    end
    output:write(strings.sub(
      source, cursor + 1, occurrence.byte_span.start))
    local prefix, suffix = "", ""
    if occurrence.shared_case_name ~= nil then
      case occurrence.shared_case_name
      when binding() then suffix = " = " .. occurrence.name
      when part() then prefix = occurrence.name .. " = "
      end
    end
    local replacement = prefix .. new_name .. suffix
    output:write(replacement)
    local after_start = occurrence.byte_span.start + delta + #prefix
    local after_finish = after_start + #new_name
    anchors[index] = PendingRenameAnchor(
      occurrence.filename, occurrence.byte_span, after_start, after_finish)
    edits[index] = lsp.TextEdit(occurrence.span, replacement)
    cursor = occurrence.byte_span.finish
    delta = delta + #replacement -
      (occurrence.byte_span.finish - occurrence.byte_span.start)
  end
  output:write(strings.sub(source, cursor + 1))
  return output:drain(), anchors, edits
end
```
*Source: [`src/server/semantic_features/rename.titan`](../src/server/semantic_features/rename.titan) — `edited_file`*

Notice that `after_start` shifts past `#prefix` so `PendingRenameAnchor` tracks only the renamed identifier inside an expanded `alias = part` edit. `Application:handle_rename` then runs `default_rename_analyzer` across the complete project (`candidate:edited_project_modules()`) and passes the `Analysis` to `RenameCandidate:preflight`. `preflight` rejects any compiler diagnostic, builds a disposable in-memory `semantic_index` (`indexer.build`), and checks that every anchor resolves to `new_name` under one shared `SymbolId` whose declaration and total occurrence set match `self.anchors` exactly. Any accidental shadowing, name collision, or unindexed reference inside a broken module fails preflight; only a clean proof returns `VerifiedRename`.

## Server data models

The server's own tagged unions follow one rule: use named payload parts for data that only a variant owns, and keep a standalone record when the data has an independent typed API, is a reusable domain value, defines methods, or owns mutable state. Examples of standalone records kept outside inline union parts:

- `View` in [`src/server/application/application.titan`](../src/server/application/application.titan), the published saved-feature snapshot;
- `DispatchResult`, `SemanticRequest`, and `CompletionRequest` in [`src/server/dispatcher.titan`](../src/server/dispatcher.titan), consumed outside request routing;
- `OpenDocument`, `ChangeDocument`, and `TextDocument` in [`src/server/lsp_types.titan`](../src/server/lsp_types.titan), typed parser results shared across transport and buffers;
- `InputDelivery` in [`src/server/protocol.titan`](../src/server/protocol.titan), a mutable owner whose methods manage reader acknowledgement;
- `AdjustmentInfo` in [`src/server/compiler_bridge/compiler_bridge.titan`](../src/server/compiler_bridge/compiler_bridge.titan), the common shape shared by all six `Adjustment` variants.

Because a named variant is not a standalone type, flattening a record into variant parts pays off only when consumers handle the union and its destructured fields rather than passing the value independently.

Runtime reflection stays confined to [`src/server/wire.titan`](../src/server/wire.titan). `wire.as_array` matches `reflect.inspect(subject)` against `is_array{array = value}` and returns the original array; JSON-RPC encodes explicit `wire.Object` and `wire.Array` containers and never serializes server model unions directly.

## Workspace application lifecycle (`src/server/application/`)

A four-file folder module coordinates project loading, filesystem watching, background indexing, editor buffers, diagnostics, and LSP request handling for one workspace root:

- [`application.titan`](../src/server/application/application.titan) defines the 26-field `Application` owner, `View`, `RefreshOutcome`, `WatchFilter`, `DirectoryProbes`, `RefreshChain`, synchronous editor-buffer hooks (`on_document`, `capture_completion`, `capture_hover`), request routing (`handle`), and ordered teardown (`close`).
- [`watch_filter.titan`](../src/server/application/watch_filter.titan) constructs immutable `WatchFilter` snapshots pairing lexical and canonical paths (rebasing across configured symlinks and excluding `.titan-ls`), classifies watch hints non-yieldingly via `WatchFilter:disposition`, and confirms newly created candidate directories asynchronously in bounded waves (`Application:run_directory_probes`).
- [`indexing_lifecycle.titan`](../src/server/application/indexing_lifecycle.titan) owns epoch-fenced refresh chains, transactional `View` publication, indexing telemetry, and the three view-acquisition policies (`current_view`, `fresh_view`, `fresh_view_for`).
- [`handlers.titan`](../src/server/application/handlers.titan) implements the six saved LSP handlers and hover arbitration.

Named record construction keeps the 26-field `Application` initializer self-documenting, leaving optional fields `nil` by default while anchoring every invariant in one constructor:

```titan
function create(project_root: string, loader: ProjectLoader?,
    rename_analyzer: RenameAnalyzer?): Application
  if ffi.VSCODE_TITAN_WINDOWS ~= 0 and
     source_text.is_absolute_path(project_root) then
    local normalized?, normalize_error? = source_text.normalize_absolute_path(project_root)
    if normalized == nil then raise normalize_error end
    project_root = normalized
  end
  return Application {
    project_root = project_root,
    project_loader = loader or project_loader.load,
    change_epoch = 1,
    completed_epoch = 0,
    refresh_chain_initial = false,
    refresh_chains = 0,
    refresh_passes = 0,
    view_builds = 0,
    closed = false,
    directory_probes = DirectoryProbes(),
    rename_analyzer = rename_analyzer or default_rename_analyzer,
    diagnostic_publisher = diagnostics.create(),
    buffers = document_buffers.create(),
    progress = indexing_progress.create(),
  }
end
```
*Source: [`src/server/application/application.titan`](../src/server/application/application.titan) — `create`*

### Epoch-fenced refresh and `View` publication

Every filesystem hint (`Application:note_saved_change`) increments `change_epoch` and ensures a single foreground refresh `Task` is running (`Application:start_refresh`). When a pass completes at `target_epoch`:

1. `Application:publish_view` captures `publication_revision` and a `PublicationPlan` under a short SQLite lease, reconciles the native directory watcher (`reconcile_watcher`), and prepares semantic features and diagnostic rows outside the lease so concurrent read requests keep reading the preceding committed generation.
2. Under a single write transaction, `publish_view` re-checks `publication_revision`, initializes schemas if missing, publishes `PreparedView`, `published_diagnostics`, and `service:publish_prepared`, advances `main.store_state.published_generation`, and commits.
3. On `RefreshOutcome.ready(view)`, `completed_view` and `completed_epoch` advance and `completion:saved_changed` receives the new generation plus a `configuration_boundary` flag. On `RefreshOutcome.failure`, `failed_epoch` records the failed epoch and `diagnostic_publisher:clear` empties stale Problems entries.
4. If `change_epoch > target_epoch` after the pass finishes, `start_refresh` immediately schedules one coalesced follow-up pass (`coalesced_follow_up`). Otherwise the refresh chain completes, emits `titan/indexingStatus` (`ready` or `failed`) and `$/progress` `end`, and starts background manifest restoration (`restoration:start`) if warm startup deferred it.

### Three freshness policies and pull-diagnostic barriers

Saved request handlers select among three view barriers according to their correctness contract:

- **Responsive immutable read (`Application:current_view`):** Definition, references, hover, and folding read `completed_view` immediately without blocking on a running refresh or rescanning disk. For hover on an open buffer, `Application:handle_hover` first checks synchronous buffer-epoch capture, queries ephemeral completion hover (`completion:hover`), and falls back to saved hover only when `Features:matches_source` confirms the open buffer matches committed bytes verbatim.
- **Strict stable generation (`Application:fresh_view`):** Rename awaits a forced fresh pass before building a `RenameCandidate`, runs compiler preflight, and invokes `fresh_view` a second time afterward to prove neither `work_generation` nor `published_generation` moved while preflight ran.
- **Pull-diagnostic freshness barrier (`Application:fresh_view_for`):** Every `textDocument/diagnostic` pull injects a saved-change barrier through `note_saved_change` and joins any running refresh pass until `change_epoch <= completed_epoch`:

```titan
local function Application:fresh_view_for(): (View?, Error?)
  if self.closed then
    return nil, Error("language server application is closed")
  end
  self:note_saved_change()
  while true do
    if self.closed then
      return nil, Error("language server application is closed")
    end
    local running? = self.refresh_task
    if running ~= nil then
      async.join(running)
    else
      local view?, view_error? = self:current_view()
      if view_error ~= nil then return nil, view_error end
      if view ~= nil and self.change_epoch <= self.completed_epoch then
        return view, nil
      end
      return nil, Error("saved project refresh did not start")
    end
  end
  return nil, Error("saved project refresh did not settle")
end
```
*Source: [`src/server/application/indexing_lifecycle.titan`](../src/server/application/indexing_lifecycle.titan) — `Application:fresh_view_for`*

A pass that finds no dirty files is a fast metadata scan that reuses the immutable `Features` handle and keeps `published_generation` unchanged.

## Diagnostics and indexing progress

[`src/server/diagnostics.titan`](../src/server/diagnostics.titan) and [`src/server/published_diagnostics.titan`](../src/server/published_diagnostics.titan) unify push (`textDocument/publishDiagnostics`) and pull (`textDocument/diagnostic`) over one committed dataset:

- `diagnostics.from_snapshot_with_yield` normalizes compiler errors (`syntax`, `type`, `compiler` at severity 1), `unmapped-source` warnings (severity 2), and `inactive-variant` informational diagnostics (severity 3), deduplicating per file by length-prefixed `Item:key` and anchoring location-free module errors to the module's first saved file. External-file diagnostics are dropped at exact catalog membership.
- `published_diagnostics.publish` persists the ordered rows into `main.semantic_diagnostic_publications` and `main.semantic_diagnostic_items` inside the same transaction as semantic facts.
- `diagnostics.Publisher:publish` notifies the protocol sink for every changed URI and publishes empty arrays to clear URIs absent from the new generation; `Application:stop_diagnostics` clears active entries before the protocol writer drains on shutdown.
- `Application:handle_diagnostic` queries `published_diagnostics.read_uri` under `fresh_view_for` (retrying on `StaleView`), calls `async.checkpoint()` to honor cancellation while waiting, and returns `diagnostics.report`, which hashes ordered item keys with `content_identity.hex_digest` (`diagnostics.result_id`) to answer `unchanged` when `previousResultId` matches.

Contiguous refresh chains expose progress through two parallel channels:

- **`$/progress`** ([`src/server/indexing_progress.titan`](../src/server/indexing_progress.titan)): `Reporter:start` allocates a process-unique token (`titan-progress/<pid>/<sequence>`) so the multi-root router forwards worker progress without rewriting tokens, sends one `window/workDoneProgress/create` request bounded by `CREATE_TIMEOUT_MS` (5,000 ms), and emits `begin`, per-file `report` (`completed/total files` and percentage), and `end`. A slow or failed `create` disables `$/progress` for that chain without failing indexing.
- **`titan/indexingStatus`** ([`src/server/indexing_status.titan`](../src/server/indexing_status.titan)): emits typed `Status` payloads (`indexing`, `ready`, `failed`) carrying `initial`, `epoch`, `generation`, optional failure message, and validated `completed_files`/`total_files` counters.

Both channels emit their terminal event only after the new `View` and its diagnostics have committed, so any client request issued after progress ends observes that generation.

---

← Previous: [Chapter 4](sqlite-backend-storage.md) | [Table of Contents](index.md) | Next: [Chapter 6: Unsaved Buffers — Private Completion and Live Hover](completion.md) →
