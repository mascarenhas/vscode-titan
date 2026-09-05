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

## Initial local validation

- Fresh compiler installed successfully; installed `types.lua` and `driver.lua`
  matched the pristine clone, which was clean at `0ac5df1` during this run.
- The original generator rejects the new archive with `unexpected
  "titan.reflect"`; the updated generator and its self-test pass.
- Compiler API 4 and ABI 2 are unchanged. An independent audit found no bridge
  serialization API mismatch. Existing compiler-owned serialization and
  decoding remain authoritative. The later SDK-free package failure below
  demonstrated a separate compiler blocker.
- All 221 native tests, 56 JavaScript tests, 12 extension-host tests, protocol
  transcripts, and Codex adapter smoke tests pass. The full documented
  `make verify` gate completed, including packaging, the initial reflection
  smoke (later found to inherit ambient headers), native/VSIX inspection,
  plugin validation, and staged installation.
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

## CI-discovered compiler blocker

- PR #46 commit `1f4e301` passed all native, JavaScript, and extension-host
  tests in Linux run `33990472201`, then failed the self-contained packaged
  reflection smoke because no authoritative C target profile was available.
- The original local package pass was masked by inherited `C_INCLUDE_PATH`
  exposing an unrelated Titan SDK. Clearing the ambient C include paths
  reproduces the CI failure with a fresh package extraction and cache.
- Reflection exports portable C integer callback metadata. The compiler must
  normalize that metadata before publication, but API 4 requires `lua.h` even
  for pure type decisions. Skipping normalization would weaken ordinary C
  argument, return, and conversion checking.
- Implement API 5 in the isolated compiler branch
  `fix/embedded-interface-c-profile`, with a validated declarative build target
  profile on the analysis-only embedded provider. The compiler owns profile
  reconstruction and numeric normalization. Actual native probes still require
  a configured SDK/toolchain and matching target identity. No SDK payload is
  added to the VSIX and no compiler globals are injected by the bridge.
- The extension generator records the build profile alongside the exact
  19-module metadata inventory; API expectations and documentation advance to
  5. The package smoke clears ambient include paths and selects an unavailable
  C compiler, while testing reflected callback C-int-to-Titan-integer typing.
- Repeat focused and full local verification and pristine stdlib indexing with
  ambient C include paths cleared. Publish the compiler prerequisite PR only
  after the extension is locally wrapped, pin the verified compiler commit,
  and leave both PRs open with Linux CI evidence. Never dispatch macOS CI.

## API 5 extension verification

- Refreshed the production `.titan` prefix from the isolated compiler branch.
  Generator validation normalizes every archive entry against the exported
  build profile, and its native data translation unit compiles with warnings
  treated as errors.
- A complete uninterrupted `make verify` passed with ambient C include
  variables cleared: 222 native tests, 56 JavaScript tests, 12 extension-host
  tests, protocol/Codex smoke, packaging, native/VSIX inspection, plugin
  validation, and staged installation. The extracted VSIX smoke selects an
  unavailable C compiler and exercises reflection imports and C callback
  result conversion.
- The configured stdlib workspace again indexed 114 saved files across
  59 modules with zero diagnostics. Timer/uv and reflection definitions and
  reflection/async hovers succeeded; unchanged queries caused no indexing.
  This concurrent local run took 236,789.951 ms with 156,410 ms child CPU.
- Benchmark evidence: `/tmp/vscode-titan-compiler-y5yweR/profile-stdlib-index.json`,
  SHA-256 `b5509408d701db728f41a9eb790321d34934bf6b3fc111caecb8f1a874a47baf`.
- Verified local Linux x64 VSIX: 21,463,493 bytes, SHA-256
  `f26453b114f65402f257ec0112f0b333545efa7cb2cb10568903a8d3ff576027`.
- Titan master advanced to `b72f5e4` with SQLite during this work. This
  compatibility fix retains the original `0ac5df1` snapshot plus the
  isolated API 5 prerequisite, preserving the verified 19-module inventory.

- The compiler prerequisite is committed as
  `f8e4c4d7e89f8584af6ed1583e9a296aa9c53476`; CI now pins that exact revision.
  Its complete fresh-prefix `make test` passed 128 retained checks, 3,286
  compiler tests, and 241 native stdlib tests. Both working trees passed
  independent review and diff checks before their final commits.
