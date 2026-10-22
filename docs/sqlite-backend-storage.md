# Workspace storage

Each workspace persists its saved index, dependency metadata and compiler
artifacts in one SQLite database. The database is a disposable cache: a
compatible restart reuses it, and anything else rebuilds it through ordinary
indexing. [Completion](completion.md#temp-storage-and-selection) adds
connection-local TEMP tables on the same connection.

## Location and opening

`workspace_cache.directory` in `src/server/workspace_cache.titan` places
`.titan-ls/` in the physical (realpath) workspace root. It creates the
directory with a `.gitignore` containing `*`, then opens `index.sqlite3` there.
Project discovery and the watchers always skip `.titan-ls`. The same directory
is the default compiler probe-cache prefix; see
[server data flow](server-data-flow.md#where-compiler-inputs-come-from).

`workspace_cache.open` accepts an existing file only when all of these hold:

- `PRAGMA user_version` equals `SCHEMA_VERSION` (currently 7);
- the stored `compatibility` entry in `cache_meta` matches;
- `PRAGMA quick_check` returns `ok`.

The compatibility key digests the physical root with
`Compiler:cache_identity` and `ProjectConfig:semantic_identity`. The first
fingerprints the compiler Lua trees, their native Lua dependencies and the
server executable. The second covers the project configuration, except watcher
policy. `project_loader` then requires the stored `native_context` to match
`Compiler:native_cache_identity`; on a mismatch it calls `Cache:rebuild`.
A mismatched file, or one that SQLite reports as corrupt (`SQLITE_CORRUPT` or
`SQLITE_NOTADB`), is deleted and recreated. Any other open failure logs
`cache.memory_fallback` and uses the same schema in an in-memory database.
Tables are created with `CREATE TABLE IF NOT EXISTS` on every open, so a missing
table is recreated empty.

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

C-header and FFI conversion artifacts use the compiler kinds `c-header-v6` and
`ffi-conversion-v7`. `artifact_table` and `artifact_scope` in
`workspace_cache.titan` map them to their tables.
`test_workspace_cache_accepts_installed_compiler_artifact_namespaces` in
`src/server/workspace_cache_test.titan` reads both kinds from the installed
compiler. A compiler update that renames a kind therefore fails that test
instead of silently missing the cache. `Store:read_saved_cache` in
`completion_store.titan` repeats the mapping, and that test does not cover the
copy ([#113](https://github.com/mascarenhas/vscode-titan/issues/113)). The
relational store never interprets payload contents; the compiler's
envelope and version checks govern them.

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
the native context, then saved sources, headers and search inputs. An
observation records `lstat` and `stat` kind, device, inode, size, mode and
nanosecond mtime. An unchanged observation reuses the stored fingerprint
without reading the file. A changed observation reads and hashes the file. If
the content is unchanged, only the observation is updated. Replacements,
symlink changes and new earlier include-search candidates still invalidate.
A deliberate byte change that preserves all of that metadata goes undetected.

Validated SQL answers are served before declaration manifests finish
restoring. `Restoration` in `src/server/project_loader.titan` decodes them in an
owned background Task, which `Application` starts and finishes. Saved edits and
compiler-verified rename coordinate with it.

## Measured footprint

Persisted project payloads are small once bodies are removed. Extracted C-header
graphs and FFI conversion payloads now dominate the database; for the Titan
repository it measured hundreds of megabytes. Strings, including their framing,
make up most of those payloads. The strings repeat heavily across artifacts,
but the required declarations, exact expression tokens and provenance limit
how much deduplication could remove. The allocation census is a
[retired record](benchmarks.md#retired-evidence-records).
