# Current Titan metadata compatibility

Owner: vscode-titan issue #45. Branch: `fix/current-titan-metadata`.

Use pristine Titan master `0ac5df1a7a99dddd014ba28f181d13d716a8479f`
from `/tmp/vscode-titan-compiler-y5yweR/titan`, installing it into this
repository's ignored `.titan` prefix. The active sibling compiler checkout
belongs to another agent and is read-only for this work.

## Scope and invariants

Restore compatibility with current serialized module metadata and the standard
library inventory, especially when the Titan stdlib itself is a saved-source
project. Keep the existing narrow Lua/Titan bridge, source/private visibility,
project-only AST retention, external metadata caching, and saved-file semantics.
Compiler changes are permitted only for demonstrated blockers, on a separate
branch in the temporary checkout; publish a compiler PR after local extension
verification and monitor Linux CI only.

## Work sequence

1. Reproduce current-master build and metadata/indexing failures. Compare the
   previous CI pin `7b74a0c827370c282de714637ba3883f1058d793` with master.
2. Repair each incompatibility at its owner, including the new `titan.reflect`
   metadata inventory entry, and add regression coverage for affected behavior.
3. Pin the verified pristine compiler revision in CI and document the current
   metadata contract where it changes.
4. Run focused native and generator tests, then the full `make verify` gate
   with the temporary compiler checkout selected through `TITAN_REPO`.
5. Index the temporary compiler's configured stdlib and native test sources,
   confirm ready semantic queries and unchanged-generation reuse, and record
   outcomes. Review the complete diff with an independent agent.
6. Commit exact paths, push the feature branch, open a vscode-titan PR, monitor
   Linux CI, and move issue #45 to In review. Leave the PR open.

## Evidence

- Initial extension worktree: clean `main` at `e2d0644`, matching remote main.
- Fresh compiler: `0ac5df1`; exact 18-module generator inventory predates the
  newly added `titan.reflect` module.
- Validation and delivery results will be recorded here after execution.

## Completed local validation

- Fresh compiler installed successfully; installed `types.lua` and `driver.lua`
  match the pristine clone. The clone remains clean at `0ac5df1`.
- The original generator rejects the new archive with `unexpected
  "titan.reflect"`; the updated generator and its self-test pass.
- Compiler API 4 and ABI 2 are unchanged. An independent audit found no bridge
  serialization API mismatch. Existing compiler-owned serialization and
  decoding remain authoritative; no compiler edits were necessary.
- All 221 native tests, 56 JavaScript tests, 12 extension-host tests, protocol
  transcripts, and Codex adapter smoke tests pass. The full documented
  `make verify` gate completed, including packaging, self-contained reflection
  smoke, native/VSIX inspection, plugin validation, and staged installation.
  The gate was resumed at the remaining stages after giving VS Code a writable
  temporary runtime directory and extracting the pinned LuaRocks license source
  into the fresh clone. Already passed test stages were not repeated.
- Native logs use a pipe because Titan's inherited stderr path requires a
  stream. Manual indexing uses `CCACHE_DISABLE=1`, matching the Make targets,
  because the ambient ccache directory is read-only in this sandbox.
- Pristine Titan's configured workspace indexed all 114 saved files (59 modules)
  in one initial epoch with zero diagnostic publications. Cold indexing took
  246,301.295 ms in the concurrent local verification run. Timer/uv and
  reflection definition queries and reflection/async hovers succeeded;
  unchanged requests emitted zero indexing notifications.
- Benchmark evidence: `/tmp/vscode-titan-compiler-y5yweR/stdlib-index.json`,
  SHA-256 `3752c8c6a93ac30b21b8439c83e3024ef84d76b90fa5ad23a9f6f6161ee20d99`.
- Local Linux x64 VSIX: 21,459,137 bytes, SHA-256
  `d525f4ef749d56bddf0b4ab03a66d33d81ea0ef61041322bc9f7663242818870`.
  Its server requires at most GLIBC 2.38; packaged Lua native modules require
  at most GLIBC 2.33. Artifact provenance is local, separate from CI builds.
- Independent full-diff review and `git diff --check` passed.

Publication and CI evidence belong in the PR and issue #45; leave the PR open
for maintainer review.
