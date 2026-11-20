# Chapter 4: Incremental Indexing, Provenance, and SQLite Storage

Each workspace root persists its saved index, dependency graph, provenance records, and compiler artifacts in one SQLite database. The database is a disposable cache: a compatible restart reuses it, and any incompatible compiler, target, schema, or damaged file rebuilds it through ordinary indexing. [Chapter 6](completion.md#temp-storage-and-selection) adds connection-local `temp.*` tables on the same connection for unsaved buffers.

Four components sit between the filesystem and SQLite: target-aware module discovery, symlink-fenced watch filtering, a fixed-point refresh service, and a persistent module graph keyed by SHA-256 manifest digests.

## Target-aware discovery and symlink-fenced watching

[`src/server/project_discovery.titan`](../src/server/project_discovery.titan) maps configured `include`, `exclude`, and `source_module_roots` directories into logical flat and folder modules. `collect` walks each `include` root using `fs.lstat` without following symlinks, keeping project identity lexical and preventing watches from escaping the source tree through links. Discovery skips `.titan-ls`, treats nested `include` roots as scan boundaries so each physical subtree is traversed once, and prunes directories that fail `valid_module_component` unless they lead to a configured nested source root.

Each discovered `.titan` file maps to its physically most-specific `source_module_roots` entry (`FileEntry:select_source_root`). `discover_entries` classifies target variants through `bridge.classify_source_filename`, selects folder mains before flat files, and records `Issue` diagnostics for `inactive_variant`, `unmapped_source`, and `invalid_module` paths. Every candidate is verified against root-major compiler resolution (`resolve_source`), and contributors, modules, and issues are ordered with `bytewise_less` and generic `sort_by<|T|>` so discovery matches `driver.lua`'s locale-independent numeric-byte ordering.

[`src/server/application/watch_filter.titan`](../src/server/application/watch_filter.titan) keeps filesystem notifications aligned with those same boundaries. `build_watch_filter` constructs an immutable `WatchFilter` (`const {string}` arrays frozen with `as const {string}`) containing both lexical and canonical (`fs.realpath` / `roots.canonical`) spellings of `include_roots`, `source_roots`, `excluded_paths`, `cache_paths` (`.titan-ls`), `configuration_paths` (`titan-config.lua`), and `known_directories`. `WatchFilter:disposition` shares `project_discovery.valid_module_component` and classifies each `PathChange` synchronously without yielding into `irrelevant()`, `relevant()`, or `possible_directory(path)`. Created extensionless candidates are queued in bounded waves for `Application:run_directory_probes`, which checks `fs.lstat(path)` so ephemeral temporary files and symlinks never trigger rediscovery. When initial configuration load or discovery fails, `provisional_watch_filter` watches the project root and `titan-config.lua` so a subsequent save repairs the workspace automatically.

## Fixed-point refresh and manifest invalidation

The saved indexing loop lives in the three-file folder module `src/server/project_service/`:

| File | Responsibility and key symbols |
| --- | --- |
| [`project_service.titan`](../src/server/project_service/project_service.titan) | Folder main: `Snapshot`, `AnalysisRequest`, `PublicationHooks`, `RefreshReport`, `Service`, `Service:update_metadata` (pairing SQLite rollback with `Graph:checkpoint_asts` / `Graph:restore_asts`), and `Service:close`. |
| [`scan_and_provenance.titan`](../src/server/project_service/scan_and_provenance.titan) | Three-attempt stable file reads (`read_saved_file`), `Service:accept_discovery` (`graph_configuration` change checks excluding watcher-only `exclude`), `Service:revalidate_external_topology`, `Service:revalidate_external_files`, and `Service:revalidate_known_headers`. |
| [`analysis_commit.titan`](../src/server/project_service/analysis_commit.titan) | Generation-fenced work selection (`Service:prepare_work`), pre-commit rescan and provenance validation (`Service:commit_or_raise`), topological `project_commit_order`, `Service:prune_unreachable_externals`, and `Service:analyze_to_fixed_point`. |

Each refresh scans saved files, runs compiler work on dirty modules outside the SQLite lease, and revalidates filesystem stamps, external topology, C-header closures, binary provider identities, and browser C-probe consistency before committing a batch. Because committing one module can invalidate its importers, `Service:analyze_to_fixed_point` repeats until no dirty modules remain, then prunes unreachable external metadata:

```titan
local function Service:analyze_to_fixed_point(): (RefreshReport?, Error?)
  local committed: {string} = {}
  local failed: {string} = {}
  local analyzed = false
  local saw_stale = false
  local iteration_count = 0

  while true do
    local request? = self:prepare_work()
    if request == nil then break end
    iteration_count = iteration_count + 1
    local report?, analysis_error? = self:analyze(request)
    if report == nil then return nil, analysis_error end
    analyzed = true
    if report.stale then saw_stale = true end

    for index = 1, #report.committed_modules do
      local name = report.committed_modules[index]
      insert_name(committed, name)
      remove_name(failed, name)
    end
    for index = 1, #report.failed_modules do
      local name = report.failed_modules[index]
      insert_name(failed, name)
    end
  end

  local access = self.store:acquire()
  defer access:release()
  self:update_metadata(self:prune_unreachable_externals)
  local report = RefreshReport {
    analyzed = analyzed,
    stale = saw_stale,
    generation = self.graph:generation(),
    committed_modules = committed,
    failed_modules = failed,
    dirty_modules = self.graph:dirty_modules(),
  }
  -- ...
  return report, nil
end
```
*Source: [`src/server/project_service/analysis_commit.titan`](../src/server/project_service/analysis_commit.titan) — `Service:analyze_to_fixed_point`*

Dependency propagation is governed by [`src/server/project_graph.titan`](../src/server/project_graph.titan). Each row in `main.graph_modules` records a module's `provenance` (`0` project, `1` external source, `2` external binary), `state` (`0` dirty, `1` checking, `2` clean, `3` failed), `recovering` flag, monotonic `revision` (allocated from `graph_state.work_revision` so delete-and-recreate never reuses an older revision), and two 32-byte SHA-256 digests (`content_identity.digest`): `public_digest` and `source_digest`. Ordinary imports (`visibility = 0`) depend only on `public_digest`, while explicit `.titan` source imports (`visibility = 1`) depend on `source_digest`:

```titan
record Manifest
  const public_digest: string
  const source_digest: string
end

function Graph:commit_project(token: CheckToken, manifest: Manifest,
    imports: {ImportEdge}, ast: A): CommitResult
  local entry? = self:accepts(token)
  if entry == nil then return CommitResult.stale() end
  self:set_imports(token.module_name, imports)
  sql.execute(self.connection,
    "UPDATE main.graph_modules SET state=2,recovering=0,public_digest=?,source_digest=? " ..
    "WHERE name=?", sqlite3.Blob(manifest.public_digest),
    sqlite3.Blob(manifest.source_digest), token.module_name)
  self.asts[token.module_name] = ast
  local invalidated = self:invalidate_importers(
    token.module_name, entry.manifest, manifest, false, {})
  if entry.recovering then
    local recovery = self:invalidate_failed_importers(token.module_name, name_set(invalidated))
    for index = 1, #recovery do add_sorted_name(invalidated, recovery[index]) end
  end
  return CommitResult.accepted(invalidated)
end
```
*Source: [`src/server/project_graph.titan`](../src/server/project_graph.titan) — `Manifest`, `Graph:commit_project`*

`Graph:invalidate_importers` evaluates the recursive CTE `reverse_walk`, crossing metadata-only external nodes and stopping at project roots. An unchanged public digest stops propagation to ordinary importers; a changed digest dirties immediate importers for the next fixed-point pass. When `entry.recovering` is set, `Graph:invalidate_failed_importers` also re-dirties failed importers so a repaired dependency wakes downstream failures. `main.graph_imports.imported` intentionally carries no foreign key: edges pointing at an absent module survive removal and wake importers when the provider appears. Reloadable manifests remain in `project_snapshots` and `external_records`, and `Service:publication_committed` calls `Graph:release_project_snapshots` to clear transient `Graph.asts` handles once SQL publication commits.

## Location and opening

`directory` in [`src/server/workspace_cache.titan`](../src/server/workspace_cache.titan) places `.titan-ls/` in the physical (`fs.realpath`) workspace root, writes a `.gitignore` containing `*`, and opens `index.sqlite3` there. Project discovery and the watchers skip `.titan-ls`. The same directory serves as that root's default compiler probe-cache prefix, giving each root in a multi-root router session one database and one probe namespace; see [Chapter 1](server-data-flow.md#where-compiler-inputs-come-from).

Startup opens the database with `open_for_inventory`, and `open_compatible` enforces three checks before retaining it:

- `PRAGMA main.user_version` must be `0` (an empty file initialized in place) or `SCHEMA_VERSION` (`1`).
- A versioned database must contain a `compatibility` entry in `main.cache_meta`, and every key and value in `cache_meta` must have SQLite storage type `BLOB`.
- A database with a `compatibility` entry must pass `PRAGMA main.quick_check`.

`load_or_raise` in [`src/server/project_loader.titan`](../src/server/project_loader.titan) then calls `Cache:validate_inventory` with a compatibility key digesting the physical root, `Compiler:cache_identity`, and `ProjectConfig:semantic_identity`:

- `Compiler:cache_identity` ([`src/server/compiler_bridge/cache_and_completion.titan`](../src/server/compiler_bridge/cache_and_completion.titan)) fingerprints the compiler Lua trees as loaded, their native Lua dependencies, and the interface provider—the server image for the build SDK, the selected installation's standard archive (Unix) or provider DLL (Windows) by stat identity, or the validated browser target descriptor, absent-module list, and Wasm provider identity. Reinstalling a provider invalidates only roots using it.
- `ProjectConfig:semantic_identity` ([`src/server/project_config.titan`](../src/server/project_config.titan)) digests semantic project configuration including `target` while omitting watcher-only `exclude`.
- `PRAGMA user_version` alone decides schema compatibility; the compatibility key carries no schema number. A missing key is recorded, and a mismatched key invokes `Cache:rebuild`.

`Cache:accept_native_context` likewise compares `native_context` with `Compiler:native_cache_identity` and rebuilds on mismatch while preserving header records staged while probing the new context.

Saved browser source revisions that reach the lazy C probe—including failed checks producing no header inputs—record revision-qualified ownership (`provenance:revision\0identity`) in `main.cache_meta` through `write_browser_foreign_owner` and `browser_foreign_owners`. Ownership tracks accepted source revisions; a pure replacement or removal retires the prior owner even when a failed external check retains an import edge for recovery. A completed view writes one `browser_foreign` identity only when all active owners agree. An incompatible observation invalidates affected revisions and their dependants before the next view commits. On reopen, the loader validates the probe environment only if retained revisions own it, so a pure warm start never invokes Emscripten.

A rejected file—including any database carrying an incompatible `user_version` (neither `0` nor `SCHEMA_VERSION`)—or one failing with `SQLITE_CORRUPT` (`11`) or `SQLITE_NOTADB` (`26`) is deleted and recreated with no schema migration or previous-version reader. Any other open failure logs `cache.memory_fallback` and opens `:memory:` with the same schema. Every table uses `CREATE TABLE IF NOT EXISTS`, so a dropped table recreates empty. Changing the compiler, server image, or configuration therefore costs one cold index without changing `SCHEMA_VERSION`.

## Connection ownership

`Store` in [`src/server/workspace_store.titan`](../src/server/workspace_store.titan) owns the single serialized SQLite connection for a workspace. `open` enables and verifies `PRAGMA foreign_keys = ON` and `PRAGMA temp_store = MEMORY` (`2`) before initializing `main.store_state` and `main.cache_meta`:

```titan
function open(path: string): Store
  local connection = sqlite3.connect(path)
  local initialized = false
  defer do
    if not initialized then connection:close() end
  end
  execute(connection, "PRAGMA foreign_keys=ON")
  if scalar_integer(connection, "PRAGMA foreign_keys") ~= 1 then
    raise "workspace store requires SQLite foreign keys"
  end
  execute(connection, "PRAGMA temp_store=MEMORY")
  if scalar_integer(connection, "PRAGMA temp_store") ~= 2 then
    raise "workspace store requires SQLite memory TEMP storage"
  end
  execute(connection,
    "CREATE TABLE IF NOT EXISTS main.store_state (" ..
    "singleton INTEGER PRIMARY KEY CHECK(singleton=1), " ..
    "published_generation INTEGER NOT NULL DEFAULT 0)")
  execute(connection,
    "INSERT OR IGNORE INTO main.store_state(singleton) VALUES(1)")
  execute(connection,
    "CREATE TABLE IF NOT EXISTS main.cache_meta (" ..
    "key BLOB PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID")
  initialized = true
  return Store(connection, false, {}, false, false)
end
```
*Source: [`src/server/workspace_store.titan`](../src/server/workspace_store.titan) — `open`*

Callers take a FIFO cooperative `Access` lease (`Store:acquire`) for one complete logical operation: a saved publication, a TEMP publication, or a logical read. Compilation and semantic extraction run outside those short transactions. Publication commits replacement facts and advances `store_state.published_generation` atomically; readers fence their queries against that counter. Like `compiler_scheduler.Permit`, `Access` stores `local const owner: Store` and an idempotent `local released: boolean` flag so uncontended acquisition allocates no closure, while `Store:close` queues behind active leases and asserts `connection:get_autocommit()` before closing:

```titan
record Access
  const connection: sqlite3.Connection
  local const owner: Store
  local released: boolean
end

function Store:acquire(): Access
  if self.closing or self.closed then raise "workspace store is closed" end
  return self:acquire_owner()
end

function Access:release()
  if self.released then return end
  self.released = true
  self.owner:release_owner()
end
```
*Source: [`src/server/workspace_store.titan`](../src/server/workspace_store.titan) — `Access`, `Store:acquire`, `Access:release`*

### Linear-time variadic `INSERT` batching

Prepared helpers (`execute`, `scalar_integer`, `rows`) close statements and cursors via `defer`. Multi-row writers—stamps, imports, diagnostics, occurrences, hovers, folds, and completion rows—use `Batch` so bulk inserts execute in linear string-construction time while staying safely beneath Titan's 200-argument variadic call limit (`max_rows = 196 // columns`):

```titan
function batch(connection: sqlite3.Connection, prefix: string,
               columns: integer, row_limit: integer?): Batch
  if columns < 1 or columns > 196 then
    raise "workspace store batch column count must be between 1 and 196"
  end
  local max_rows = 196 // columns
  local limit = row_limit or max_rows
  if limit < 1 then limit = 1 end
  if limit > max_rows then limit = max_rows end
  local writer = strings.writer()
  writer:write(prefix)
  return Batch(connection, prefix, columns, limit, writer, {}, 0)
end

function Batch:flush()
  if self.rows == 0 then return end
  execute(self.connection, self.writer:drain(), ...self.bindings)
  self.writer:write(self.prefix)
  self.bindings = {}
  self.rows = 0
end
```
*Source: [`src/server/workspace_store.titan`](../src/server/workspace_store.titan) — `Batch`, `batch`, `Batch:flush`*

```titan
function Batch:append(...: value)
  local supplied = #...
  if supplied > self.columns then
    raise "workspace store batch row exceeds declared column count"
  end
  if self.rows > 0 then self.writer:write(",") end
  self.writer:write("(")
  for column = 1, self.columns do
    if column > 1 then self.writer:write(",") end
    local item: value = nil
    if column <= supplied then item = ...[column] end
    if item == nil then
      self.writer:write("NULL")
    else
      self.writer:write("?")
      self.bindings[#self.bindings + 1] = item
    end
  end
  self.writer:write(")")
  self.rows = self.rows + 1
  if self.rows >= self.row_limit then self:flush() end
end
```
*Source: [`src/server/workspace_store.titan`](../src/server/workspace_store.titan) — `Batch:append`*

`Batch:append` emits literal `NULL` for absent values, appends non-nil bindings into `self.bindings`, and flushes automatically through `...self.bindings` spread once `row_limit` rows accumulate.

## Tables by owner

| Owner module | Tables | Contents |
| --- | --- | --- |
| [`workspace_store`](../src/server/workspace_store.titan) | `store_state`, `cache_meta` | Published generation; compatibility, native context, graph configuration, browser foreign ownership, and published-revision keys |
| [`workspace_cache`](../src/server/workspace_cache.titan) | `project_snapshots`, `header_graphs`, `ffi_conversion_snapshots`, `compiler_inputs` | Opaque compiler payloads by module or artifact key; observed compiler-inventory files |
| [`header_store`](../src/server/header_store.titan) | `header_dependencies`, `header_owners`, `header_inputs` | Ordered C-header dependency closures across four scopes |
| [`project_graph`](../src/server/project_graph.titan) | `graph_state`, `graph_modules`, `graph_files`, `graph_imports` | Module graph, file stamps, import edges, and SHA-256 manifest comparison digests |
| [`project_metadata`](../src/server/project_metadata.titan) | `project_records`, `project_sources`, `project_diagnostics`, `external_*` | Saved source bytes and stamps, compiler diagnostics, and external-module manifests and observations |
| [`semantic_index`](../src/server/semantic_index.titan) | `semantic_projects`, `semantic_files`, `semantic_summaries`, `semantic_occurrences`, `semantic_occurrence_inputs` | Saved navigation, reference, and summary query facts |
| [`semantic_features`](../src/server/semantic_features/semantic_features.titan) | `semantic_hovers`, `semantic_folds` | Materialized hover Markdown and folding ranges |
| [`published_diagnostics`](../src/server/published_diagnostics.titan) | `semantic_diagnostic_publications`, `semantic_diagnostic_items` | Published diagnostic entries |
| [`completion_store`](../src/server/completion_store.titan) | `main.completion_*` | The [saved completion baseline](completion.md#input-and-publication-ownership) |

Feature queries read only these SQL facts and never traverse compiler ASTs. Indexed lookups include `semantic_occurrences_file` (occurrence at a position), `semantic_declarations` (definition), `semantic_occurrences_symbol` (references), `graph_reverse` (importers), and `graph_project_work` (pending project work).

### Compiler payloads

Project payloads in `main.project_snapshots` hold detached declared member and type manifests: public and source-import visibility, generic binders, nominal owners, and the ordered foreign-header plan. Function and method bodies exist only during fresh checking and semantic extraction and are discarded after accepted publication. Unchanged modules retain their SQL facts, while changed, failed, and removed modules replace only their own rows. External source and binary modules keep manifests and provenance only (`main.external_records`).

`artifact_namespace` in [`src/server/workspace_cache.titan`](../src/server/workspace_cache.titan) is the single mapping from compiler artifact kinds to SQLite tables and provenance scopes: `"c-header-v8"` maps to `main.header_graphs` (scope `2`) and `"ffi-conversion-v8"` maps to `main.ffi_conversion_snapshots` (scope `3`). Schema creation, staging, publication, `Cache:lookup`, and `Store:read_saved_cache` in [`src/server/completion_store.titan`](../src/server/completion_store.titan) all consult that table, keeping private completion reads identical to watcher publications. Unknown namespaces are cache misses. `test_workspace_cache_accepts_installed_compiler_artifact_namespaces` in [`src/server/workspace_cache_test.titan`](../src/server/workspace_cache_test.titan) reads both kinds from the installed compiler and exercises saved lookup and private generation-fenced reads, catching any compiler namespace rename immediately.

The relational store treats payload blobs as opaque bytes governed by compiler envelope and version checks. Mutable preprocessor contexts for forced `-include` and `-imacros` inputs are not persisted; a fresh process preprocesses them before validating extracted definitions.

## Header provenance

[`src/server/header_store.titan`](../src/server/header_store.titan) normalizes ordered C-header dependency closures across three tables. `main.header_dependencies` stores each distinct dependency value once—its kind, path, identity, and optional physical observation columns. `main.header_owners` identifies each owner by `(scope, key)` across four scopes: `0` for an observed module baseline, `1` for an analyzed external module, `2` for a parsed C-header artifact, and `3` for an FFI conversion artifact. `main.header_inputs` stores each owner's ordered dependency list, including duplicates or an empty list.

The three `CHeaderDependencyKind` values remain distinct across saved and detached completion state: `file` (`0`) certifies parsed bytes, `search` (`1`) certifies an exact include candidate (including a miss), and `origin` (`2`) certifies the realpath naming a C declaration's nominal scope. A `file` and `origin` entry for the same path coexist so retargeting a symlink to identical bytes invalidates its nominal C origin. Physical observation fields (`observed_seconds`, `observed_nanos`, `physical_identity`, `precision`, `size`, `changed_seconds`, `changed_nanos`) authorize the compiler's read fast path rather than semantic equality. Two partial unique indexes—`header_dependencies_absent` (`WHERE observed_seconds IS NULL`) and `header_dependencies_observed` (`WHERE observed_seconds IS NOT NULL`, normalizing nullable observation fields via `COALESCE`)—deduplicate values cleanly under SQLite's `NULL` uniqueness rules.

`incoming` and `replace` upsert closures in 16-row CTE packets (staying under Titan's 200-argument variadic limit) and resolve row IDs with a `UNION ALL` split across the two partial unique indexes:

```titan
function replace(connection: sqlite3.Connection, scope: integer, key: string,
                 inputs: const? {bridge.CHeaderDependency})
  sql.execute(connection,
    "INSERT INTO main.header_owners(scope,key) VALUES(?,?) ON CONFLICT(scope,key) DO NOTHING",
    scope, sqlite3.Blob(key))
  local owner = sql.scalar_integer(connection,
    "SELECT id FROM main.header_owners WHERE scope=? AND key=?", scope, sqlite3.Blob(key))
  sql.execute(connection, "DELETE FROM main.header_inputs WHERE owner_id=?", owner)
  for first = 1, #inputs, 16 do
    local last = first + 15
    if last > #inputs then last = #inputs end
    local prefix, parameters = incoming(inputs, first, last)
    sql.execute(connection, prefix ..
      "INSERT INTO main.header_dependencies(kind,path,identity,observed_seconds,observed_nanos,physical_identity,precision,size,changed_seconds,changed_nanos) " ..
      "SELECT kind,path,identity,observed_seconds,observed_nanos,physical_identity,precision,size,changed_seconds,changed_nanos FROM incoming " ..
      "WHERE true ON CONFLICT DO NOTHING", ...parameters)
    parameters[#parameters + 1] = owner
    sql.execute(connection, prefix ..
      "INSERT INTO main.header_inputs(owner_id,ordinal,dependency_id) " ..
      "SELECT ?,resolved.ordinal,resolved.id FROM (" ..
        "SELECT i.ordinal,d.id FROM incoming i JOIN main.header_dependencies d " ..
        "ON d.kind=i.kind AND d.path=i.path AND d.identity=i.identity " ..
        "WHERE i.observed_seconds IS NULL AND d.observed_seconds IS NULL UNION ALL " ..
        "SELECT i.ordinal,d.id FROM incoming i JOIN main.header_dependencies d " ..
        "ON d.kind=i.kind AND d.path=i.path AND d.identity=i.identity " ..
        "AND d.observed_seconds=i.observed_seconds AND d.observed_nanos=i.observed_nanos " ..
        "AND d.physical_identity=i.physical_identity " ..
        "AND d.precision IS i.precision AND d.size IS i.size " ..
        "AND d.changed_seconds IS i.changed_seconds AND d.changed_nanos IS i.changed_nanos " ..
        "WHERE i.observed_seconds IS NOT NULL AND d.observed_seconds IS NOT NULL) AS resolved",
      ...parameters)
  end
end
```
*Source: [`src/server/header_store.titan`](../src/server/header_store.titan) — `replace`*

Refreshing an owner (`refresh`) replaces only that owner's links without mutating shared dictionary rows in place. Accepted publication calls `prune` once to remove unreferenced dependency rows; a missing owner turns its artifact into a cache miss.

## Startup revalidation

Before serving reused SQL answers, `load_or_raise` in [`src/server/project_loader.titan`](../src/server/project_loader.titan) validates the compiler inventory (reusing `main.compiler_inputs` stat stamps through `Cache:inventory_identity`), the native context, saved project sources, and compiler-owned header inputs, and dirties any `unpublished_projects` whose graph revision lacks complete semantic or completion rows.

Saved-source and external-file validation (`read_saved_file` in [`src/server/project_service/scan_and_provenance.titan`](../src/server/project_service/scan_and_provenance.titan)) records `lstat` and `stat` kind, device, inode, size, mode, and nanosecond mtime. An unchanged observation reuses the stored fingerprint without reading the file; a changed observation performs a stable read and SHA-256 hash. A deliberate byte edit that preserves all of that metadata goes undetected.

Header validation follows the compiler's stricter contract: metadata-only reuse requires nanosecond precision and a change timestamp (`ctime`). Because `titan.fs.Stat` exposes no change timestamp, header restatting rereads and hashes header bytes. Equal bytes preserve semantic identity across a timestamp-only touch, while `origin` realpaths and exact `search` candidates remain independent inputs so symlink retargeting and newly eligible earlier include candidates invalidate even when another header's bytes are unchanged.

Validated SQL answers are served immediately, before declaration manifests finish restoring. `Restoration` in [`src/server/project_loader.titan`](../src/server/project_loader.titan) snapshots `Cache:project_candidates()` (module names and revisions) and runs an owned background `async.Task` that yields once so `READY` and the SQL `View` publish first, reads each payload BLOB under a short per-module `Store` lease, and decodes manifests through `Compiler:restore_project_cache`. Saved edits, compiler-verified rename, and shutdown (`Restoration:close`) coordinate through `Restoration:finish`, which invalidates any missing candidates on the foreground updater. Cached diagnostic rows remain hidden on attachment until this worker accepts a publication for the current saved epoch; that eligibility lives in the running `Application`, not the cache schema.

### Measured footprint

Persisted project payloads stay small once function bodies are removed. Extracted C-header graphs and FFI conversion payloads dominate the database, measuring hundreds of megabytes on the Titan repository. Framed strings make up most of those payloads; they repeat across artifacts, while required declarations, exact expression tokens, and provenance limit deduplication. The allocation census is preserved in [Appendix C](benchmarks.md#retired-evidence-records).

---

← Previous: [Chapter 3](compiler-bridge.md) | [Table of Contents](index.md) | Next: [Chapter 5: Saved-File Intelligence](semantic-features.md) →
