# Multiple named union payload parts

## Scope and boundaries

Implement vscode-titan support for [Titan PR #169](https://github.com/mascarenhas/titan/pull/169)
based on `32ef5a3d6cd268b2b892b69d4ebed673488336d9`, with the reviewed
analysis-only fix `9d9022b3547ec194655da2e4a099c783153d58c5`, keeping language-server API 1.
The work lives on `codex/union-payload-parts`, stacked on PR #82's
`codex/unsaved-completion` at `3dd0ea7e3ca2e1dfd9186cc2862fd967a0307e0a`.

The maintainer authorized a compiler fix on 2026-09-18 after the analysis phase
blocker was reported. Titan work lives on `codex/analysis-only-typed-ast`, stacked
on PR #169 at `32ef5a3d`. Honor `analysis_only` by retaining the checked source
AST before runtime lowering, while preserving ordinary native compilation.
Run both repositories' gates and independent reviews, then open both stacked
PRs. Do not dispatch macOS CI; leave automated Linux CI to run.
Preserve executable-relative SDK discovery and saved-file semantic ownership.
Completion continues to use captured buffers and may offer provisional results.

Project 2 tracks two P1/L units, initially In progress:
- [#83](https://github.com/mascarenhas/vscode-titan/issues/83): compiler pin,
  metadata and semantic features, editor syntax, executable regressions and docs.
- [#84](https://github.com/mascarenhas/vscode-titan/issues/84): entire-server union
  audit and replacement of suitable variant-only record wrappers with named parts;
  depends on #83. Retain records with domain identity, methods or shared ownership.

## Implementation

1. Inspect PR #169's AST, type metadata and language guidance. Capture `parts`,
   `bindings` and `values` at the typed compiler boundary, preserving declaration
   identities, accurate spans, variant hover signatures and selective bindings.
2. Update TextMate highlighting and fixtures for multipart declarations, direct
   named construction, positional-prefix matching and named aliases. Exercise
   saved navigation/rename and unsaved completion against the native server.
3. Inventory all union record payloads. Refactor only wrappers whose meaning is
   owned by their variant; document retained records and update all call sites.
4. Update user documentation and development guidance with the new contract and
   its non-obvious alias/rename rules. Pin and install the complete new SDK.
5. Run focused regressions, shipping native builds and shards, protocol/Codex
   tests, JavaScript and Extension Host tests, incremental regressions, packaging,
   installed/extracted artifact checks and independent code/docs/skill reviews.
6. Commit exact reviewed paths, push and open a new PR targeting
   `codex/unsaved-completion`. Record its dependency on #82 and Titan #169; move
   tracking issues to In review and leave the PR open for maintainer review.

## Work log

- Established both PR heads and clean checkouts. The requested compiler commit
  includes the completion-provider inventory fix from `e7228090`.
- Created the stacked branch and tracking issues before implementation.
- Split work among independent compiler-boundary, editor/protocol and union-model
  audits. Root owns toolchain, pin, tracking, documentation and final validation.
- Started the complete SDK refresh from `/tmp/vscode-titan-union-parts-source`,
  initially created using read-only `git archive`. The subsequent authorized
  compiler fix was staged there for a complete SDK refresh.

## Implemented and reviewed

- The initial SDK used upstream `32ef5a3d`, whose Linux compiler, stdlib and
  sanitizer CI passed. The final SDK includes the authorized analysis-only fix;
  all 67 installed compiler Lua modules match the reviewed compiler branch
  byte-for-byte. No macOS CI was dispatched.
- The typed bridge traverses parts, bindings and values, gives parts identities
  qualified by their variant, and preserves a shorthand's two meanings in one
  saved occurrence. Workspace schema 6 rebuilds older publications.
- Removed eight variant-only wrapper records; retained eleven records with
  independent contracts. The complete baseline inventory and rationale live in
  `docs/union-payload-audit.md`. Adapted `wire` to reflection's direct array part.
- Editor highlighting, executable protocol cases, docs and development guidance
  cover multipart constructors, prefix/named patterns and shorthand rename.
- Independent cross-reviews covered editor/protocol changes, all refactor and
  reflection consumers, bridge traversal/provenance, semantic identity/rename,
  SQL/cache persistence, documentation and agent guidance. Fixed provider-path
  shadowing and a misleading skill placeholder; final reviews have no findings.
- The initial declared-signature fallback was superseded after the maintainer
  identified the incorrect phase boundary. Applied constructor types were
  already erased before PR #169; the authorized compiler fix now preserves
  them for analysis, and bridge/protocol regressions require specialization.

## Earlier validation checkpoint

- Complete SDK build passed; generated LuaRocks licensing inputs are present.
- Incremental build gate passed, including relocation/hostile-path execution,
  no-op preservation, invalidation, failed-link and missing-output recovery:
  `.build/incremental-check-5ilMxZ/summary.json`.
- JavaScript suite: 62/62; native test-launcher suite: 6/6.
- Focused refactor/reflection owners: 150/150. Semantic/index/cache and rename
  owners: 66/66. At this checkpoint, final bridge regressions and the complete
  shipping gate were still in progress. Final delivery validation is recorded
  below.

## Resumed: compiler analysis phase boundary

The final optimized server and native test aggregate built successfully. The
remaining shipping execution/integration/packaging gates and PR delivery were
paused while the compiler boundary was investigated. The maintainer has now
authorized the compiler branch and resumed the goal; both implementations,
validation, documentation, independent review and stacked PR delivery are active.

The maintainer is correct that module-signature metadata is separate from the
fresh typed AST returned for source analysis. The hover case concerned the
`moved` constructor selector in `Packet<|integer|>.moved { ... }`, not the declared
return type of a `create` function. The compiler initially has the applied type;
its current checking entry point erases that information before returning.

Verified call chain at Titan `32ef5a3d`:
- `compiler_bridge.titan` sets `analysis_only = true` for saved analysis and
  private completion, then invokes `driver.defaultloader`.
- `driver.lua:3529` (`check_source_module`) builds checker options without
  forwarding `context.analysis_only`.
- `checker/entry.lua:90` unconditionally calls `generic_lower_erased_core` after
  successful checking. This is not gated on a code-generation request.
- `checker/lowering.lua:1253` erases AST types and removes applied namespace
  argument annotations; declaration interfaces are preserved separately.

This coupling predates PR #169. The declaration-level hover fallback is accurate
for the current compiler, but does not repair this phase boundary. A proper
analysis path should retain its source-level checked AST and defer generic
runtime erasure to compilation, keeping declaration/interface preparation
separate. That requires compiler-side work unless another supported analysis
entry point exists. The maintainer has authorized this repair. Replace the declared-`T` fallback
with specialized constructor-term hover regression coverage against the corrected
analysis path. Update the compiler pin to the independently reviewed fix,
without changing API 1 or the generated-code ABI.

## Authorized compiler follow-up

- Forward `analysis_only` from the resolver to the checker and separate source
  analysis from runtime generic erasure. Preserve checked declarations, registry
  ownership, source manifests, completion and FFI include-plan behavior.
- Test specialized constructor terms, normal native lowering, imported/cached
  source and completion; run the complete Titan suite in a separate test SDK.
- Update compiler API documentation and completion skill, revalidate the
  extension against the fixed compiler, and independently review both patches.
- Open the compiler PR against `feature/union-payload-parts` after the extension
  work is wrapped and locally verified. Cross-link it with the extension PR.

- Compiler review retained the original native declaration-snapshot timing and
  added explicit analysis-AST mode ownership. Failed analysis entries retain
  their mode too, so later native reuse cannot silently drop diagnostics.
  Review includes retained dependency closures, not just direct cache entries.
- The bridge now uses checked applied constructor metadata and original case
  binders. Regression coverage includes concrete, generic and fixed-alias
  constructors, namespace type-argument references and saved LSP hover.

## Final validation and delivery

- Final compiler focused regressions: 308/308; isolated native bridge and
  concurrency regressions: 76/76. Both compiler code and bridge adaptation
  received independent review. All identified mode/cache findings were fixed
  and independently re-probed.
- Optimized shipping server and test executable built successfully. Both shipping
  native shards passed (175 + 221 = 396 tests). Saved protocol and unsaved
  completion transcripts passed, including specialized constructor hover.
- Full Titan gate passed: 144 runtime/build tests, 3,511 compiler tests across
  four isolated shards, and 460 native standard-library tests. The reviewed
  compiler commit is `9d9022b3547ec194655da2e4a099c783153d58c5`; CI now pins it.
- Cache-restart and Codex native transcripts, JavaScript (62/62), the native
  shard launcher (6/6), incremental regressions and Extension Host (12/12) passed.
  Incremental evidence: `.build/incremental-check-KfRUpJ/summary.json`.
- The initial `make verify` reached its final VSIX smoke check and caught a
  stale reflection-wrapper fixture. It now binds `reflect.Value`'s direct
  `is_lua_c_function` entry part and tests callback hover/navigation. Independent
  review approved the fix and found no remaining references to the 24 removed
  upstream wrappers. `make package inspect-vsix` then passed both extracted
  compiler-module and packaged-SDK header smokes. All shipping gate components
  passed; the initial failure remains recorded in its original log.
- Server dependency/export inspection, plugin validation and server-only install
  inspection passed. Both relevant skills pass their structural validators.
  Final independent reviews cover compiler, server, fixtures, docs and skills.
- Delivery targets remain `codex/unsaved-completion` (vscode-titan) and
  `feature/union-payload-parts` (Titan). Leave both PRs open, cross-link them,
  and move issues #83/#84 to In review. No macOS workflow dispatch is authorized.
