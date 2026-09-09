# Adapt the server to Titan's single FFI namespace

Owner: [vscode-titan #60](https://github.com/mascarenhas/vscode-titan/issues/60).
Compiler prerequisites:
[Titan #154](https://github.com/mascarenhas/titan/issues/154) for the combined
namespace and two-header model, and
[Titan #155](https://github.com/mascarenhas/titan/issues/155) for enum carrier
queries.

Branch: `codex/adapt-single-ffi`, based directly on server `origin/main` at
`fe30668a4d35435237fa6f319b631dbc20edd24c`. This change does not include the
schema documentation or profiling branches/PRs #57 and #59.

## Contract

- Keep the language-server API at `1`, saved-file semantics, project-only
  navigation, and the external compiler Lua/native server boundary.
- A foreign import is `foreign import "header.h"`. The compiler retains
  `Ast.TopLevelForeignImport` with `loc`, `headername`, and exact quoted-literal
  `_header_loc`; it has no local binding or identifier occurrence.
- The checked module owns `ast._ffi_namespace`, a
  `Checker.ForeignNamespace` descriptor with `name = "ffi"`,
  `_type = Type.CModule("ffi", ...)`, and `_builtin = true`. Source-written
  `ffi` roots resolve through `_decl` to that descriptor. Qualified type roots
  use the same descriptor through `_module_decl` and retain `_module_loc`.
- `ffi` is reserved as a binding root. Member names remain ordinary contextual
  selectors. Direct headers and explicit source-imported C context contribute
  to one module namespace. Titan source-private import visibility is unchanged.
- Retain source locations on written uses, not on the synthetic namespace.
  Builtin and C member occurrences may support hover/references but never
  fabricate a project definition or rename anchor. Namespace and member
  identities must not conflate different modules' combined C environments.
- Compiler-owned header/type descriptors remain opaque beyond the existing
  typed bridge boundary. External source ASTs must not enter retained project
  graphs through inherited FFI metadata.
- The compiler owns `ast._ffi_header` and its ordered dependency descriptors.
  Import-result metadata exposes `ffi_header_descriptor`; checked entries
  retain final `ffi_header` and temporary `checking_ffi_header`. Source import ASTs expose
  `_ffi_header_descriptor` and `_ffi_header`. The driver owns temporary bundle
  cleanup, including the existing foreign-function checking header.

## Implementation

1. Migrate all production bound C imports and uses in `compiler_io`,
   `project_loader`, `content_identity`, and `embedded_interfaces`. Migrate
   native test imports and generated Titan fixtures in bridge, concurrency,
   protocol, and workspace-cache tests. Recalculate exact source positions.
2. Normalize the synthetic namespace and nameless directives at the bridge;
   retain callable parameter metadata and `ffi` qualification in C hover.
   Preserve source-imported foreign function identities and the existing
   exclusion of C declarations from definition/rename targets. Accept `ffi`
   lexically for rename and let the existing compiler preflight distinguish
   permitted member declarations from reserved binding roots.
3. Add TextMate highlighting for builtin `ffi`, with token tests for value/type
   access, ordinary member spelling, comments, and strings.
4. Add focused real-compiler regressions for ordered combined headers,
   inherited FFI through explicit source imports, module-scoped identities,
   header invalidation, and graph export/hydration without external ASTs.
   Extend cancellation cleanup to cover both compiler-owned checking headers.
5. Align the strict SQLite artifact-kind registry with the final compiler
   kinds `c-header-v2` and `ffi-conversion-v2`. Compiler
   source inventory and codec identity reject incompatible persisted state.
   Update the API contract documentation and pin CI to the final compiler
   commit.

## Toolchain and validation

Root coordinates compiler readiness and owns compiler edits. Use the private
server installation at `/tmp/vscode-titan-single-ffi/.titan`, built with
`TITAN_REPO=/tmp/titan-single-ffi`, after both compiler work units are ready.
The separate compiler validation prefix is `/tmp/titan-single-ffi-prefix`.
Never mutate or rebuild the shared sibling checkout or its existing SDK.

Run focused JavaScript grammar tests while the compiler work proceeds. After
the private compiler/provider is ready, run native bridge/FFI tests with a
positive selected-test count, then protocol and workspace-cache integration
tests. Compile source only through the Makefile's generated source stages.

Complete `make -j1 verify TITAN_REPO=/tmp/titan-single-ffi`, including native,
JavaScript, Extension Host, protocol/Codex, packaging, SDK-free compiler-module
inspection, plugin validation, linkage, and staged installation checks. Review
the complete intended diff after validation. Keep ABI/package versions aligned
with the final compiler decision while retaining language-server API `1`.

The server's independent PR will pin the exact new compiler commit in
`.github/workflows/ci.yml`; that commit must be reachable before server CI
checks it out. The existing Linux Ubicloud workflow performs the full gate.
Compiler Linux validation precedes the authorized manual compiler macOS run;
root owns that dispatch. Do not add a server macOS workflow or stack this
server branch on the existing documentation/profiling PRs.

## Progress

- [x] Inspect current `main`, compiler boundary, fixtures, package staging, CI,
  and repository guidance.
- [x] Create the independent server branch and record this plan.
- [x] Record owning server issue #60 and compiler dependencies #154/#155.
- [x] Migrate source, bridge, grammar, and fixtures; add integration coverage.
- [x] Build the private current compiler/provider and run focused checks.
- [x] Complete full verification and independent review.
- [ ] Pin the final compiler commit, commit exact paths, and open the server PR.
- [ ] Record green Linux CI and update the board; leave PRs open for review.

Validation:

- Refreshed the isolated SDK from the final compiler implementation, then ran
  `TITAN_JOBS=4 xvfb-run -a make -j1 verify TITAN_REPO=/tmp/titan-single-ffi CC=/usr/bin/cc`:
  pass. The complete gate passed once without any test or gate retry. Log:
  `/tmp/vscode-titan-single-ffi-verify-final.log`.
- All 307 native server tests passed, including namespace identities, inherited
  project/external FFI graph restoration, header invalidation, generated-header
  cancellation, contextual `ffi` renames, and the revised registry cooperation
  fixture. Native protocol, workspace-cache restart, and Codex workspace smokes
  passed.
- All 57 JavaScript tests across 12 suites passed, including 8 grammar tests.
  All 12 VS Code 1.106.0 Extension Host tests passed.
- The Linux x64 VSIX contains 227 files and is 33,912,994 bytes. Its staged
  Lua/native module payload contains 189 files totaling 3,855,676 bytes.
  Package path: `/tmp/vscode-titan-single-ffi/.build/vsix/titan-linux-x64.vsix`.
  SHA-256: `78076e573a0074494989d0c4dc5f25339e3db99cd81ce611ae59ea4fbd46af07`.
- Package inventory and byte comparison, SDK-free compiler-module startup,
  native linkage, plugin validation, and staged executable/license installation
  passed. The executable requires GLIBC symbols no newer than 2.38; the two
  native Lua modules require at most 2.33 and 2.14.
- Before and after the gate, the installed `titan-compiler` tree contained the
  same 56 Lua files as the current compiler checkout and the installed
  `c-parser` tree contained the same 6 Lua files. Both inventories and every
  file's bytes matched, with no missing or extra files.
- Independent server and project-cache reviews found no unresolved actionable
  issue. The contextual member-rename finding was fixed, and the registry test
  now measures real declared-owner work. Focused compiler project-cache tests
  passed 14/14; final server `git diff --check` passed.

The delivery compiler pin is `30daba07f7c50480a25e46424c5837b8833be17e`. A final isolated native cold capture
against this compiler and the verified server reached READY in 309.319 seconds
with all 63 modules committed in one analysis, zero stale/failed analyses,
135 saved source files and zero diagnostics. Saved-file hover, definition,
references and folding passed; source/config/cache bytes and metadata were
preserved. The companion compiler plan records the baseline comparison and
measurement limits.
