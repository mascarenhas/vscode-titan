# Compact declared module retention

The maintainer requires the server to keep only top-level member/type manifests,
without function or method bodies. This supersedes the older complete-AST cache
guidance. Fresh checking and semantic extraction may use transient bodies; SQL
owns completed lexical occurrences, hovers, folds, saved source and diagnostics.

Tracking: vscode-titan #62 (SQL retention), #63 (integration and measurements),
vscode-titan #64 (shared header provenance), #65 (comparison hashes),
and titan #157 (restorable declared interfaces), #158 (extracted C definitions). The implementation starts from
server #61 and compiler #156 in isolated branches. Leave every PR open for review.

## Contract and sequence

1. Preserve the completed single-FFI baseline and recheck the findings in
   `docs/sqlite-backend-schema.md` at e0bff3b6 before drawing new comparisons.
2. The compiler exports/decodes a body-free allowlisted declared type graph,
   including public and trusted source surfaces, canonical nominal owners,
   generic binders, and the ordered `.ffi.h` plan. Native code generation uses
   fresh ASTs. Analysis-only restoration does not generate `.titan.h`.
3. The bridge normalizes only freshly checked modules, immediately compacts Lua
   entries, and restores clean entries without body normalization. SQL
   publication compares module revisions/states and retains unchanged facts.
4. Prepare changed facts and compact payloads outside the store lease; validate
   the complete graph revision tuple again, publish atomically, then release
   typed body snapshots. Retain rollback and stale-generation behavior.
5. Verify restored public/source/private/generic/foreign behavior, independent
   module SQL retention, deletion/recreation, same-generation failures,
   cancellation, diagnostics and fresh rename preflight. Run the full documented
   gate and packaging inspection with the isolated updated compiler installation.
6. Keep closed extracted C declaration schemas and the final FFI environment.
   Reconstruct derived literal traits from exact tokens, retain classified macro
   lookup facts, and omit unused parser histories and conversion memo tables.
   Keep mutable forced-input preprocessor contexts in memory only.
7. Share immutable header dependency values through ordered owner memberships;
   preserve observation differences, duplicates, empty owners, refresh isolation
   and transactional pruning. Keep reloadable external metadata separate from
   fixed-size equality hashes in graph_modules.
8. Measure cold creation, unchanged SQL readiness, restored saved edits, and
   header changes. Report logical bytes separately from allocated main/sidecar
   bytes and timings; preserve historical baseline labels. Update docs and PRs.

## Ownership

- Compiler implementation agent: compiler Lua, Busted regressions and compiler docs.
- SQL implementation agent: semantic_index, semantic_features and their tests.
- Root: bridge, loader, service/graph, application, integration tests, docs,
  toolchain, complete validation and delivery.
- C-cache agent: extracted C/FFI schemas, preprocessing cache boundary and tests;
  earlier read-only baseline database and logs under /tmp.

No macOS dispatch is authorized for this new work. The maintainer owns the
previous PR's macOS check and merged it successfully. The original Titan
checkout was updated to master at 5787bd4f with the maintainer's authorization.

## Validation record

- Compiler branch `codex/compact-module-manifests` is based directly on merged
  `5787bd4f`; commit `61a2996f` contains the complete compiler change. Rebasing
  from the previous PR head preserved the tested tree exactly.
- The complete local compiler gate passed 3,480 Busted tests and 455 native
  standard-library tests. All 64 installed compiler/C-parser Lua modules match
  that source tree. The retained-entry lifecycle regression proves discarded
  consumer bodies collect while fresh and restored provider manifests stay live.
- The complete server native suite passed 321 tests after the recovery fix. The cancellation fixtures
  now observe the analysis-only include header and pause at an invoked registry
  checkpoint; all eight focused concurrency cases pass as well.
- Protocol, persistent-cache restart and native Codex smokes passed, along with
  57 JavaScript tests and 12 Extension Host tests. Server inspection, plugin
  validation, staged installation, target-specific VSIX inspection and the
  self-contained packaged compiler smoke passed.
- After the recovery fix, the unmodified complete `make -j1 verify` command
  exited successfully. Final full-gate log:
  `/tmp/module-manifest-validation/server/verify-recovery.log`. The production
  compiler inventory contains exactly the intended 64 compiler/C-parser Lua
  files; compiler-gate-only test dependencies are absent from the package.
- The final executable's paired cold run completed: 365,678,592 database bytes versus
  1,004,789,760; READY 261.234 seconds versus 309.319; peak RSS 2,915,660 KiB
  versus 6,198,556. All 63 project payloads contain no Ast.* nodes. All four
  saved-file features and preservation checks passed. The storage document
  records the complete census and the changed include-search context.
- Compiler Linux CI run `34311501945` passed for exact commit `61a2996f`:
  all 3,935 tests, 166 sanitizer-selected executions plus production smokes,
  and Codecov checks (92.33% overall, 96.61% patch). macOS was skipped.
- Final review found that missing core semantic tables could retain unchanged
  failed-module publication records while losing their saved files and the
  ownership map for stale hovers/folds. A complete semantic rebuild on that
  recovery path is covered by focused regressions. Schema recreation is inside
  the publication transaction so rollback preserves the retry signal. All 76
  application/index/features/cache tests pass; independent re-review found no
  remaining issue. Logs: `/tmp/module-manifest-validation/recovery/all-tests.log`.
- The first restart benchmark completed cold analysis but stopped at an obsolete
  format-1 probe-path assertion. The merged compiler already uses format 2;
  the harness and current documentation now match it. That failed capture is
  retained under `/tmp/module-manifest-validation/warm-edit-header`, and its
  source/header/cache restoration checks passed.
- The final multi-process benchmark passed all unchanged/importer/header
  assertions and preserved source, header and prior cache. Cold READY was
  260.462 seconds; unchanged SQL READY 10.693 seconds; declaration restoration
  completed 4.009 seconds later; saved source edit 24.061 seconds; changed-header
  startup 31.707 seconds. Only `titan.sqlite3` rechecked in either mutation.
  The probe cache used 346 format-2 records; all later lookups hit. Evidence:
  `/tmp/module-manifest-validation/warm-edit-header-final/summary.json`.
- The maintainer will monitor both PRs after submission and report any failures.
  Compiler Linux CI has already passed; server PR CI is left to that handoff.
