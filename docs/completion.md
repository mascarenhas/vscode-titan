# Completion from editor buffers

Completion analyzes unsaved text. Definition, references, hover, rename, folding
and diagnostics still describe saved files. The extension synchronizes complete
file contents and advertises `.` and `:` triggers. The usual editor completion
command also works in lexical, import-name, qualified-type and foreign-type
positions.

Candidates come from compiler lookup at the caret: lexical bindings, visible
module members, constructors and static functions, record/interface fields,
instance methods, C aggregate fields, and the actual `ffi` value binding.
Foreign types have their own C namespace, unaffected by local `ffi` shadowing.
Direct source imports retain their private Titan visibility; C include
inheritance follows its separate compiler rules.

Edits replace the entire active name, including its suffix after the caret.
Foreign completions replace the name leaf, preserving pointer/qualifier syntax;
multiword primitives insert the complete spelling. Comments and unrelated string
literals have no candidates. Unresolved receivers and unrelated syntax errors
can produce empty, incomplete lists. General malformed-source recovery is
outside this feature.

## Input and publication ownership

`document_buffers` assigns a fresh session to each open and accepts increasing
versions. The coordinator captures immutable inputs before creating a request
Task. All open contributors to the active folder module participate. Other
modules' editor text is ignored: imports see one committed saved baseline.
New file-backed paths work when configured roots and the captured catalog prove
an unambiguous module identity. Untitled, unmapped and ambiguous providers are
deferred. New excluded/uncovered paths are deferred; known saved ownership stays
authoritative.

The watcher publishes `main.completion_*` configuration, exact provenance,
source/header inventories, scalar members and body-free compiler descriptors
with saved semantic facts in one transaction. Completion never uses mutable
graph work rows as a committed baseline. Warm startup retains the catalog
without waiting for background compiler-manifest restoration.

`completion_service` owns disposable preparation using captured source bytes,
private compiler entries and a private I/O provider. It decodes the captured
dependency closure. The shared scheduler still serializes Lua global state.
Persisted C cache reads are fenced by the saved generation; transient work
cannot publish persistent compiler caches. Resolution is closed over the
captured source/provider inventory.

Selected static archives contribute their complete module inventory, including
siblings not imported by saved source. The server accumulates whole provider
captures across independent roots and fixed-point analysis, validates their
observed file identities, and releases pending captures after publication.
Recapturing an archive replaces its inventory, so removed siblings disappear.
Saved source names and provider deselection prevent stale binary entries from
surviving; embedded inventories also survive a compatible warm restart.

An unrelated saved refresh retains an untouched provider's committed catalog
while a clean project still reaches it. If all its importers fail and no fresh
provider capture is available, that old catalog is discarded because current
file observations alone cannot validate its previous bytes. Fresh captures can
still be used with unrelated source diagnostics, and already prepared provisional
completion remains available under the ordinary context/session rules.

Known header and include-search identities are checked before and after private
analysis and compared with its actual observations. Newly introduced explicit
headers are checked too; until saved indexing owns them, later requests schedule
private header validation before treating the prepared result as fresh. Usable
provisional candidates remain available during that validation. C descriptor formats
`c-header-v6` and `ffi-conversion-v7` retain target-aware enum evidence as well as
the existing type and macro environments.

The compiler inserts a marked dummy identifier into a disposable copy, retaining
the operator and surrounding foreign type syntax. It identifies the exact span
and captures scope/receiver facts before the expected dummy lookup failure.
Ordinary checking is unchanged. The prerelease API stays at `1`; persisted
descriptors carry a separate format version.

## TEMP storage and selection

One serialized SQLite connection serves each workspace. Opening it executes
`PRAGMA temp_store=MEMORY` and separately verifies integer `2` before creating
TEMP objects. Saved publications, TEMP publications and logical reads hold the
connection lease for their complete operation.

Candidate publication uses bounded multirow inserts under that same lease. Each
batch stays within Titan's variadic binding limit; superseded TEMP publication
rolls back the complete transaction, including any already inserted batches.
The saved descriptor table keeps its large payload outside the primary-key index,
so child foreign-key checks read only the narrow module key. Workspace cache
schema 5 rebuilds earlier caches with this layout.

TEMP owns open documents, input vectors, coverage, scopes and scalar candidates,
with cascading foreign keys confined to that schema. Snapshots identify saved
generation, buffer epoch, session/version and exact caret context. Coverage
remains explicit for empty/error analyses, so obsolete saved declarations cannot
reappear under another prefix.

Fresh selection uses only qualified SELECTs and scalar columns. Under the same lease
it validates the generation/inputs, chooses nearest available compiler lookup
keys, then applies a binary case-sensitive prefix and 200-item limit. `_` is
literal. Truncation or partial knowledge sets `isIncomplete`.

Interactive completion favors useful suggestions while fresh analysis catches up.
During a buffer change, saved-generation refresh or header validation, it can
reuse the last prepared compiler candidates for the same document and open
session when the source before the active token is unchanged. This source anchor
keeps an unrelated receiver or lexical context from borrowing that result.
Provisional selection reads only the retained TEMP snapshot, never a mixture of
old candidates and newer saved facts. It filters with the current prefix and
builds the whole-token edit range from the current unsaved UTF-16 text. Every
provisional list has `isIncomplete: true`, even when all retained candidates fit;
declarations and types may be temporarily out of date. Fresh results still pass
the strict generation, input and context checks above.

Without a usable prepared result, a request waits roughly 150 ms for preparation,
subject to cooperative scheduling, then returns an incomplete list if unavailable.
It does not await workspace hydration. Request cancellation does not cancel the
watcher or a TEMP transaction. Changed inputs cancel stale private preparation;
an independent transaction owner completes or rolls back before shutdown drains it.

Saving never promotes TEMP facts. The watcher reindexes disk while the editor
retains its version. Closing retires editor state; reopening gets another session.
A changed saved generation makes old snapshots ineligible for fresh selection;
bounded retention can still serve provisional candidates until replacement.
Closed sessions cannot reuse them. Other database connections cannot see TEMP
content, and process exit discards it.

## Bounds and checks

Buffers allow 4 MiB per document, 32 MiB per workspace and 256 tracked documents.
Oversized text retains a version watermark and can recover on a bounded full
update. Exceeding the document count disables completion until server restart:
forgetting a contributor could incorrectly restore its saved bytes.
Derived snapshots allow 16 MiB each, 64 MiB total, 16 snapshots and 100,000
candidates each. A captured saved baseline allows 32 MiB of source text and
64 MiB of interfaces; detached descriptor preparation is capped at 64 MiB.
Exceeding a preparation limit leaves completion incomplete. Superseded snapshots
and closed editor rows are evicted. Retaining provisional candidates uses these
same snapshot limits.

Focused tests cover buffers, discovery, storage, service and protocol. Real-file
storage tests check unchanged main bytes, second-connection isolation, restart
loss, rollback, stale identities, empty coverage and binary-prefix/shadowing
rules. Compiler tests own lexical and receiver semantics. `make verify` also
checks the extension host, packaged compiler inventory and native installation.
See [the delivery measurements](completion-performance.md) for release-build
request/phase timings, RSS observations and their limits.
