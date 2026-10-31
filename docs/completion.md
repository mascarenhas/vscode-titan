# Completion from editor buffers

Completion analyzes unsaved text. Once a completion request activates private
analysis, hover follows edits to the active module. Definition, references,
rename, folding and diagnostics still describe saved files.

The server enables completion at startup through
`Coordinator:configure_completion`. `initialize_result` in
`src/server/lifecycle.titan` then advertises full-document synchronization
(`change: 1`), `.` and `:` trigger characters and `labelDetailsSupport`.
The usual editor completion command also works in lexical, import-name,
qualified-type and foreign-type positions.

Candidates come from compiler lookup at the caret: lexical bindings, visible
module members, constructors and static functions, record and interface
fields, instance methods, C aggregate fields, and the actual `ffi` value
binding. Foreign types have their own C namespace, which local `ffi` shadowing
does not affect. Direct source imports keep their private Titan visibility. C
include inheritance follows its own compiler rules.

Declaration and module doc comments appear in completion extra information and
in hover; see [declaration documentation](documentation.md).

Edits replace the entire active name, including any suffix after the caret.
Foreign completions replace only the name leaf and keep pointer and qualifier
syntax. Multiword primitives insert their complete spelling. Comments and
unrelated string literals have no candidates. Unresolved receivers and
unrelated syntax errors can produce empty or incomplete lists. General recovery
from malformed source is out of scope.

## Callable presentation and insertion

`Compiler:completion_presentation` in `src/server/compiler_bridge.titan`
renders callables in value positions. The `label` and `filterText` stay the
bare name. `detail` carries the full signature with parameter names, generic
parameters and results. Clients that support `labelDetails` also see the
signature suffix next to the name.

For snippet-capable clients, the call snippet is
`choose(${1:first}, ${2:second})$0`, with the declaration's parameter names as
placeholders. Unnamed parameters use `arg1`, `arg2` and so on; the signature
does not invent names for them. The placeholders escape `\`, `$` and `}`.
Bound methods list only their explicit arguments. A zero-argument call inserts
`name()$0`. A function with only a variadic tail gets one empty tab stop.
Type positions, including type aliases, always insert plain names.
`completion_call_snippet` in `src/server/lsp_types.titan` drops the snippet
when arguments already follow the token. This covers positional, named,
generic, string and long-bracket arguments, also across comments, and it keeps
the whole-token replacement range.

`titan.completion.insertCallSnippets` defaults to `true`. Turn it off to insert
plain names when you take function or bound-method references. Standalone
clients send `initializationOptions.insertCallSnippets: false`. Clients without
snippet support always receive a plain identifier. The setting is the explicit
escape hatch because the compiler's completion context does not expose the
expected callable type at the hole. Signature display does not depend on the
insertion policy.

During private preparation, `Compiler:observe_completion_facts` wraps the
compiler's `titan-compiler.completion` `fact` observer while specialized type
and declaration metadata is still available. The wrapper reuses the
named-signature renderer and restores the original observer on every exit,
before the compiler permit is released. Saved compiler descriptors keep their
compiler-owned schema. Only TEMP candidates carry insertion presentation.

## Hover from recent completion

An accepted preparation also writes per-occurrence hover text for the captured
contributors of the active logical module. Hover reads these scalar TEMP rows
without rechecking source or decoding compiler descriptors. It maps positions
back from the disposable source and skips the synthetic hole itself.
Occurrences before and after the hole keep their original UTF-16 coordinates.

The first completion request activates continuing private analysis for the
most recently requested document and logical module. Buffer edits, including
an accepted call snippet, coalesce behind a 200 ms trailing debounce
(`HOVER_DEBOUNCE_MS` in `src/server/completion_service.titan`). Newer edits
cancel superseded preparation, and explicit completion requests take priority
over queued hover refreshes. A refresh checks the ordinary captured editor
bytes without the completion hole. The newly inserted callee and its arguments
therefore get occurrence facts without another completion request. Imports
still see one committed saved baseline.

A usable preparation atomically replaces the accepted hover snapshot. During
the debounce, compiler work or a malformed edit, the previous snapshot stays
available with its original version and saved-generation provenance. Hover
maps the current position back to that snapshot, and maps the occurrence range
forward to current UTF-16 coordinates. Each full-sync change contributes a
conservative common-prefix and common-suffix replacement. An occurrence is
omitted if any replacement touches it, or if its complete token bytes or
boundaries changed. At most 64 changes per contributor are mapped; a fresh
snapshot resets that history. Two separate edits in one full-sync change can
conservatively omit unchanged occurrences between them. Until replacement
facts arrive, an untouched occurrence may show the previous type or
documentation, but it is never relabeled as freshly checked. Provisional
completion candidates never authorize hover.

Hover requests capture exact current inputs before scheduling and reject
requests superseded during SQL reads. Closing and reopening a document, or
exceeding a contributor's buffer budget, retires its context. Reopening the
active path queues analysis for the new session, which cannot borrow old
occurrences. A save keeps the accepted hover while the watcher prepares saved
facts. The committed saved publication then queues reanalysis against the new
baseline.

Hover returns no result for dirty text before completion activates analysis,
and at an occurrence without a safe mapping. Clean text and closed documents
keep ordinary saved hover. Context that depends on unsaved-only C headers is
not kept for hover, because those headers have no saved watcher freshness.

Optional hover data is capped at 4 MiB and 100,000 occurrences
(`MAX_HOVER_BYTES` and `MAX_HOVER_ROWS` in `completion_types`). The cap lives
within the shared TEMP snapshot limits below. Separate retained hover tables
keep candidate replacement and saved-generation eviction from deleting
accepted hover during a handoff. The previous artifact survives one
replacement, so a reader queued behind publication can finish with its
captured snapshot id; the next publication retires it. A miss retries once
against an accepted context that changed while it waited for SQL. Fresh
candidates become ready after their usable hover artifact is accepted, which
covers immediate snippet selection. Exceeding a limit keeps valid completion
results and leaves the accepted hover artifact in place. Eviction can still
remove bounded retained artifacts. Process exit discards all TEMP rows.

## Input and publication ownership

`document_buffers` assigns a fresh session to each open document and accepts
increasing versions. The coordinator captures immutable inputs before it
creates a request Task. Every open selected contributor to the active folder
module takes part. Open inactive target variants add nothing and receive no
semantic completion. Other modules' editor text is ignored, so imports see one
committed saved baseline. A new file-backed path works when the configured
roots and the captured catalog prove an unambiguous host-selected module
identity (`completion_discovery`). Untitled, unmapped, inactive, ambiguous,
excluded and uncovered paths are deferred. Known saved ownership stays
authoritative.

The watcher publishes the `main.completion_*` configuration, exact provenance,
source and header inventories, scalar members and body-free compiler
descriptors in the same transaction as the saved semantic facts. Completion
never uses mutable graph work rows as a committed baseline. Warm startup keeps
the catalog without waiting for background compiler-manifest restoration.

`completion_service` owns disposable preparation, using captured source bytes,
private compiler entries and a private I/O provider. It decodes the captured
dependency closure. The shared compiler scheduler still serializes the Lua
global state. Persisted C cache reads are fenced by the saved generation, and
transient work cannot publish persistent compiler caches. Resolution is closed
over the captured source and provider inventory.

Selected static archives contribute their complete module inventory, including
siblings that saved source does not import. The bridge accumulates whole
provider captures across independent roots and fixed-point analysis. It
validates their observed file identities and releases pending captures after
publication. Recapturing an archive replaces its inventory as a unit
(`merge_completion_catalog`), so removed siblings disappear. Saved source names
and provider deselection keep stale binary entries from surviving. Embedded
inventories also survive a compatible warm restart.

An unrelated saved refresh keeps an untouched provider's committed catalog
while a clean project still reaches that provider. If all its importers fail
and no fresh capture is available, the old catalog is discarded: current file
observations alone cannot validate its previous bytes. Fresh captures still
work alongside unrelated source diagnostics. Completion results that are
already prepared stay available under the ordinary context and session rules.

Header and include-search identities are checked before and after private
analysis (`restat_c_header_dependencies`) and compared with the analysis's
actual observations. Newly introduced explicit headers are checked too. Until
saved indexing owns them, later requests schedule private header validation
before they treat the prepared result as fresh. Usable provisional candidates
stay available during that validation.

The compiler inserts a marked dummy identifier into a disposable copy of the
source, keeping the operator and surrounding foreign-type syntax. It finds the
exact span and captures scope and receiver facts before the expected dummy
lookup failure. Ordinary checking is unchanged. Persisted descriptors carry
their own format version, separate from language-server API `1`.

## TEMP storage and selection

Completion shares the workspace's single serialized SQLite connection; see
[workspace storage](sqlite-backend-storage.md#connection-ownership). Opening it
runs `PRAGMA temp_store=MEMORY` and verifies that it reads back `2` before any
TEMP object is created. Saved publications, TEMP publications and logical reads
each hold the connection lease for their complete operation.

Candidate publication inserts 11 rows of 17 bindings per statement. That stays
under Titan's 200-position variadic-call limit. A superseded TEMP publication
rolls back its whole transaction, including batches already inserted.
`main.completion_descriptors` is a rowid table, so its primary key has a
separate index. Child foreign-key checks then read only the narrow module key,
not the large descriptor payload. Keep large payloads out of parent-key
indexes.

TEMP owns open documents, input vectors, coverage, scopes, scalar candidates
and hover rows. Its cascading foreign keys stay within the TEMP schema.
Snapshots record the saved generation, buffer epoch, session and version, and
the exact caret context. Coverage stays explicit for empty or failed analyses,
so obsolete saved declarations cannot reappear under another prefix.

Fresh selection uses only qualified SELECTs over scalar columns. Under the same
lease it validates the generation and inputs, chooses the nearest available
compiler lookup keys, and applies a binary, case-sensitive prefix range
(`label COLLATE BINARY >= ? AND < ?`), so `_` is literal. The limit is 200
items. Truncation or partial knowledge sets `isIncomplete`.

Interactive completion favors useful suggestions while fresh analysis catches
up. During a buffer change, a saved-generation refresh or header validation,
it can reuse the last prepared candidates for the same document and open
session. It does so only when the source before the active token is unchanged.
This anchor keeps an unrelated receiver or lexical context from borrowing the
result. Provisional selection reads only the retained TEMP snapshot, never a
mix of old candidates and newer saved facts. It filters with the current
prefix and builds the whole-token edit range from the current UTF-16 text.
Every provisional list has `isIncomplete: true`, and its declarations and
types may be out of date. Fresh results still pass the strict generation,
input and context checks above.

Without a usable prepared result, `Service:answer` polls for preparation for
about 150 ms (15 sleeps of 10 ms), subject to cooperative scheduling. If none
is ready, it returns an incomplete list. It does not wait for workspace
restoration. Cancelling a request does not cancel the watcher or a TEMP
transaction. Changed inputs cancel stale private preparation. An independent
transaction owner completes or rolls back before shutdown drains it.

Saving never promotes TEMP facts: the watcher reindexes disk while the editor
keeps its version. Closing retires editor state, and reopening gets a new
session. A changed saved generation makes old snapshots ineligible for fresh
selection. Bounded retention can still serve provisional candidates until
replacement. Closed sessions cannot reuse them. Other database connections
cannot see TEMP content.

## Bounds and checks

| Bound | Value | Owner |
| --- | --- | --- |
| Editor text per document, per workspace, tracked documents | 4 MiB, 32 MiB, 256 | `document_buffers` |
| Derived snapshot size, total, count, candidates per snapshot | 16 MiB, 64 MiB, 16, 100,000 | `completion_store` |
| Captured saved baseline source, interfaces | 32 MiB, 64 MiB | `completion_store` |
| Detached descriptor preparation | 64 MiB | `completion_service` |

Oversized text keeps a version watermark and can recover on a bounded full
update. Exceeding the document count disables completion until the server
restarts, because forgetting a contributor could wrongly restore its saved
bytes. Exceeding a preparation limit leaves completion incomplete. Superseded
snapshots and closed editor rows are evicted. Retained provisional candidates
count against the same snapshot limits. These bounds cap owned data, not
process RSS.

Focused tests cover buffers, discovery, storage, service and protocol
(`*_test.titan` beside each module, and `make completion-protocol-test`).
Real-file storage tests check that main bytes are unchanged, that a second
connection is isolated, and that TEMP rows are lost on restart. They also check
rollback, stale identities, empty coverage and binary-prefix and shadowing
rules. Compiler tests own lexical and receiver semantics. For timing
measurements, see [completion timings](benchmarks.md#completion-timings).

## Design precedents

The design follows published language-server practice:

- [LSP 3.17 completion](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/language/completion.md)
  keeps `label` as the bare name and puts signatures in `labelDetails.detail`
  and `detail`. Advertised `snippetSupport` gates snippet syntax. An explicit
  whole-token `textEdit` with `filterText` avoids client word guessing.
- [LuaLS](https://luals.github.io/wiki/settings/#completionshowparams),
  [rust-analyzer](https://rust-analyzer.github.io/book/configuration#rust-analyzercompletioncallablesnippets)
  and [gopls](https://go.dev/gopls/settings#completeFunctionCalls) show
  signatures independently of insertion and offer a way to insert a function
  reference. A callable candidate alone does not prove that the user wants to
  call it.
- The [Haskell Language Server](https://github.com/haskell/haskell-language-server/blob/5327ae014b5fa7fce028f22c55499ddd9f0d2de7/ghcide/src/Development/IDE/Core/PositionMapping.hs)
  serves a retained, possibly stale result and maps positions conservatively
  through edits. Retained hover here works the same way.
- [clangd](https://clangd.llvm.org/design/threads) debounces rebuilds with an
  adaptive delay of 50 to 500 ms. The fixed 200 ms interval here is a tuning
  choice within that range. Adaptive timing can follow if measured preparation
  cost justifies it.
