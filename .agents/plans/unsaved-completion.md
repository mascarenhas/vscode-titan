# Unsaved completion delivery

Scope authority: [issue #50](https://github.com/mascarenhas/vscode-titan/issues/50),
17 September 2026 revision. Implement the complete coverage and lifecycle contract,
then run local full validation and independent review before opening review PRs.

## Branches and ownership

- vscode-titan: `codex/unsaved-completion`, based on `96d32ec2`.
- Titan: `codex/completion-context`, based on master `0c89b2bc`. The current
  compiler lacks the required pre-lookup context hooks, so this is a demonstrated
  compiler prerequisite. The prior relocatable-tree branch remains intact.
- Leave PRs open; no merge or direct main/master push. Do not run macOS CI.

## Tracked slices

1. #76: compiler context, dummy transform and structured candidates.
2. #77: full-sync buffers, request capture and workspace routing.
3. #78: coherent saved descriptors and private module analysis.
4. #79: memory TEMP publication and SELECT-only queries.
5. #80: endpoint, member matrix and save/close semantics.
6. #81: performance/memory evidence, docs/skills, packaging and review.

## Design commitments

The watcher alone writes saved facts and persistent caches. Capture descriptor
payloads, source contents, provenance, headers and structured facts with the
committed semantic generation. Existing features query `main` explicitly.
Completion considers all open contributors of the requested logical module;
other modules use one captured saved revision. No promotion happens on save.

Full-sync notifications update session/version/text in order. Capture immutable
buffer inputs and caret at routing time, before asynchronous request work.
A private compiler/IO/entry graph prepares the marked dummy context under the
shared compiler permit. It must not wait for shared graph restoration. Bound
interactive waiting and return an incomplete current-text result when not ready.
The user's later steering prioritizes lively suggestions over immediate semantic
freshness. While buffers, saved generations or headers refresh, retain usable
prepared compiler candidates for the same document/session and unchanged source
before the active token. Filter with the current prefix and compute replacement
edits from current unsaved text. Mark every provisional list incomplete; the
compiler remains the source of semantic candidates. A fresh result still requires
the exact generation, input vector and context checks.
Only preparation decodes detached compiler descriptors; SQL requests never do.

Configure `temp_store=MEMORY` and verify readback before TEMP DDL. The existing
Store lease covers each complete read or transaction. Validate the saved
revision and captured buffer identity inside publication and read leases, and
again before returning edits. TEMP coverage masks whole logical modules,
including empty/error results. Provisional selection uses retained TEMP facts
only and never joins newer saved facts. Bound retained snapshots and evict closed
sessions; superseded data cannot qualify as fresh.
Cancellation must not interrupt publication rollback or cancel the watcher.

Resolve candidates through compiler lookup, including actual ffi/M binding,
lexical domains/order, visibility, aliases, generic specialization, static versus
instance access, C aggregates/macros, and foreign name leaves. Keep `.`/`:` and
qualifiers in the disposable analysis text. Replace the whole identifier token;
produce edits in original unsaved UTF-16 coordinates. General parser recovery,
untitled documents, and cross-module dirty semantics remain deferred as in #50.

## Validation

Run meaningful native tests for transformations, compiler semantics, storage,
serialization, lifecycle and private analysis. Add protocol and Extension Host
coverage. Deterministically pause restoration with permit available and held;
assert useful detached preparation, query isolation, fresh-result stale rejection
and bounded fallback. Exercise provisional typing with current prefixes and edit
ranges, incomplete results, session/context guards and eventual fresh replacement.
Measure preparation and query separately; record real-file main
immutability, TEMP disappearance and bounded memory. Run incremental build gate
for the compiler pin, full `make verify`, compiler-owned full validation, and
independent code plus documentation reviews. Resolve findings, inspect exact
staged paths, commit/push and open both PRs after local work is complete.

## Progress

Implementation, documentation and agent guidance are complete and independently
reviewed. The user clarified that completion should remain lively during
reanalysis: previous prepared candidates may be served as incomplete results,
with a current token/edit and matching document session/context. Fresh
publication and selection retain exact input checks.

The compiler prerequisite is committed as
`5c0cefb48c513956f6463674d8d3346390033ae9`; CI pins that exact revision. Its full
local gate passed: 144 retained runtime/packaging, 3,478 compiler and 456 native
standard-library tests. A fresh production SDK was built from the same authored
tree; copied-tree Lua/compiler/native-runtime loading passed.

All `make verify` gates passed on the final shipping O3/Linux LTO build, run in
test and packaging phases: 383 native tests, completion and saved protocol,
cache restart, Codex adapter, 60 extension units, six launcher tests, incremental
build checks, all 12 Extension Host cases, native inspection, plugin validation,
installation checks and both extracted-VSIX compiler/SDK smokes.

Schema 5 keeps large descriptor payloads outside the foreign-key parent index;
candidate inserts are batched. Independent review and regressions cover partial
batch rollback, a 2 MiB descriptor, non-null keys and schema 4-to-5 recreation.
The packaged SDK smoke passes with its original deadlines. Release timings and
memory observations in `docs/completion-performance.md` were independently
checked against raw samples and the final executable identity.

All local acceptance criteria and independent reviews are complete. The branches
are ready for final commit/push and review PRs, which must remain open. No macOS
CI has been dispatched.
