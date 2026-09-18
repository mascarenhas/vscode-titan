# Server union payload audit

This audit accompanies [issue #84](https://github.com/mascarenhas/vscode-titan/issues/84)
and the named payload parts introduced by
[Titan PR #169](https://github.com/mascarenhas/titan/pull/169). The inventory was
taken across all production `.titan` files under `src/` at `3dd0ea7`, against
the language contract at Titan `32ef5a3d`. Titan fixture source strings inside
tests are language examples, not additional server data models.

The baseline contained 29 union declarations. Twelve directly carried records, with
19 distinct record types among their payloads. The refactor removes eight
records that only packaged a variant's fields and retains eleven with a
separate typed API, reusable data shape, behavior, or shared lifetime.

A named variant is not itself a type. Replacing a record therefore makes sense
when consumers need the union and its selected parts; it does not automatically
improve an API that also accepts or returns the record independently. Union
parts also do not replace mutable record fields or preserve a separate record's
identity. Existing collection copying and asynchronous ownership remain intact.

## Complete record-payload inventory

Names in the payload column are the original records, including records removed
by this change. A repeated record is counted once in the nineteen-type total.

| Union and variants | Original record payloads | Decision and reason |
| --- | --- | --- |
| `application.RefreshOutcome`: `ready`, `failure` | `View`, `application.Error` | Retain both. `View` is the immutable published feature snapshot, reused in `completed_view`, publication, and query APIs. `Error` also crosses raised-error normalization and `(result?, Error?)` returns and is retained as the current refresh failure. |
| `compiler_bridge.Adjustment`: all six variants | `AdjustmentInfo` | Retain. The common typed result of `adjustment_info` exists before classification and supplies the shared source/target projection after classification. All six tags use the same four-field domain shape. Flattening would duplicate that representation and complicate its common conversion path. |
| `compiler_bridge.Provenance`: `project_source`, `external_source`, `dynamic_binary`, `static_binary` | `SourceProvenance`, `BinaryProvenance` | Remove both. They have no independent consumer, methods, mutation, or identity requirement. Source variants directly carry `main_file` and `source_files`; binary variants carry `provider_file`. |
| `dispatcher.SemanticOutcome`: `failure` | `SemanticError` | Remove. Only packages the error `code` and `message` for an outcome; callers immediately match those fields. |
| `dispatcher.Route`: `immediate`, `shutdown`, `semantic`, `completion` | `DispatchResult`, `SemanticRequest`, `CompletionRequest` | Retain all three. Response construction and the synchronous dispatcher return `DispatchResult`; coordinator publication consumes it. Semantic handlers accept `SemanticRequest`, and completion capture accepts `CompletionRequest` independently of routing. Flattening would require rebuilding the same API records or widening those contracts to a route union. |
| `lifecycle.Decision`: `failure` | `lifecycle.Error` | Remove. Used only to carry `code` and `message` from lifecycle validation into dispatcher serialization; it is not raised or independently returned. |
| `lsp_types.DocumentNotification`: `opened`, `changed`, `closed`, `saved` | `OpenDocument`, `ChangeDocument`, `TextDocument` | Retain all three. `parse_open` and `parse_change` expose precise typed parser results, while `parse_document`, position parsing, and buffer replacement share `TextDocument`. Returning the broader notification union from those parsers would discard their precise result contracts. |
| `project_discovery.SourceResolution`: `found` | `PhysicalSource` | Remove. This private record travels only from the resolver through `found` to one match. Its comparison helper needs only the kind and ordered files. The variant directly carries `kind`, `main_file`, and `files`. |
| `project_graph.CommitResult`: `accepted` | `CommitAccepted` | Remove. Contains only the invalidated module-name array, which now belongs directly to `accepted(invalidated: {string})`. |
| `project_metadata.ExternalOrigin`: `source`, `dynamic_binary`, `static_binary` | `ExternalSource`, `ExternalBinary` | Remove both, including the forwarding type aliases in `project_service`. Only origin variants use these wrappers. Keep the owning `ExternalModule` and `ExternalFingerprint` records and the existing source-array copy boundary. |
| `project_watcher.BackendEvent`: `failed` | `WatchFailure` | Retain. Failures leave the backend-event union as entries in `RediscoveryBatch.failures`; polling errors construct the same type directly, and application logging consumes it. Flattening would allocate the record again when producing the batch. |
| `protocol.InputEvent`: `message` | `InputDelivery` | Retain. The reader and coordinator share this mutable owner. Its `wait` and `acknowledge` methods manage acknowledgement, the waiting task, and the resume token. Separate copied variant parts would not preserve that synchronization contract. |

`Route.document`, `Route.cancel`, and `diagnostics.Kind.compiler` contain other
unions rather than hidden record wrappers. Their nested unions are accounted
for separately above or below.

The remaining seventeen unions contain only scalars, other unions, or unit
variants and need no record-payload refactor:

- `application.WatchDisposition`;
- `compiler_bridge.DiagnosticKind`, `HoverSummaryKind`, `NodeKind`,
  `OccurrenceRole`, `DeclarationVisibility`, and `CHeaderDependencyKind`;
- `diagnostics.Kind` and `dispatcher.RequestId`;
- `indexing_status.State` and `lifecycle.Phase`;
- `project_discovery.ModuleKind` and `IssueKind`;
- `project_graph.Provenance` and `ImportVisibility`;
- `project_service.ProjectAnalysisState` and `project_watcher.PathChange`.

PR #169 support adds a thirtieth production union,
`semantic_index.SharedCaseName`. Its scalar-only alternatives distinguish a
case binder from a payload-part name when both share one source token; it adds
no record payload.

## Bounded implementation and verification groups

1. **Lifecycle and semantic failures.** Change `Decision.failure` and
   `SemanticOutcome.failure` to named `code`/`message` parts. Update lifecycle,
   dispatcher, coordinator, and application constructors/matches. Existing
   lifecycle and dispatcher tests cover validation behavior; the coordinator
   regression verifies exact request identity, code, message, and one terminal
   response. Application tests retain retryable saved-generation failures.
2. **Graph commit results.** Put the invalidated array directly on `accepted`.
   Update its constructor and the graph test matchers. Existing graph tests
   exercise immediate-importer invalidation, stale check rejection, and empty
   invalidation lists. Service code that intentionally ignores the payload
   remains `when accepted()`.
3. **Private source resolution.** Put kind, main path, and ordered contributors
   on `found`, then pass the needed parts to the physical-source comparison.
   The discovery suite covers flat/folder transitions, folder-first resolution,
   root ordering, physical aliases, and blocked or shadowed providers.
4. **Compiler and saved provenance.** Flatten the compiler provenance and
   metadata origin wrappers together with service, loader, semantic, and test
   consumers. Preserve source constituent order, source-array copies, physical
   provider identities, and dynamic/static tags. The metadata regression
   roundtrips all three external origin variants through SQLite; bridge,
   service, loader, semantic, and warm-cache tests cover their consumers.

The provenance refactor does not alter SQL columns or persisted encodings:
those boundaries already serialize the variant tag and individual path fields.
The cache schema change accompanying PR #169 has a separate cause: persisted
semantic identities for named case parts. No raw Titan record or union layout
is stored in the workspace database.

Named matching deliberately omits unused parts and uses aliases where a part
name would shadow an enclosing destination variable. Ignoring all parts with
`when variant()` remains valid. No compiler changes are required for these
data-model refactors. Native and full integration validation use PR #169 plus
the separately authorized analysis-only compiler fix, at the exact CI pin.

## Standard-library compatibility

The server's reflection boundary is `wire`. PR #169 removes reflection's
container wrapper records, so `wire.as_array` now matches
`is_array{array = value}` and returns the original array directly. The wire
tests cover container shape, shared identity, and explicit null preservation.
The remaining `reflect.inspect` cases either bind unchanged scalar parts or
ignore the map payload. The server does not use reflected `Type` construction
or `UnionValue` accessors.

The server does not consume the changed private regex parse nodes or libuv
process-result variants. Its process bridge uses the unchanged public
`os.Process` interface. JSON-RPC continues to encode explicit map/array
envelopes with the existing null and resource-limit options; it does not encode
server model unions or select `tag_field`. No additional adaptation is needed
for the new JSON union mapping or discriminator option.
