# Workspace storage

Each workspace root persists its saved index, dependency metadata and compiler
artifacts in one SQLite database. The database is a disposable cache: a
compatible restart reuses it, and anything else rebuilds it through ordinary
indexing. [Completion](completion.md#temp-storage-and-selection) adds
connection-local TEMP tables on the same connection.

## Location and opening

`workspace_cache.directory` in `src/server/workspace_cache.titan` places
`.titan-ls/` in the physical (realpath) workspace root. It creates the
directory with a `.gitignore` containing `*`, then opens `index.sqlite3` there.
Project discovery and the watchers always skip `.titan-ls`. The same directory
is that root's default compiler probe-cache prefix, so a router session with
several roots keeps one database and one probe namespace per root; see
[server data flow](server-data-flow.md#where-compiler-inputs-come-from).

Startup opens the file with `workspace_cache.open_for_inventory`, and
`open_compatible` decides whether to keep it:

- `PRAGMA user_version` must be `0` (an empty file, initialized in place) or
  `SCHEMA_VERSION` (currently 8).
- A versioned file must have a `compatibility` entry in `cache_meta`, and all
  `cache_meta` keys and values must be BLOBs.
- A file with a `compatibility` entry must pass `PRAGMA quick_check`.

`project_loader` then calls `Cache:validate_inventory` with a compatibility
key. The key digests the physical root with `Compiler:cache_identity` and
`ProjectConfig:semantic_identity`. The first fingerprints the compiler Lua
trees as this process loaded them, their native Lua dependencies and the
interface provider: the executable's embedded provider for the server's own
SDK, or the selected installation's standard archive (Unix) or provider DLL
(Windows) by ordinary stat identity. Browser workers instead key on the
validated target descriptor, absent-module list and Wasm provider identity.
Reinstalling a provider invalidates only roots using it. The second key
covers project configuration, including the target but excluding watcher
policy. The key carries no schema number: `PRAGMA user_version` alone decides
schema compatibility. A missing key is recorded, and a different stored key
triggers `Cache:rebuild`.
`Cache:accept_native_context` likewise compares the stored `native_context`
with `Compiler:native_cache_identity` and rebuilds on a mismatch.

A browser cache whose saved analysis used a real C probe also stores that
probe environment's identity, or its recorded unavailability. Reopening
validates this marker before restoring the saved view. Installing or removing
the pinned toolchain, or changing its C environment, rejects incompatible
cached facts. Browser caches without such a marker never start Emscripten
for ordinary typechecking or startup.

A rejected file, or one that SQLite reports as corrupt (`SQLITE_CORRUPT` or
`SQLITE_NOTADB`), is deleted and recreated. Any other open failure logs
`cache.memory_fallback` and uses the same schema in an in-memory database.
Tables are created with `CREATE TABLE IF NOT EXISTS` on every open, so a
missing table is recreated empty.

Changing the compiler, the server image or the configuration therefore costs
one cold index. The cache version number does not change for these cases.

## Connection ownership

`workspace_store.Store` owns the single serialized connection for a workspace.
Callers take a FIFO lease (`Store:acquire`) for a complete operation: a
saved publication, a TEMP publication or a logical read. Compilation and
semantic extraction run outside those short transactions. The SQL publication
then commits the new facts and the `store_state.published_generation` counter
together. Readers fence their results with that counter.

## Tables by owner

| Owner module | Tables | Contents |
| --- | --- | --- |
| `workspace_store` | `store_state`, `cache_meta` | Published generation; compatibility, native context and published-revision keys |
| `workspace_cache` | `project_snapshots`, `header_graphs`, `ffi_conversion_snapshots`, `compiler_inputs` | Opaque compiler payloads by module or artifact key; observed compiler-inventory files |
| `header_store` | `header_dependencies`, `header_owners`, `header_inputs` | Ordered C-header dependency closures |
| `project_graph` | `graph_state`, `graph_modules`, `graph_files`, `graph_imports` | Module graph, file stamps, import edges and manifest comparison digests |
| `project_metadata` | `project_records`, `project_sources`, `project_diagnostics`, `external_*` | Saved source bytes and stamps, compiler diagnostics, and external-module manifests and observations |
| `semantic_index` | `semantic_projects`, `semantic_files`, `semantic_summaries`, `semantic_occurrences`, `semantic_occurrence_inputs` | Saved query facts |
| `semantic_features` | `semantic_hovers`, `semantic_folds` | Materialized hover text and folding ranges |
| `published_diagnostics` | `semantic_diagnostic_publications`, `semantic_diagnostic_items` | Published Problems entries |
| `completion_store` | `main.completion_*` | The [saved completion baseline](completion.md#input-and-publication-ownership) |

Feature queries read only these SQL facts and never traverse compiler ASTs.
Indexed lookups include `semantic_occurrences_file` (occurrence at a position),
`semantic_declarations` (definition), `semantic_occurrences_symbol`
(references), `graph_reverse` (importers) and `graph_project_work` (pending
project work).

## Compiler payloads

Project payloads hold detached declared member and type manifests. These
include public and trusted source visibility, generic binders, nominal owners
and the ordered foreign-header plan. Function and method bodies exist only
during fresh checking and semantic extraction. After an accepted publication,
the server releases them. Unchanged modules keep their SQL facts, while
changed, failed and removed modules replace only their own rows. External
source and binary modules keep manifests and provenance only
(`external_records`).

C-header artifacts accept `c-header-v8`; FFI conversion artifacts accept
`ffi-conversion-v8`. `artifact_namespace` in `src/server/workspace_cache.titan`
is the single owner of that mapping: it resolves a kind to its payload table
and to the `header_store` provenance scope for its ordered inputs. Schema
creation, staging, publication, `Cache:lookup` and `Store:read_saved_cache` in
`src/server/completion_store.titan` all read the same map, so private
preparation accepts exactly the namespaces the watcher publishes. Older
namespaces are misses, not aliases.
`test_workspace_cache_accepts_installed_compiler_artifact_namespaces` in
`src/server/workspace_cache_test.titan` reads both kinds from the installed
compiler and exercises saved lookup and private reads, including their saved
generation fence. A compiler update that renames a kind therefore fails that
test on both paths instead of silently missing the cache. Unknown kinds remain
cache misses.
The relational store never interprets payload contents; the compiler's envelope
and version checks govern them.

Mutable preprocessor contexts for forced `-include` and `-imacros` inputs are
not persisted. A fresh process preprocesses them again before validating
extracted-definition entries.

## Header provenance

`header_dependencies` stores each distinct dependency value once: a kind, a
path, an identity and an optional physical observation. `header_owners`
identifies each owner by scope: 0 for an observed module baseline, 1 for an
analyzed external module, 2 for a parsed header artifact and 3 for an FFI
conversion. `header_inputs` lists each owner's dependencies in order,
including duplicates. An owner may have an empty list.

Header kinds remain distinct throughout saved and detached completion state:
`file` certifies bytes, `search` certifies an exact include candidate, and
`origin` certifies the realpath naming a C declaration's nominal scope.
A file and origin input for the same pathname coexist; retargeting a symlink
to identical bytes must still invalidate its nominal C origin. Physical
observations also retain precision, size and optional change timestamps; those
fields authorize the compiler's read fast path, not semantic equality.
Schema 8 adds these observation fields and the origin kind. Older databases are rebuilt
as disposable caches, without migration.

Refreshing an owner replaces only that owner's inputs. Publication prunes
dependency values that no owner references. A missing owner makes its artifact
a cache miss.

## Manifest comparison digests

`graph_modules.public_digest` and `source_digest` hold 32-byte SHA-256 digests
(`content_identity.digest`) of the public and source-collaboration manifests.
They are used only for equality. A changed public digest invalidates immediate
importers, and an unchanged one stops propagation. Reloadable manifests stay in
the project payloads and `external_records`.

## Startup revalidation

Before it publishes reused answers, startup validates the compiler inventory,
the native context, then saved sources and compiler-owned header inputs.
Saved-source observations record `lstat` and `stat` kind, device, inode, size,
mode and nanosecond mtime. An unchanged source observation reuses the stored
fingerprint without reading the file; a changed observation reads and hashes it.
A deliberate source-byte change preserving all of that metadata goes undetected.

Header validation follows the compiler's stronger contract: metadata-only
reuse requires nanosecond precision and a change timestamp. The server's
`titan.fs.Stat` strategy currently exposes no change time, so it rereads and
hashes header bytes. Equal bytes still preserve semantic identity across a
touch. Origin realpaths and exact search candidates remain independent inputs;
symlink retargeting and newly eligible earlier include candidates invalidate
even when another header's content is unchanged.

Validated SQL answers are served before declaration manifests finish
restoring. `Restoration` in `src/server/project_loader.titan` decodes them in an
owned background Task, which `Application` starts and finishes. Saved edits and
compiler-verified rename coordinate with it.
Cached diagnostic rows do not become visible on attachment until this worker
has accepted a publication for the current saved epoch. That eligibility
belongs to the running application, not the cache schema.

## Measured footprint

Persisted project payloads are small once bodies are removed. Extracted C-header
graphs and FFI conversion payloads now dominate the database; for the Titan
repository it measured hundreds of megabytes. Strings, including their framing,
make up most of those payloads. The strings repeat heavily across artifacts,
but the required declarations, exact expression tokens and provenance limit
how much deduplication could remove. The allocation census is a
[retired record](benchmarks.md#retired-evidence-records).
