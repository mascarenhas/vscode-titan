# Workspace storage: compact declarations

This updates the storage breakdown in the [earlier schema research](https://github.com/mascarenhas/vscode-titan/blob/e0bff3b6f46725880b5c8a9b7633eff82643c8a4/docs/sqlite-backend-schema.md#storage-and-serialization-research-workflow). It records the preserved, completed single-FFI baseline and the measured compact-manifest implementation below. The historical schema document remains a record of its older compiler and multi-step workload.

## Complete database allocation

The closed database contains **1,004,789,760 bytes** (1.005 GB decimal; 958.24 MiB). `dbstat` accounts for every page: 245,310 pages of 4,096 bytes, zero freelist pages, and no remaining WAL, shared-memory or rollback-journal sidecars. Allocations below include each table and its indexes; do not add index totals again.

| Owner | Allocated bytes | Percent of database |
| --- | ---: | ---: |
| `project_snapshots` | 424,140,800 | 42.21% |
| `header_graphs` | 234,012,672 | 23.29% |
| `ffi_conversion_snapshots` | 214,360,064 | 21.33% |
| `cached_header_inputs` | 51,646,464 | 5.14% |
| `semantic_occurrences` | 30,896,128 | 3.07% |
| `header_inputs` | 16,523,264 | 1.64% |
| `graph_modules` | 16,281,600 | 1.62% |
| `semantic_hovers` | 12,337,152 | 1.23% |
| `project_sources` | 1,576,960 | 0.16% |
| `semantic_files` | 1,454,080 | 0.14% |
| `semantic_summaries` | 712,704 | 0.07% |
| `semantic_folds` | 688,128 | 0.07% |
| All smaller tables, indexes and schema pages | 159,744 | 0.02% |
| **Total** | **1,004,789,760** | **100%** |

All indexes total **21,557,248 bytes**, already included above. Free space within allocated pages and B-tree overhead are also included; neither explains the large logical payloads.

## Compiler payloads

| Payload family | Rows | Logical payload bytes |
| --- | ---: | ---: |
| `project_snapshots` | 63 | 423,654,931 |
| `header_graphs` | 61 | 233,675,722 |
| `ffi_conversion_snapshots` | 60 | 214,040,564 |

Project graphs occupy 42.16% of the entire file as logical payload. Header and FFI payloads contribute another **447,716,286 bytes**. Removing project bodies alone therefore leaves a substantial C-definition storage problem.

The baseline `cdriver` cache already excludes whole preprocessed header text and its complete origin map. Its `ffi_types` root is an extracted C-type graph, but reachable declaration/parser annotations, integer-literal details, active macro definitions, token sidecars and provenance remain. The converted FFI cache additionally retains raw-type-keyed conversion maps and namespace/history metadata. “Extracted definitions” must be a closed, restorable contract rather than an unrestricted traversal from an extracted type table.

## Header and FFI payload census

Every one of the 61 header and 60 FFI payloads was scanned as literal graph-v1 records, with checksum and exact byte reconciliation. No Lua source was evaluated and no live compiler objects were restored.

| Encoded component | Headers | FFI conversions |
| --- | ---: | ---: |
| String contents | 95,711,204 | 87,554,094 |
| String tag/length framing | 56,227,950 | 48,606,350 |
| Table references | 19,640,495 | 18,142,025 |
| External references | 0 | 12,756,710 |
| Integers | 40,443,615 | 29,891,601 |
| Nil/boolean values | 8,026,941 | 6,502,504 |
| Node/entry counts | 13,622,772 | 10,584,580 |
| Envelopes | 2,745 | 2,700 |

Headers contain **3,405,632 table nodes**; FFI conversions contain **2,646,085**. Strings including framing consume **151,939,154 bytes** of header payload and **136,160,444 bytes** of FFI payload. Header-input node records alone occupy **16,834,672 bytes** inside the header graphs. These node and string classifications overlap and must not be added.

There are **94,642,576 repeated raw string bytes** across the header family and **85,207,939** across the FFI family beyond one copy of each distinct spelling. Even within individual payloads, repetition totals 84,012,013 and 80,470,629 bytes respectively. These are duplication diagnostics, not predicted savings from dictionaries, deduplication or compression. Required definitions and ownership must be settled first.

## Relational provenance and comparison manifests

`cached_header_inputs` has **183,029 rows** and allocates **51,646,464 bytes**. Its scalar BLOB/TEXT data includes:

- 16,924,152 bytes of repeated artifact keys;
- 10,294,104 bytes of paths;
- 12,752,939 bytes of input identities;
- 2,567,575 bytes of artifact-kind names;
- 797,396 bytes of physical observation identities.

`header_inputs` adds **92,376 rows** and **16,523,264 allocated bytes**, including 5,189,506 path bytes and 6,430,668 identity bytes. Across both tables there are only **3,368 distinct `(kind,path,identity)` triples**, using 189,508 path bytes and 236,184 identity bytes once each. Repeated memberships and ordered inputs are necessary; repeated scalar spellings are not inherently necessary. Any normalization must preserve observation differences, include-search order, refresh behavior and transaction ownership.

`graph_modules` stores **259,038 public-manifest bytes** and **15,899,719 source-manifest bytes**. The column names `public_digest` and `source_digest` are misleading here: they contain complete comparison representations. The project invalidation path should be checked for equality-only consumers before replacing these strings with fixed-size hashes; restorable declared interfaces remain separately owned by project payloads.

## Semantic facts and saved source

There are 66,666 occurrence rows and 66,666 hover rows. Occurrences allocate 30,896,128 bytes, including 16,138,240 bytes of indexes. Hovers allocate 12,337,152 bytes, including 4,972,544 bytes of indexes. These are already extracted query facts; they do not require compiler bodies to remain resident.

The updater and completed SQL view each keep 135 saved files totaling **1,316,898 source bytes** per copy. The two copies serve different publication ownership. They account for only 3,031,040 allocated bytes combined. Folds and summaries together allocate 1,400,832 bytes; diagnostic tables are empty in this successful cold capture.

## Timing and measurement boundaries

Cold launch to READY took **309.318945203 seconds**. Project graph export reported **30.730684 seconds of process CPU** for 63 entries and exactly 423,654,931 encoded bytes. This span includes the export loop and any other server task CPU during its yields; it is not an exclusive codec or wall-time measurement. Compiler analysis reported 230.783226 inclusive CPU seconds. Peak RSS was 6,198,556 KiB.

The capture does not isolate header/FFI serialization, exclusive checker time, SQL binding/writes/commit, cumulative bytes written or peak sidecars. New measurements must distinguish those from logical payload sizes and compare the same workload. The historical document’s 918,376,448-byte retained database followed additional source/header edits and used older code; the difference is not an isolated optimization effect.

## Evidence and current work

The baseline database SHA-256 is `f28a585df422807e73f35b59093cd237710bd2acc50cdfb2b2de98968dfebbbe`. Inspection used Python SQLite 3.51.2 with `mode=ro` and `query_only=ON`, verified absent sidecars, and checked the unchanged database hash before and after. Numeric columns cast to BLOB for column-length inspection describe decimal display lengths, not SQLite integer storage; page allocation is the physical accounting authority.

Local reproducible evidence is under `/tmp/module-manifest-baseline/`: `measurement.json`, `remaining-storage.json`, `inspect_baseline.py` and `profile_remaining.py`. The retained capture is `/tmp/titan-single-ffi-validation/cold-native-final/run/`. These are measurement artifacts, not checked-in fixtures.

Tracked implementation: [SQL module-fact reuse](https://github.com/mascarenhas/vscode-titan/issues/62), [body-free project retention](https://github.com/mascarenhas/vscode-titan/issues/63), [shared header provenance](https://github.com/mascarenhas/vscode-titan/issues/64), [comparison hashes](https://github.com/mascarenhas/vscode-titan/issues/65), [compiler declared manifests](https://github.com/mascarenhas/titan/issues/157), and [extracted C definitions](https://github.com/mascarenhas/titan/issues/158).

## Compact storage contract

Schema 4 separates the data used by each consumer:

- Project payloads contain detached declared member/type schemas, including public and trusted source visibility, generic binders, nominal owners and the ordered foreign-header plan. Function and method bodies exist during fresh checking and semantic extraction only. Committed SQL publication releases those transient snapshots.
- Semantic publication records each module's checked revision and state. Unchanged modules keep their occurrences, hovers, summaries, folds and saved files; changed, failed and removed modules replace their own rows in the same transaction. Cross-module declaration identity checks include both retained and new facts.
- `c-header-v5` retains extracted C declarations with exact array/bitfield expressions, recursive type relationships, the final name/tag environment, required target facts and classified macro lookups. Derived literal traits are reconstructed from exact token leaves. `ffi-conversion-v6` retains the final converted namespace and the reachable C types/layouts it needs, without raw conversion memo tables or old namespace histories.
- Mutable preprocessor contexts for forced `-include`/`-imacros` inputs stay in memory. A fresh process preprocesses them again before validating extracted-definition cache entries; a persisted compiler cache cannot restore their complete token/output context.
- `header_dependencies` owns immutable complete dependency values, including optional physical observations. `header_owners` identifies module, external, header-cache and FFI-cache owners once each. Ordered `header_inputs` memberships preserve duplicate entries and empty owners. Refresh updates only the selected owner's links; unused values are pruned with publication.
- `graph_modules.public_digest` and `source_digest` contain 32-byte SHA-256 comparison hashes. Reloadable compiler/external interfaces remain in their separate payload or metadata owner.

Missing provenance ownership makes a compiler artifact a cache miss. Valid empty ownership remains reusable. Compiler envelope checks and cache/ABI versions continue to govern opaque payload compatibility; the relational store does not reinterpret the compiler graph.

## Measured compact implementation: 9 September 2026

The final compact run uses compiler `61a2996f` and the complete server
implementation, including missing-table recovery and transactional schema
recreation, after both complete local gates passed.
The same 168 tracked Titan source files and workspace configuration produced
135 analyzed files and 63 modules. Both captures used fresh workspace and probe
caches and the same observer/harness: each recorded 346 physical compiler
queries, 138 enum selections and 60 combined C dispatches. All four saved-file
feature checks passed, with no diagnostics, dirty/failed/stale modules or
unpublished staging rows.

| Measurement | Single-FFI baseline | Compact declarations | Reduction |
| --- | ---: | ---: | ---: |
| Closed SQLite file | 1,004,789,760 B | 365,678,592 B | 63.61% |
| Project payloads, logical | 423,654,931 B | 74,113,417 B | 82.51% |
| Header payloads, logical | 233,675,722 B | 134,692,828 B | 42.36% |
| FFI payloads, logical | 214,040,564 B | 93,957,109 B | 56.10% |
| Relational header provenance, allocated | 68,173,824 B | 9,932,800 B | 85.43% |
| Graph comparison columns, logical | 16,158,757 B | 4,032 B | 99.98% |
| Launch to READY | 309.319 s | 261.234 s | 15.55% |
| Project export, inclusive process CPU | 30.731 s | 4.808 s | 84.36% |
| Peak server RSS | 6,198,556 KiB | 2,915,660 KiB | 52.96% |

The export span still includes projection and other server CPU during yields;
it is not an exclusive codec measurement. Total compiler-analysis CPU changed
from 230.783 to 211.790 seconds. Header/FFI serialization, SQL writes and
commit still lack exclusive timing. These are single paired observations of
the complete change, not isolated per-change or statistically stable speedups.
Worktree/SDK paths, generated headers, provenance and OS cache state differ.
In particular, the normalized capture retains 316,513 header memberships and
3,772 complete dependency values across 184 owners, versus 275,405 memberships
and 3,368 distinct values in the baseline. There are no orphan values or
noncontiguous owner sequences. Read-only comparison accounts for the difference with 404 additional missing
header candidates under two include roots. No old candidate path disappears,
and each module preserves the order of retained dependencies. All 305 loaded
header paths match after worktree/SDK prefix normalization; 304 content hashes
match, while the rebuilt SDK's `luaconf.h` differs. The compiler derives the
search roots from `cc -E -v`. The final capture records
`C_INCLUDE_PATH=/home/mascarenhas/.local/titan/include:/home/mascarenhas/.local/include`,
which supplies exactly those two roots. Baseline `C_INCLUDE_PATH` was not
recorded, so its difference cannot be attributed to a specific earlier setting.
The missing candidate files do not establish that their parent include
directories were absent. These are explicit comparison limitations.

### Complete allocation after compaction

Every byte is accounted for by 89,277 pages of 4,096 bytes, with no freelist
pages or remaining sidecars. Index allocation is 29,675,520 bytes, included in
each owner below. Larger semantic indexes and the membership lookup index are
included in the measured result.

| Owner | Allocated bytes | Percent of database |
| --- | ---: | ---: |
| `header_graphs` | 134,938,624 | 36.90% |
| `ffi_conversion_snapshots` | 94,171,136 | 25.75% |
| `project_snapshots` | 74,301,440 | 20.32% |
| `semantic_occurrences` | 34,213,888 | 9.36% |
| `semantic_hovers` | 13,271,040 | 3.63% |
| `header_inputs` | 8,646,656 | 2.36% |
| `project_sources` | 1,576,960 | 0.43% |
| `semantic_files` | 1,458,176 | 0.40% |
| `header_dependencies` | 1,245,184 | 0.34% |
| `semantic_summaries` | 897,024 | 0.25% |
| `semantic_folds` | 745,472 | 0.20% |
| `header_owners` | 40,960 | 0.01% |
| All smaller tables, indexes and schema pages | 172,032 | 0.05% |
| **Total** | **365,678,592** | **100%** |

### What remains in the payloads

A literal graph-v1 census checks every checksum and reconciles all encoded
bytes. The 63 project payloads contain 325,204 table nodes and **no `Ast.*`
nodes**. Their largest remaining string fields are the restorable source
interface (18,222,000 bytes), input identities (16,343,861) and paths
(14,073,134). Header-input node records account for 44,460,307 encoded bytes
inside project payloads. These categories overlap; do not add them. SQL
normalization shares relational values, while opaque compiler artifacts still
carry their own validated dependency plans and restorable interfaces.

The 61 extracted-header payloads have 2,024,924 nodes; the 60 final FFI
payloads have 851,891. Their string contents and framing use 95,312,712 and
72,402,712 bytes respectively. Those strings include necessary declarations,
names, exact expression tokens and cache provenance. Compaction removes bodies
and obsolete compiler state, but is not a string dictionary or a compression
format. Repetition remains measurable without implying that every repeated
byte can be removed independently.

Both saved-source owners still contain the identical 135 files and 1,316,898
bytes each. The completed SQL query facts remain available without restoring
compiler bodies.

The compact database SHA-256 is
`29175dd40972564dbce670885be4bc12c38db6cc116e5307b961655d5f857d64`.
The capture, input identities, raw logs and feature results are in
`/tmp/module-manifest-validation/cold-native-final/run/`; the complete table/column
census, graph accounting, comparison and read-only reproduction command are in
`/tmp/module-manifest-validation/cold-native-final/storage/measurement.json`,
`measurement.md` and `cold-comparison.json`. Inspection and measurement verified
the original sources, SDK Lua executable, server, existing caches and historical
evidence were preserved. Installed compiler-module identity was checked before
launch.


The final executable SHA-256 is
`c77211228bd6da537c4d854add5abccefacc4a3122fdd5cc55b1e209d7d63eda`.
Its authored-source inventory (68 files, including server sources and build
configuration) has SHA-256
`2c13c5a5f0c18c25576acf724d998f64d43c88aa72a2e0290b4aaa53a8eb2952`.
The source inventory and executable were preserved through the run. The preliminary successful
capture remains under `/tmp/module-manifest-validation/cold-native/`; its
266.012-second READY and 2.650-second export span are not substituted for the
final-image measurements above.

The final [restart and edit benchmark](sqlite-backend-benchmarks.md#compact-declarations-9-september-2026)
also passed unchanged reuse, one-module source checking, changed-header
invalidation and feature equivalence. Its separate fresh-cache workload and
after-edit database are reported independently.
