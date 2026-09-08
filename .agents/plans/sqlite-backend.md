# Workspace SQLite backend (#20)

Status: initial implementation, both representative benchmarks, local verification,
and Linux hosted delivery completed in PR #55 and Titan PR #148. Titan #148 is
merged at `534abf000ce7957113dfed780508e16535d0acd5`. Startup follow-up below is
authorized and active. Branch: `agent/sqlite-backend`.

Scope authority: [vscode-titan #20](https://github.com/mascarenhas/vscode-titan/issues/20).
Baseline: vscode-titan `551d01785ea8cdbbcf2c7706158a2525f1658d31`, Titan
`16d9770684cb4d94a1d20fa81698be4a794f0574` (live heads checked 2026-09-06).
Completion/unsaved files remain the separate #50 scope.

## Contract

Replace the maintained semantic lookup and dependency metadata structures with
one SQLite store per workspace, ordinarily `.titan-ls/index.sqlite3`, using the
same schema and typed API with `:memory:` in most tests. All saved SQL addresses
`main.`. Keep only live project compiler graphs, Tasks, and temporary extraction
state in memory. Never persist external Titan ASTs through graph references.

The existing updater is the sole writer. One workspace connection is leased for
a whole logical read or update transaction; every cursor closes before another
statement or releasing access. Compilation and extraction precede the short
publication transaction. The last completed feature view stays usable during
refresh. Authoritative failures remove affected semantics and replace diagnostics
atomically. Work revisions and published feature generations remain distinct.
Shutdown drains COMMIT/ROLLBACK before closing; request cancellation cannot own
or cancel writer cleanup. No concurrent-writer framework or new writer actor.

Preserve exact saved-byte/UTF-16 spans, declaration/import-alias roles, external
references without definitions, deterministic binary-path ordering, private/public
source visibility, hover richness, folding order, and compiler preflight rename.
Missing providers retain incoming edges. Manifest changes wake immediate
importers by visibility; external traversal stops at project roots. Failure
recovery, folder membership, source precedence and stale-result rejection retain
their current contracts.

Persist versioned compiler-owned checked-project and completed-header graph
payloads in this same database. Graph codecs preserve cycles, aliases, table keys,
macro spelling/spacing sidecars and supported metatables without executable Lua.
Hydration recreates resolver-owned generated headers and source-private links.
A separate safe conversion replay contract must skip unchanged FFI conversion
after importer-only edits; a parsed-header cache alone is insufficient.

Validate source/header observations and all observed search candidate identities,
including missing candidates, symlink identities, folder constituents and external
providers, before warm publication. Cache compatibility includes root, evaluated
semantic configuration, compiler build/API, semantic/library/ABI versions,
codec/schema versions, target/provider and ordered preprocessing context.
Corrupt, incompatible or unsupported payloads rebuild; unavailable workspace
storage falls back to memory. The startup follow-up below supersedes the original
same-mtime content-change guarantee with the maintainer's explicit timestamp-trust
policy. The completed evidence below describes the original implementation.

## Authorized startup follow-up (2026-09-08)

The maintainer requested metadata-first validation with **no file-content read or
hash when the saved mtime is unchanged**, and moving graph hydration to a
background task that yields frequently so it does not block server startup. The
maintainer also requested reviewing #50 so completion queries do not require the
hydrated graph, and collecting this pending work in a durable session goal.

### Validation contract

- Separate observed timestamps from semantic content identity. Compare precise
  mtime plus cheap physical metadata for the same resolved input first. Reuse
  stored contents/digest when those observations match. A timestamp change reads
  and hashes stable bytes; unchanged content refreshes only the observation, with
  no work revision, semantic generation, AST eviction, or dependent reanalysis.
- Retain checks for missing/replaced files, symlink/target identities, contributor
  membership and ordered source/header search precedence. Deliberately changing
  bytes while preserving the trusted timestamp and physical metadata is outside
  this policy. Tests and issue wording must state that boundary explicitly.
- Apply the policy to project and external inputs, compiler/header validation,
  persisted header and FFI replay, and normal in-process cache reuse. Persist
  refreshed header observations separately from semantic keys. Avoid reopening
  unchanged headers for content checks; share observations within a validation
  pass where the same header/search path appears in several module closures.
- Reuse stored compiler-inventory digests under the same metadata policy; keep
  compatibility checks for the actual selected compiler/dependencies/provider.
  Loading compiler code normally is distinct from rereading it for validation.
- Track incompatible disposable storage and codec formats where old records
  cannot safely express the new contract. Keep compiler hooks storage-neutral.
  Per the maintainer's subsequent instruction, the language-server API version
  is reset to `1` and remains `1` until Titan's first public release; update
  compiler and consumer guards, tests, and durable guidance together.

### Background hydration and query contract

- Publish a validated saved SQL view without waiting for graph payload decoding.
  Ordinary definition/reference/hover/folding reads remain SQL-only and usable
  while hydration is pending. Do not fetch all graph BLOBs on the readiness path.
- Own hydration in the existing workspace lifecycle. Decode with bounded work
  checkpoints inside large payloads, yielding frequently without holding a Store
  lease. Preserve compiler scheduler ownership and non-string cancellation.
- Coordinate compiler-dependent saved edits and rename with hydration; prevent
  stale graph installation after invalidation/configuration changes. Unsupported
  or corrupt graphs fall back to normal analysis. Cancel and drain owned tasks
  before releasing compiler contexts or closing workspace storage.
- Review/update #50's design and acceptance criteria, without implementing
  completion in this follow-up: saved and TEMP structured facts must support the
  query path without AST access or a hydration barrier. Preparation uses an
  isolated compiler context and captured saved interfaces/inputs; fallback while
  preparation is pending must not force global graph hydration.

### Ownership and verification

- Source-validation owner: Service, Graph, Metadata, schema and their tests;
  coordinate the typed header observation contract with the bridge owner.
- Hydration owner: application/loader/compiler bridge lifecycle and their tests;
  coordinate Service entry points before editing shared files.
- Compiler owner: a new focused Titan branch from merged master, header
  observation APIs and bounded codec progress hooks, existing Busted regressions,
  compiler documentation and its own durable plan.
- Root: compiler inventory integration, #20/#50 contracts, plan/docs, integration
  transcripts, benchmark harness/report and final review/delivery. Coordinate
  individual shared-file sections explicitly; use private source/build stages.
- Prove zero content reads/hashes for unchanged observations across refresh and
  restart; prove timestamp-only touches preserve semantic results and payload
  revisions; preserve meaningful changed-input/precedence/ownership regressions.
- Prove SQL readiness and request responsiveness while hydration is blocked or
  yielding, safe first-edit/rename coordination, stale-work rejection, cancellation
  and drained shutdown. Benchmark both actual repositories again, separating SQL
  readiness from hydration completion, read/hash counts, CPU/RSS and query latency.
- Run focused gates, compiler broad/native gates as applicable, canonical
  terminal-backed `make verify`, packaging checks and required Linux hosted CI.
  Update PR #55 and open a new Titan companion PR only after local integration is
  complete. Leave PRs open. No merge or macOS dispatch is authorized.
  The maintainer additionally requires the final extension pin to equal the live
  Titan `master` HEAD, with CI passing against that exact commit. Any new compiler
  prerequisite must reach master before this goal can be considered complete;
  present its verified PR for explicit merge authorization when it is ready.

## Ownership and sequence

1. Shared store and graph: `workspace_store.titan`, its tests,
   `project_graph.titan`, its tests. Provide `Store:acquire()` -> `Access`
   carrying `connection`, synchronous idempotent `Access:release()`, and
   drained `Store:close()`. Graph borrows the store and retains only project
   AST handles. No nested leases or independent commits in borrowed adapters.
2. Semantic queries: `semantic_index.titan`, `semantic_features.titan`, their
   tests. Prepare typed rows/hover/folds outside publication, publish through a
   borrowed connection, read under whole-operation access. Extraction lookups
   are transient. Remove old maintained indexes/sorts. SQL feature handles
   validate their published generation while holding access.
3. Main integration: application/compiler bridge/workspace/watch lifecycle,
   schema compatibility and persistence transport, diagnostics, exact hashing,
   reopen/fallback, integration tests, documentation, benchmarks and packaging.
4. Compiler prerequisites: separate new Titan branch and durable plan; compiler
   Lua codecs/header hooks/conversion replay, existing Busted shard regressions,
   manuals. The compiler accepts transport hooks, without a SQLite dependency.
   The server updater alone publishes returned cache records. Rename output is
   transient. Open the Titan PR only after the extension work is locally wrapped
   and verified, as required by repository guidance.

Create dependent board-sized issues before source changes. Each parallel agent
owns disjoint authored files. Use private temporary source/build stages; only
the root runs the shared `.build` full gate. Recheck source/branch before staging
exact paths. Leave all PRs open for maintainer review and never merge or push
directly to default branches.

## Acceptance and validation ledger

- [x] Shared file/memory store, versioned schema, `main.` SQL, FK readback and
  complete-operation serialization. V287.
- [x] SQL replaces maintained file/symbol/declaration/filename/summary indexes. V287.
- [x] SQL owns modules, revisions, manifests, edges, inputs and diagnostics;
  missing-provider, folder, failure, visibility and stale-result parity. V287/O19.
- [x] Materialized hover/folding and exact span validation; all feature/rename
  results retain current behavior. V287/O19.
- [x] Sole writer publication, preceding completed reads, rollback/cancellation
  and drained shutdown tests. V287.
- [x] Workspace ownership, root/config identity, discovery/watcher/VCS/package
  exclusion, memory fallback and corruption/reopen tests. V287/O19/PKG226.
- [x] Project and completed-header bounded graph codecs, aliases/cycles/table
  keys/sidecars, no external Titan AST serialization, corrupt payload misses.
  V287/O19/C3450/F89.
- [x] Exact saved byte hashes, complete header/search identities and ordered
  preprocessing/provider keys; preserved-mtime and shadowing invalidation.
  V287/O19/C3450/F89.
- [x] Compatible in-memory header reuse across roots/edits after validated reload.
  O19/C3450/F89/BV.
- [x] Compiler/library/ABI/API/target/provider/codec compatibility checks.
  V287/O19/C3450/F89.
- [x] Hydrated project graphs support the first edit without rechecking unchanged
  dependencies; the restart first request parses/checks no unchanged project
  module. O19 and representative runs BV (62 modules) and BT (63 modules).
- [x] Importer-only edits skip unchanged header preprocess/parse/conversion;
  relevant header/search/declaration/target changes rebuild. O19/C3450/F89/BV.
- [x] Predominantly memory graph/index/feature suites plus real-file interrupted
  publication, restart, relocation, fallback and cache recovery coverage. V287/O19.
- [x] Indexed query plans and bounded batch ingestion. V287/BV.
- [x] Persistent monotonic graph revisions, schema-2 rebuild, sparse project
  export/publication and native SHA-256 callback with unchanged codec format.
  V287/O19/C3450/F89.
- [x] Focused compiler tests and relevant broad gate, then `make verify`, native
  dependency/VSIX/notices checks; SQLite provider expectations match the linked
  implementation. V287/C3450/N455/F89/PKG226.
- [x] Benchmark both actual Titan and vscode-titan cold/warm/edit/header paths,
  wall/CPU, hashing/revalidation, work counters, query latency, database/sidecar
  size and peak RSS. BV and BT passed all strict work, feature, integrity and
  restoration checks. Historical baselines and measurement limits are preserved.
- [ ] Review final diffs and exact commits; open the extension PR, then the Titan
  PR; inspect hosted Linux CI and Project state using the verified compiler pin. Leave both
  PRs open. No macOS dispatch, default-branch push or merge is authorized.

The live issue's 22 acceptance criteria remain authoritative. This ledger groups
them for implementation; no criterion is deferred or silently narrowed. The
appendix below maps every criterion to its verification evidence. Both required
repository measurements passed; PR/CI/Project evidence remains to be recorded
from the requested delivery sequence.

## Evidence

Initial worktree and remote heads were clean and matched the baseline above.
Installed isolated toolchain: Titan 0.6.0-1, SQLite 3.53.4. Earlier native probes
established static SQLite linkage, BLOB/transaction/reopen support, bounded
multirow binding, and cancellation cleanup constraints; they remain feasibility
evidence only.

### Historical implementation and baseline evidence

The 2026-09-06 focused runs passed 65 Store/graph/metadata/Service tests,
49 Application/semantic/diagnostic tests, and the first six cache/hash tests.
An initial one-module native cold/restart smoke preserved hover and eliminated
restart parse/check work. These early counts are superseded by the final gate.

Before the performance changes, the canonical full gate passed 281 native,
56 JavaScript and 12 Extension Host tests plus protocol, cache, Codex, staged
install and packaging checks. A separate expanded 19-process transcript passed,
including compiler bytes changed at identical size/mtime. The corresponding
pre-callback compiler aggregate passed 3,445 cases. These are historical runs;
V287/O19/C3450/N455/F89/PKG226 below describe the final implementation.

The first real vscode-titan measurement proved an unchanged restart performed
no Titan analysis or header preprocessing/parsing/conversion. It exposed
unnecessary serialization: a saved importer edit encoded all 62 project
payloads, about 142 MB, consuming 45.836 seconds of encoding CPU. Warm graph
hydration took 45.668 seconds of wall time. Baseline readiness was 86.793 seconds
cold, 53.433 seconds unchanged, 64.116 seconds for the saved importer comment,
and 142.729 seconds after the header comment. These measurements remain labeled
as the pre-optimization baseline in `docs/sqlite-backend-benchmarks.md`.

The first Titan attempt failed to index SQLite because its existing
`titan-config.lua` omitted `sqlite-autoconf-3530400` from the FFI include roots.
It reached a ready notification after 614.873 seconds, but the target hover was
missing and the runner exited nonzero. It provides configuration-failure
evidence, with no valid warm/edit/header timings. Its diagnostics and raw
artifacts are preserved alongside the baseline. Both runners restored source
and header bytes, nanosecond timestamps, and the prior workspace-cache state.

### Completed revision and serialization changes

1. `graph_state.work_revision` now allocates persistent monotonically increasing
   work identities. Removing and recreating a module cannot match an older
   payload's module/revision pair, including after deleting every graph row and
   reopening the store. The disposable server schema is version 2; older schema
   files rebuild before graph use. V287 tests both stale-work rejection and
   unpublished-payload identity reuse across removal/recreation/reopen.
2. The cache selects only clean project modules without a valid payload for
   their completed revision. The compiler still receives the full project-file
   allowlist, so cross-project generic and source-private annotations remain
   representable. Publication preserves unchanged rows, prunes obsolete or
   malformed rows, and upserts selected successful payloads in the same atomic
   transaction as semantics and diagnostics. An unrepresentable replacement
   cannot retain an older revision. Forced late-failure tests prove rollback
   restores payloads and metadata; mixed old-provider/new-consumer hydration
   preserves hovers, definitions and subsequent incremental reuse. O19 requires
   the importer edit to encode exactly the `consumer` payload.
3. CPU attribution confirmed that pure-Lua SHA-256 dominated representative
   project graph checksums. The bridge supplies its native SHA-256 through the
   compiler's optional per-operation callback, including header and FFI replay
   transport. It returns the same 32 binary bytes and preserves the codec
   representation; the standalone compiler retains its pure-Lua fallback.
   C3450/F89 cover callback/fallback interchange, binary input, corrupt payloads,
   callback failures and adapter propagation. V287 compares native and compiler
   binary digests directly. Serialization and hydration yield between module
   payloads without retaining a Store lease.

### Final correctness and packaging gates

| Evidence | Verified result |
| --- | --- |
| V287 | Canonical terminal-backed `xvfb-run -a make -j1 verify`, exit 0: 287 native, 56 JavaScript and 12 Extension Host tests; protocol, Codex/plugin, staged-install, notices/native-linkage and packaged SDK-free compiler checks passed. |
| O19 | Final 19-process workspace-cache transcript within V287 passed. Covers unchanged/copy-compiler warm starts, identical-size/mtime source/header/compiler changes, search shadowing, configuration changes, dependency/failure recovery, malformed payload/metadata, corrupt/incompatible database and memory fallback. The first importer edit checks and encodes only the importer and reuses the persisted FFI graph. |
| C3450 | Final API-6 compiler Busted aggregate: 3,450 successes, no failures/errors/pending, 539.519109 seconds, exit 0. |
| N455 | Final native standard-library aggregate: 455/455 passed against the refreshed current provider. |
| F89 | Final focused callback/graph/project/header/FFI-conversion suite: 89/89 passed. |
| PKG226 | Rebuilt VSIX and complete inspection passed, exit 0: 226 archive entries, 31.59 MB, no workspace cache, correct native linkage and SDK-free compiler smoke. |

The first V287 package listing revealed a local `.titan-ls` database in the
archive. The package ignore file now excludes every such subtree, and the VSIX
inspector independently rejects an exact `.titan-ls` path segment at any depth.
The guard rejected the old archive; PKG226 validates the corrected package.
Independent ZIP inspection found zero cache entries and confirmed the unchanged
native executable SHA-256:
`a388a82c7631190051799e3b9edce2931e8fec362b4d0e5fcae1ede7baf3e6bb`.

All 61 compiler/C-parser Lua modules byte-match the final sibling branch and
isolated installed toolchain. The final gate used that compiler installation.
Native and compiler test processes finished before the exclusive final benchmark
window; no production source changes occurred during those measurements.

The extension CI configuration pins compiler commit
`c7caae130175fce0b949017495a352b3f9561b2c`. Hosted CI success and the resulting
PR/Project status remain pending.

The retained local gate logs are `make-verify-optimized.log` and
`package-cache-exclusion.log` under `/tmp/vscode-sqlite-loader/`, and
`/tmp/titan-cache-full-compiler-optimized.log`. The durable counts and coverage
above do not depend on volatile source line references.

The final report consistency review compared all 32 readiness/resource, warm
phase, work-counter and feature-latency table rows against the two raw summaries.
All values matched after applying the documented startup-CPU convention and
displayed RSS rounding. Dependency profile wording was corrected to distinguish
zero parse/check CPU from other bookkeeping CPU.

### Final representative measurements

**BV: vscode-titan passed** using the fixed native executable identified above.
All feature equality, unchanged-work, saved-edit reuse, header invalidation,
database `quick_check`, and source/header/cache restoration checks passed.

| vscode-titan workload | Ready wall (s) | Server CPU (s) | Descendant CPU (s) | Peak RSS (MiB) | Database at ready (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cold startup | 51.291 | 48.900 | 0.850 | 3,534.6 | 205.9 |
| Unchanged restart | 18.626 | 18.360 | 0.030 | 3,559.6 | 205.9 |
| Saved importer comment | 17.440 | 16.770 | 0.040 | 3,568.3 | 224.2 |
| Header comment startup | 63.773 | 62.020 | 0.400 | 4,224.9 | 224.2 |

BV restored all 62 project payloads without project parsing, checking or
encoding, or header preprocessing/parsing/FFI conversion. Named warm startup
wall phases were inventory 0.727 seconds, native context 0.341 seconds, saved
input validation 3.609 seconds and project hydration 10.199 seconds. The saved
edit parsed/checked and encoded only `server.compiler_io`: one 2,205,925-byte
payload in 0.176 seconds of encoding CPU, with one FFI replay hit and zero
header preprocess/parse or FFI conversion calls. The changed header caused one
preprocess/parse pass and two FFI conversions; 12 affected modules required new
payloads. All five inspected SQLite query plans selected indexed searches.

These are one sequential run on the recorded Linux host, with the OS page cache
left intact. Saved-edit RSS is the restarted process's lifetime peak; server
and reaped descendant CPU are separate columns. Startup CPU includes launch
through initialization plus indexing CPU; saved-edit CPU is the edit delta.
No WAL, SHM or journal sidecar
existed at the readiness/shutdown snapshots; transient journal peaks are not
measured. Full query-latency samples, work counters and phase attribution are
retained in `.build/cache-benchmarks/vscode-titan-final-20260907/summary.json`.
`docs/sqlite-backend-benchmarks.md` is the durable report for methodology and
historical/final results.

**BT: Titan passed** using the corrected SQLite include configuration and the
same fixed native executable. Both complete benchmark sequences passed their
strict work, feature, integrity and restoration checks. The benchmark owner
independently rechecked source/header bytes, nanosecond mtimes, prior cache,
absence of backup residue and absence of active benchmark processes.

| Titan workload | Ready wall (s) | Server CPU (s) | Descendant CPU (s) | Peak RSS (MiB) | Database at ready (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cold startup | 453.968 | 292.370 | 157.520 | 5,296.5 | 844.2 |
| Unchanged restart | 67.657 | 66.550 | 0.020 | 4,384.6 | 844.2 |
| Saved importer comment | 102.670 | 100.860 | 0.220 | 4,758.0 | 859.6 |
| Header comment startup | 116.780 | 109.610 | 5.250 | 4,915.5 | 859.6 |

BT restored all 63 project payloads with zero analysis/source-profile events,
project parse/check/encoding, header preprocessing/parsing, or FFI conversion.
Its warm input validation took 16.934 seconds wall and 16.514 seconds CPU;
project hydration took 23.130 seconds wall and 23.037 seconds CPU. The complete
warm startup still took 67.657 seconds and 66.550 seconds of server CPU.

The saved edit parsed/checked only `titan.sqlite3`, reused four FFI conversions,
and performed no header preprocess/parse or FFI conversion work. It encoded
exactly one 16,468,554-byte payload in 0.918 seconds of encoding CPU. End-to-end
edit readiness was 102.670 seconds and 100.860 seconds of server CPU; the table
preserves that total cost instead of treating the avoided compiler work or
encoding time as the whole edit. The header change triggered one preprocess/
parse pass and four FFI conversions, with one replacement project payload.

BT passed all five indexed-query checks and database `quick_check`. No WAL, SHM
or journal sidecar existed at readiness/shutdown snapshots. The same single-run,
OS-page-cache, process-lifetime RSS and transient-sidecar limits as BV apply.
The complete raw evidence is retained in
`.build/cache-benchmarks/titan-final-20260907/summary.json`; the failed Titan
baseline remains separately labeled. Both representative runs satisfy the
requested work-elimination demonstration while retaining the measured readiness,
validation, hydration, memory and disk costs.

## Initial delivery acceptance evidence (7 September 2026)

Criterion wording follows the 22 checkboxes in the authoritative issue body
retrieved 2026-09-07. Evidence labels refer to the verified original results above.
That delivery completed in extension PR #55 and merged Titan PR #148, with local
and Linux hosted gates passing. The timestamp-trust contract and background
readiness requirements in the authorized follow-up supersede the corresponding
historical criteria below; their original wording is retained as dated evidence.

| # | Acceptance criterion | Evidence |
| --- | --- | --- |
| 1 | Introduce a narrow typed SQLite store used by the server for ordinary index and graph queries, with the same schema/API for workspace-file and `:memory:` modes. Qualify saved-table SQL with `main.` so later TEMP tables cannot shadow it. | V287: typed Store/Access, identical file/memory schema, qualified saved SQL and serialized connection lifecycle. |
| 2 | Replace the maintained by-file, by-symbol, definition, filename and summary indexes with indexed SQL queries; remove their obsolete maintenance/sorting implementations once parity is established. | V287: SQL feature queries replace maintained indexes; deduplication, deterministic ordering and indexed plans pass. BV confirms indexed searches on the actual database. |
| 3 | Move module identities, revisions, manifests, imports/reverse dependencies, observed inputs and diagnostics to relational storage while preserving missing-provider edges, folder membership, manifest-driven invalidation, failure recovery and stale-result rejection. | V287/O19: relational graph/metadata parity, missing providers, folder/failure recovery, manifest invalidation and stale tokens. Persistent revisions pass remove/recreate/empty-store reopen tests. |
| 4 | Materialize the hover and folding data needed by read queries, including inferred/declared/coerced types and source-private summaries; keep exact byte/UTF-16 span validation and deterministic result ordering. | V287/O19: stored rich hover/fold payloads preserve visibility and byte/UTF-16 validation; feature snapshots remain equal. |
| 5 | Preserve all existing definition/reference/hover/folding results and compiler-backed rename safety. Reference lookup must distinguish both declaration roles and must allow external symbols without a project definition. | V287/O19: definition/reference/hover/folding parity, both declaration roles and external references without definitions; compiler-backed rename regressions pass. |
| 6 | Make the watcher-driven indexing task the sole saved-index writer. Publish replacement rows and diagnostics transactionally; serialize complete transactions and logical reads on the initial shared connection. Query cancellation must not cancel writer cleanup. | V287: sole updater publication, complete-operation Store leases, transactional diagnostics/semantics and generation checks; cancellation and drained rollback/close tests pass. |
| 7 | Keep one database tied to each workspace tree, excluded from source discovery/watching and version control; validate root identity and recover to an in-memory store if file-backed storage is unavailable. | V287/O19/PKG226: physical-root database, root validation, discovery/watcher/VCS/package exclusion, reopen/corruption handling and identical memory fallback. |
| 8 | Run the existing graph/index/feature suites predominantly against `:memory:` and add real-file lifecycle/recovery tests, indexed-query/ingestion checks, representative performance measurements, and the complete native/extension/protocol/Codex/packaging gate. | V287/O19/PKG226 complete memory/file/index-plan and native/extension/protocol/Codex/packaging coverage. BV and BT both passed the full representative measurements and restoration checks. |
| 9 | Define a versioned relational schema for the project dependency graph and derived semantic facts, plus compiler-owned payload codecs for reusable checked-project snapshots and successful completed C FFI type/macro graphs. | V287/C3450/F89: server schema 2, API-6 compiler-owned project/header/conversion codecs and independently revisioned project payloads. |
| 10 | Key reusable project-module state by hashes of the exact saved source bytes, not by modification time; a content change with a preserved mtime must invalidate the affected module and importers. | V287/O19: exact source byte hashes invalidate preserved-size/mtime edits and normal importer dependencies. |
| 11 | Serialize C FFI graphs without losing shared aliases, cycles, macro token spelling/spacing sidecars, declaration provenance, or the information needed for compiler conversion and language-server publication checks. | C3450/F89: shared aliases/cycles/table keys/metatables, macro spelling/spacing sidecars, declaration provenance and conversion round trips. |
| 12 | Key each FFI graph by the complete ordered preprocessing context: compiler argv, language mode, flags and forced headers, authoritative include roots/predefined-macro digest, working directory, requested spelling, selected header, and relevant provider identity. | C3450/F89: complete ordered preprocessing/include/macro/cwd/header/provider keys and compatibility rejection. |
| 13 | Persist content hashes plus followed stat identities for every direct/transitive header and lstat/followed/readability identities for every observed include-search candidate. Revalidate that exact closure before loading a graph; mtime alone is never sufficient. | V287/O19/C3450: direct/transitive header bytes, lstat/followed/search/readability identities, missing candidates and closure revalidation before reuse. |
| 14 | After one successful reload/revalidation, reuse the in-memory FFI graph across compatible compiler roots and later edits to importing Titan modules without re-preprocessing or reparsing it. A changed byte, replacement/retarget, new shadowing candidate, configuration change, or compiler-context change must invalidate it. | O19/C3450/F89/BV: compatible header/FFI reuse across roots and importer edits; same-mtime bytes, shadowing, configuration and compiler changes invalidate. |
| 15 | Include the Titan semantic/library/ABI versions, compiler language-server API, C parser/FFI serialization schema, server cache schema, and target/compiler identity in compatibility checks. | V287/O19/C3450/F89: semantic/library/ABI/API/schema/target/provider identities and actual compiler-tree content hashes; native checksum callback keeps the binary format. |
| 16 | Preserve the V1 ownership boundary for Titan modules: cache complete annotated state only for project modules; external Titan source and binary modules retain dependency metadata only. C FFI graphs have a separate compiler-owned codec in the same workspace database; only successful completed results are eligible. | V287/C3450: project-only annotated payload ownership; full project-file allowlist for sparse mixed generic/private hydration; external Titan providers remain metadata. |
| 17 | Write cache updates atomically and recover from missing, truncated, corrupt, incompatible, or unrepresentable graph data by rebuilding without failing the language server. | V287/O19/C3450/F89: atomic publication and sparse pruning rollback; malformed, missing, truncated, corrupt, incompatible and unrepresentable payloads rebuild. |
| 18 | Verify unchanged Titan and C files by content hash/input identity before serving persisted semantic results, then continue to use the normal saved-file, external-input, and watcher invalidation paths. | V287/O19/BV: exact saved/header/search identities revalidated before hydration/publication; regular watcher, external-input and saved-edit paths remain active. |
| 19 | Add restart tests for an unchanged project, changed Titan/header bytes with unchanged mtime, include-search shadowing, configuration/compiler incompatibility, dependency invalidation, graph alias/cycle/sidecar round trips, and corrupt-cache recovery. | V287/O19/C3450/F89: all requested restart/content/configuration/compiler/cycle/alias/sidecar/corruption cases, including actual compiler bytes at identical size/mtime. |
| 20 | Add an edit regression proving that changing only an importing `.titan` file reuses the persisted/reloaded FFI graph, while changing its header or search closure rebuilds it. | O19/BV: importer-only edit reuses FFI state, encodes exactly the edited importer, and avoids header preprocess/parse/conversion; header/search changes rebuild. |
| 21 | Demonstrate that the first semantic request after restarting an unchanged representative project does not reparse or typecheck unchanged project modules and does not preprocess, parse, or convert unchanged FFI headers. | O19/BV/BT: first requests after unchanged restart perform zero project parse/check and zero header preprocess/parse/FFI conversion; BV restores all 62 projects and BT all 63, with no project encoding. |
| 22 | Benchmark restart and saved-edit readiness for both vscode-titan and the Titan repository, reporting disk-cache size, load/revalidation CPU/wall, avoided compiler/header work, and peak RSS. | BV and BT passed all four requested workloads with readiness, database/sidecars, phase CPU/wall, avoided work, query latency and peak RSS recorded. Raw evidence and the durable report preserve baseline failures and final measurement limits. |

## Startup follow-up verification and delivery

Focused gates passed: 72 Graph/Metadata/Service/Store tests, 76
Application/Loader/Bridge tests, the initial 18 cache tests, and 489 distinct
compiler tests. The 22-session native cache restart transcript passed after adding
a diagnostic for a malformed graph row pruned before its background read.
Independent server review found no actionable gaps in observation refreshes,
inventory validation, revision checks, lazy recovery, or task ownership.

Independent compiler review identified and verified three repairs: certify
initial header reads against observations taken before and after the read;
share the registry yield budget across many small entries; and protect malformed
FFI observation-overlay validation so it becomes a cache miss without mutating
checker state. Cancellation-object identity remains intact. The implementation
uses server schema 3 and compiler language-server API 1. The maintainer reset
the unreleased API to 1 and requires it to stay there until the first public
release. Both repositories' guidance and all active consumers record that rule.

The complete API-1 `xvfb-run -a make -j1 verify` passed: 302 native tests,
56 JavaScript tests, 12 Extension Host tests, the 22-session cache transcript,
native protocol/Codex checks, plugin validation, staged installation, linkage,
and self-contained VSIX inspection. The installed 61 compiler Lua files matched
the reviewed API-1 snapshot. The native image frozen for measurements has SHA-256
`7053065aa9bb73002968b47f8e8c6f3529fc9e17e1c798d41298421e77ede090`.
Raw integration evidence is `/tmp/vscode-startup-api1-verify-20260908.log` and
`/tmp/vscode-startup-api1-verify-20260908-cache/` (22 retained process logs).

The compiler passed 3,478 broad tests and 455 native stdlib tests. Titan
PR #153 contains the independently audited 21 owned paths at
`f628e0aa414e4e0ba2b2e57521a49b3d8458e0bf`. All three Linux lanes passed in
[run 34182203740](https://github.com/mascarenhas/titan/actions/runs/34182203740).
The exact-commit Codecov project and patch checks passed at 92.56% and 96.83%.
All 25 hosted compiler invocations had positive counts, totaling 3,349 passing
tests plus 129 stdlib Lua tests. Hosted native validation passed 454 cases and
skipped `json.tests.test_core_locale_independent_numbers` because the runner had
no alternate numeric locale; local native validation passed all 455 cases.
No macOS workflow was dispatched. The compiler PR remains open pending explicit
merge authorization.

Both new benchmark sequences passed, and an independent audit verified all
64 latency distributions, feature-result parity, zero unchanged content
reads/hashes, source/header byte and nanosecond-mtime restoration, prior cache
presence, absence of backup residue, and both retained databases' integrity,
table counts and five indexed query plans. The authorized editor-server pause
ended after cleanup, and its resumed process state was verified.

| Workspace | Cold ready (s) | Warm SQL ready (s) | Full hydration from launch (s) | Queries during hydration | Saved edit (s) | Header startup (s) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| vscode-titan | 53.392 | 1.550 | 17.992 | 291 | 5.938 | 32.637 |
| Titan | 401.665 | 5.540 | 37.286 | 886 | 21.906 | 66.549 |

The 8 September UTC section of `docs/sqlite-backend-benchmarks.md` records
resources, work counters, concurrent latency, restoration and comparison limits.
Evidence is retained in `.build/cache-benchmarks/vscode-titan-startup-20260908/`
and `.build/cache-benchmarks/titan-startup-20260908/`. Earlier readiness included
hydration; current SQL readiness precedes it, and measured hydration now includes
query traffic. Saved edits start after restoration. No claim of a uniform latency
improvement, hard responsiveness bound or eliminated graph memory is made.

The final VSIX was repackaged after the report review. The self-contained smoke
and artifact checks passed; an entry-by-entry comparison proves the final archive
differs from that inspected package only in the report's wording corrections.
All 226 entries are present and the native image is unchanged. Final VSIX SHA-256:
`202978350b6e4d32c120e23354c233e6032bf69fe756a778c161c4dddfdb3eab`.

Remaining delivery steps:

1. Update extension PR #55 and both descriptions with exact source, test and
   measurement evidence. Verify required Linux hosted checks and Codecov results.
2. Present the concrete compiler PR for maintainer review and explicit merge
   authorization. After the prerequisite reaches master, verify its live HEAD,
   pin that commit in extension CI, and pass CI on the final extension commit.
3. Update dependent issues and Project status from verified results. Leave the
   extension PR open; no extension merge or default-branch push is authorized.

Compiler/server ownership remains disjoint. Only the root owns shared extension
build staging and publication of this plan. Builds and source changes must finish
before the two benchmark sequences run without competing work.
