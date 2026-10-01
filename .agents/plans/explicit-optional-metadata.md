# Normalized compiler metadata adoption

Status: implemented, independently reviewed, and locally verified

Owner: [issue #87](https://github.com/mascarenhas/vscode-titan/issues/87).
Dependencies: [Titan #182](https://github.com/mascarenhas/titan/issues/182) and
[Titan #183](https://github.com/mascarenhas/titan/issues/183).
Compiler plan: `../titan/.agents/plans/type-ast-optionals.md`.

Use branch `codex/explicit-optional-metadata`. Tighten the compiler bridge's
ordinary optional AST/type fields to nil-only and preserve genuine boolean
flags. Consume tagged Array qualifiers through compiler type rendering. Add
boundary rejection and fresh/cached qualifier regressions. Keep saved-file
navigation and captured unsaved completion ownership unchanged.

Include `titan-compiler/maybe3.lua` in staging requirements and package checks.
Refresh the existing `.titan` installation from the reviewed compiler branch,
pin its exact final commit in CI, and use existing compiler/server content
identity for cache invalidation. Do not bump API, extension, compiler, ABI,
or cache version numbers.

Run focused native bridge tests, independent review, and complete `make verify`
with shipping flags, including incremental-build and packaging gates. Commit
reviewed work, open this PR before the Titan PR, and leave both open. Monitor
Linux CI no more frequently than every ten minutes. macOS CI is waived.

Implementation and independent review are complete. The bridge rejects false
optional node/name/type/list metadata, including C-header dependencies, and
keeps genuine booleans. Fresh/restored Array qualifiers and malformed legacy
fields have focused regressions. Packaging requires the new helper; the server
data-flow contract documents normalization and unchanged cache version numbers.
The complete shipping-flags `make verify` gate passed after refreshing the
existing `.titan` installation: 407 native tests, protocol/completion/cache/Codex
integration, 67 extension unit tests, six shard-runner tests, 12 extension-host
tests, incremental builds, packaging, and artifact inspections. CI pins the
matching reviewed compiler commit. PR review and Linux CI are tracked in the
linked issue and pull requests.
