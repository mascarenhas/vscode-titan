# Titan parser migration and language-server simplification

## Current delivery status

Implementation, documentation, independent reviews and the complete local gate
are complete. Live Titan PR #162 HEAD was verified with `gh` as
`3a06055f4d84e4ca3eb9f8a31fd32aa65d6e6bce`, matching this branch's CI pin and SDK.
The sibling Titan checkout is unchanged. The deliverable is an unmerged review PR from `codex/titan-parser-overhaul`;
all owned issues are open in Project 2, In review / P1:

- [#70 syntax/AST/cache protocol and highlighting](https://github.com/mascarenhas/vscode-titan/issues/70), size L;
- [#71 configuration, loader and probe-cache ownership](https://github.com/mascarenhas/vscode-titan/issues/71), size L;
- [#72 compiler installation cache and two native execution shards](https://github.com/mascarenhas/vscode-titan/issues/72), size M;
- [#73 performance, documentation and review evidence](https://github.com/mascarenhas/vscode-titan/issues/73), size M.

The complete `make verify` gate passed 329 native tests, 60 JavaScript tests,
five shard-runner tests and 12 Extension Host tests, plus every protocol,
workspace-cache, Codex, VSIX/SDK, native-linkage, plugin and staged-install check.
Evidence is retained in `.build/parser-overhaul/verify-r2.log`; current source
was compared byte-for-byte with the validated source stage before resuming.

The final [performance report](../../docs/parser-overhaul-performance.md) and
[compact data](../../docs/parser-overhaul-performance.json) separate ordinary
unchanged restarts from restored-database replay trials. Four post-reboot CPU-0
pairs and twelve clean replay trials passed strict reuse/diagnostic checks.
Current final cold/unchanged-restart times are 42.255/0.903 seconds for vscode-titan
and 243.814/4.765 seconds for Titan, using identical current source snapshots
for the pre/final comparison. Kernel/core placement and single-sample limits
are documented; no hosted cache-cycle observation is claimed yet.

Independent reviews covered server code, CI/shard control flow, configuration
and cleanup invariants, current documentation, and the numerical performance
evidence. All findings were resolved and rechecked. The following historical
work log records intermediate failures and the user-requested restart pause.

## Goal and boundaries

Use Titan PR #162 HEAD as vscode-titan's pinned compiler. The local candidate is
`3a06055f4d84e4ca3eb9f8a31fd32aa65d6e6bce`; verify live with gh before delivery.
Change only vscode-titan. Build the compiler from an isolated copy and benchmark
isolated source snapshots; do not modify the sibling Titan repository.

1. Migrate authored Titan source, embedded fixtures, tests and syntax consumers.
2. Repair typed compiler bridge and semantic indexing for new AST/type metadata.
3. Record cold-process and warm-process analysis timings for both source trees,
   including diagnostics, cache work and measurement limits. Retain pre-refactor
   and final comparable evidence; preserve a pre-migration executable/toolchain.
4. After migration and initial measurements, perform a multi-agent architecture
   review and simplify the broader server. Compiler configuration provenance
   (source/include/binary paths and flags) is a priority example, not a scope
   limit. Remove duplication, unclear ownership, wrappers and indirection while
   retaining saved-file semantics, cache correctness and runtime boundaries.
5. Separate compiler setup in CI and cache its completed installation by compiler
   commit. Compile server tests once and run two execution shards concurrently
   on the two-CPU runner. Preserve the complete documented local verification.
6. Update user/developer documentation and agent guidance. Run independent code
   and documentation reviews, resolve findings, complete validation and open an
   unmerged review PR on `codex/titan-parser-overhaul`.

## Work units and acceptance criteria

- Syntax/compiler adaptation: all source/fixtures compile with the pinned Titan;
  focused and complete semantic/protocol tests pass, including new AST cases.
- Architecture simplification (depends on adaptation and initial measurements):
  review current server ownership/data flow, implement justified simplifications,
  keep explicit config ordering/provenance and invalidation covered by tests.
- CI acceleration (independent): exact compiler cache identity; cache hit avoids
  reinstall; all tests belong to exactly one of two parallel execution shards;
  failures propagate; local verify still includes all gates.
- Performance/docs/delivery (depends on the above): record comparable cold/warm
  evidence for both corpora, independent code/docs reviews, complete verification
  and PR. Create/update matching GitHub Project 2 issues once gh access works.

## Session evidence

- Starting vscode-titan main: `35b8a99edb0c5e4da1f10b32a95bc43de68634a2`, clean.
- Starting Titan branch: `codex/grammar-parser-simplification`, clean at candidate.
- Preserved original executable/toolchain/source at `.build/parser-overhaul/baseline`.
- Isolated compiler build copy: `/tmp/vscode-titan-parser-compiler`.
- GitHub CLI credential lookup currently stalls; tracking/live pin pending.

## Progress: initial migration

- Installed the exact local PR branch compiler from the isolated copy into `.titan`;
  installed parser byte-matches the sibling checkout. API stays at 1.
- Syntax and typed-AST migration applied; new foreign/current-module regression added.
  Grammar and fixture checks passed. First native server build succeeded.
- Initial runtime validation exposed a migration-script error: SQL `<>` became
  `<||>` in project graph queries. Repair and audit all string literals before
  accepting migrated performance results. The failed trace is retained.
- Pre-migration baselines completed on isolated snapshots, with no diagnostics and
  unchanged warm reuse: vscode-titan 46.105 s cold / 1.268 s warm; Titan 237.734 s
  cold / 7.654 s warm. These initial samples overlapped build work; report that
  limit or repeat under an idle controlled run before claiming small regressions.
- Three independent architecture inspections agree on repeated config/discovery,
  duplicate service/compiler loaders, repeated project-module conversions, and
  per-node allocation of the lexical AST child inventory. Refactor after valid
  migrated cold/warm evidence, retaining the deliberate post-watch rescan and
  existing cancellation/publication ownership.
- CI cache/visible phases and two execution shards implemented; launcher behavior
  tests passed. Native shard timing/coverage awaits the migrated aggregate.
- Live gh lookup and Project issue publication remain pending locked login keyring;
  user was asked asynchronously to unlock it. No GitHub connector fallback is used.

## User steering: probe-cache ownership

Make the language server default its C probe-cache root to the directory that
contains its SQLite database. Remove the extension's VS Code workspace-storage
probe-prefix override and let it use that server-owned location. Document the
resulting explicit override/default precedence and validate workspace isolation,
standalone launch and extension launch. Syntax highlighting is explicitly in
scope (its grammar, bracket/indent configuration and tests were already migrated).

## Progress: integration corrected, broader refactor started

- Saved-file native protocol transcripts pass after all foreign-type fixtures
  were updated. TextMate, brackets/indentation and their tests are migrated.
- The migrated cold/warm run reached semantic readiness with stable results
  (48.061 s / 1.595 s), but correctly FAILED its warm zero-header-read assertion.
  Cause: compiler cache protocols advanced to c-header-v5/ffi-conversion-v6;
  server's v3 allowlist silently discarded them. Formats and runtime protocol
  drift regression now fixed; strict benchmark assertions remain unchanged.
- A corrected pre-refactor source snapshot and separate executable build live
  under `.build/parser-overhaul/pre-refactor-*`. This freezes comparison input
  while the authorized broader refactor progresses independently.
- Refactor ownership: bridge owns one explicit typed compiler configuration,
  accepted immutable snapshot, driver scope/context derivation, shared AST child
  inventory and duplicate sorting removal; service/loader owns one normalized
  startup configuration/discovery, one production compiler composition, simpler
  constructors, record-owned copies/conversions and preserved structured errors.
- New cache default design: before compiler modules load, default TITAN_PREFIX
  to the shared SQLite directory helper; preserve explicit nonempty overrides.
  Remove extension storage override. No compiler-repository changes.
- Independent documentation review found/led to corrections for shadowable ffi,
  startup-only benchmark omissions and historical hydration wording. Final code
  and documentation reviews will inspect the completed refactor and evidence.

## Independent review and initial full gate

- Completed code review by the agent that owned CI (independent of server
  implementation) found no blocking issues in the frozen refactor. It checked
  accepted config/snapshot isolation, scheduler-scoped globals, cleanup,
  publication ownership, probe-prefix precedence and cache protocol versions.
- Independent documentation review corrected workspace-folder wording,
  Application-owned restoration/semantic publication versus Service graph
  commits, actual snapshot-conversion callers, exclude/watch semantics, and
  clearing an explicitly overridden probe prefix. Current data flow is in
  `docs/server-data-flow.md`.
- Corrected pre-refactor timings pass every assertion: vscode-titan 43.763 s
  cold / 0.985 s warm; Titan 260.536 s cold / 5.071 s warm.
- First full gate in `.build/parser-overhaul/validation` ran 329 native tests:
  327 passed. One existing config test caught an Error.path change (the bad
  semicolon root was still rejected); its diagnostic now names the prospective
  titan-config.lua again and focused native config tests pass 6/6. One old
  concurrency observer was updated to expect B's flags inside B's resolver,
  while retaining exact original-table restoration checks after return.
  Both fixes received independent follow-up review. Rebuild is in progress;
  no failed run is counted as a completed gate.

## Paused at the user's request before restarting

The user explicitly requested a pause to restart and unlock the login keyring.
Do not resume work until the user returns and asks to continue.

- Complete local gate PASSED (`verify-r2.log`): 329 native, 60 JS, 5 shard-runner,
  12 extension-host tests, all protocol/cache/Codex/VSIX/SDK/plugin/install checks.
- Independent code, CI and documentation reviews completed; findings resolved.
- Final normal-affinity cold/warm runs passed for both corpora. CPU-0 matched
  runs passed for pre/final vscode-titan (45.029/1.015 s and 45.797/0.992 s) and
  pre-refactor Titan (272.042/5.789 s). The matched final Titan run was interrupted
  for this pause. Its summary records `completed=false`, all restoration flags
  true; the process group was verified empty.
- All code changes remain on `codex/titan-parser-overhaul`, uncommitted. No
  GitHub issues/PR were published, and the live PR pin still needs gh verification.
- Precise state, evidence locations, pending commands and resume caveats are in
  `.build/parser-overhaul/session-state.json`. Prepared warm-repeat and report
  scripts are in that same directory. Do not reuse failed output directories.
- `/tmp/vscode-titan-parser-compiler` may disappear on reboot. The Titan benchmark
  config references its SQLite include root. Verify or reconstruct input
  provenance before reusing caches; changed header identities require a fresh
  matched Titan pair. Durable review copies are in `.build/parser-overhaul/reviews`.
- The actual sibling Titan checkout remained clean and unchanged throughout.

## Resumed after restart

The user explicitly resumed. `gh pr view 162 --repo mascarenhas/titan` now
works and verifies that the live head remains
`3a06055f4d84e4ca3eb9f8a31fd32aa65d6e6bce`. The real Titan checkout is clean at
that commit. Current source files and the fixed final image were checked
against the successful full-validation stage before continuing.

The temporary compiler copy vanished on restart. Remaining matched Titan runs
will use the original tracked workspace configuration and the complete installed
SDK, including its SQLite header, avoiding the vanished temporary include root.
Old/interrupted evidence is retained. GitHub issue/Project tracking and benchmark
completion are delegated independently; the root owns final report/review and PR.
