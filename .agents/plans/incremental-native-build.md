# Incremental native server and test builds

## Requested outcome

Update the existing `codex/titan-parser-overhaul` branch and PR #74 to Titan
PR #164 HEAD `d02ba196fc043cf2d9e66565d3a9e6b090560931`, verified with `gh`.
Use the new `--incremental` / `-c` interface to give the language server and its
native tests explicit Make object graphs and separate final links, following
Titan's standard-library build. Do not modify the actual sibling Titan checkout.

Work is tracked by [issue #75](https://github.com/mascarenhas/vscode-titan/issues/75)
in Project 2 (P1/L, In progress), dependent on #72 and Titan PR #164.

## Build contract

- Stage source outside `src`; retain current staged files and generated objects
  across invocations. No generated C/object/header output beside authored files.
- One object target per logical module; direct source imports and actual C header
  inputs must be Make prerequisites. Source, dependency, compiler, SDK/provider,
  flag/configuration and inventory changes must invalidate the appropriate work.
- Compile explicit roots with `-c --incremental`; use the same source-selection
  and native compilation policy in all phases. `-j1` inside object recipes lets
  Make own parallelism. Keep native payload and bootstrap/link-only flags at the
  final executable link.
- Production and test objects have separate staged graphs: `--test` affects
  source selection, support, flags and native binding modes. Do not assume those
  objects are interchangeable. Build shared test support before parallel test
  objects; regenerate/link the test runner only when required.
- Preserve static stdlib/native linking, exported Lua API, saved-file semantics,
  native runtime filters and the two execution shards.
- Prove no-op builds preserve outputs; prove leaf, importer, header/configuration
  and test-case changes rebuild the correct closure and remain runnable.

## Delivery

Update build documentation and agent guidance, run focused incremental-build
regressions plus the complete documented gate, independently review code and
prose, commit exact paths, and push this follow-up to the existing unmerged PR.
Verify the new pinned head and CI behavior. The separately authorized compiler
fix is described below; keep the sibling working checkout intact.

## Environment

The actual sibling checkout is clean at the pinned d02 head. Its contents were
copied to `.build/incremental-build/titan` for installing the updated compiler
into the ignored project-local `.titan`. Previous parser-overhaul evidence under
`.build/parser-overhaul` remains historical evidence for the former pin.

Owners: build/Make graph agent, independent compiler-contract/regression agent,
independent tracking/review agent, root for toolchain/docs/full verification/PR.

## Verification checkpoint: compiler reuse blocker

The Make graph, pin, documentation and guidance changes are prepared locally.
Independent code/documentation review passed after fixing orphan output cleanup,
focused syntax-error isolation, normalized paths and concurrent output ownership.
Nineteen real Make fixture scenarios pass. The shipping production graph linked
successfully, and its protocol, workspace-cache restart, Codex adapter and native
linkage checks pass. JavaScript and shard-runner tests also pass.

The full incremental native test graph is blocked at the pinned compiler: four
existing test objects require a `global` binding for the indirectly used
`titan.sqlite3` owner, but object reuse validates it against a different binding.
A minimal same-root reproduction confirms fresh compilation/runtime passes and
incremental reuse fails with identical settings. Evidence and reproduction live
under `.build/incremental-build/sqlite-binding-probe`; the complete graph failure
is retained in `shipping-build.log`.

Do not commit or publish this as verified. The user has been asked whether to
pause for a separate Titan fix or authorize separate compiler work. Until an
answer arrives, the explicit no-Titan-repository-changes boundary remains in
force. Finish the full shipping gate and exact-head CI after the blocker is
resolved. Historical parser-overhaul measurements remain unchanged and labeled
with their older compiler pin.

## Authorized stacked compiler follow-up

The maintainer authorized the compiler fix as a stacked PR. Work proceeds in
`.build/incremental-build/compiler-fix`, a separate worktree on
`codex/incremental-owner-binding-fix`, based on PR #164's branch
`codex/incremental-object-compilation-152` at d02. The sibling working checkout
stays intact. The narrow fix makes reused-object binding validation agree with
code generation's object-local imports, while preserving provider and
source/static/dynamic identity checks.

Add positive reuse and negative provider regressions, update the compiler's
language and implementation documentation, obtain independent code/documentation
review, measure validation overhead, and run compiler focused/broad gates.
Then pin vscode-titan to the fixed stacked compiler commit, complete its full
shipping gate, push both review branches, open the stacked Titan PR, and verify
Linux CI. Leave both PRs unmerged; do not dispatch macOS without authorization.

## Verified delivery checkpoint

The compiler fix is committed as `5e8194d282f9f3e98eec676b17064b43e1305d3d`
and published in [Titan PR #165](https://github.com/mascarenhas/titan/pull/165),
stacked on #164. Canonical `make -j4 test` passed 137 retained checks, 3,449
compiler/language tests and 456 native stdlib tests. Independent final code and
manual reviews passed. A quiet benchmark confirmed small absolute validation
cost; unchanged baseline-produced SQLite objects now replay without rewriting.

The vscode-titan workflow and build documentation pin that fixed commit. The
shipping server/test objects and executables built successfully. All documented
verification checks passed: 329 native tests, 60 JavaScript tests, five shard
launcher tests, 22 incremental-build scenarios, 12 Extension Host tests,
protocol/cache/Codex checks, VSIX/SDK/native-linkage/plugin inspection and staged
installation.

The first extension-host packaging precheck correctly rejected the temporary
Busted/coverage tools installed for upstream testing. Those 12 test-only rocks
were removed without changing any of 442 production SDK/binary files; the strict
inventory checks were preserved. Remaining artifact checks were rerun, including
the staged installer and extracted-VSIX protocol/SDK smoke tests. Evidence is
retained under `.build/incremental-build/`.

The earlier compiler blocker and its no-publish instruction are resolved by
these completed checks. Publish the vscode-titan follow-up to existing PR #74,
move issue #75 to In review, and verify exact-head Linux CI for both PRs. Leave
them unmerged; no manual macOS run is authorized.
