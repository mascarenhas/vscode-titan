# Multiple named union payload parts

Titan union variants can carry several named parts. Titan's
[unions manual](https://github.com/mascarenhas/titan/blob/master/doc/language/unions.md)
defines the language rules. This page covers editor and server behavior.

```titan
union Result
    pair(left: integer, right: string)
    item(string)
    empty()
end

local positional = Result.pair(1, "one")
local named = Result.pair{right = "two", left = 2}

function describe(result: Result): string
    case result
        when pair{label = right, left} then
            return label
        when item(text) then
            return text
        when empty() then
            return "empty"
    end
    return ""
end
```

`item(string)` means `item(value: string)`. In a named pattern the local name
is on the left of `=` and the declared part on the right. The shorthand
`when pair{left}` binds a local `left` from the part `left`.

## Editor behavior

The TextMate grammar (`syntaxes/titan.tmLanguage.json`) scopes variant names as
`entity.name.tag.titan` and declared part names as `variable.parameter.titan`.
Contextual names such as `end` are included, and nested payload types keep type
coloring. Tokenization is line based, so an `end` variant separated from its
opening `(` by a comment or a newline can be read as the union terminator.

Saved-file analysis records references to every part's type and every case
binding. Variant hover signatures show every declared part name and type.
Generic constructor hover keeps the applied payload types: for
`Packet<|integer|>.moved`, a part declared as `x: T` shows as `x: integer`. The
compiler's analysis-only mode keeps the checked source expression from before
runtime generic erasure; module-signature metadata remains a separate
interface.

Part declarations, named constructor labels and named pattern selectors share
one identity within their variant. A same-named part in another variant is
independent. A pattern alias has its own local binding identity.

Rename preserves shorthand semantics. Each shorthand occurrence carries a
`semantic_index.SharedCaseName`, and `edited_file` in
`src/server/semantic_features.titan` expands it into `alias = part`:

- Renaming the local `left` in `when pair{left}` to `first` produces
  `when pair{first = left}`.
- Renaming the declared part to `first` produces `when pair{left = first}`. The
  local binding and its uses are unchanged.

Diagnostics, navigation, references and rename use saved files. Completion
uses captured unsaved buffers, including constructor members and case-arm
locals, and prepares the hover context described in
[completion](completion.md). The compiler remains the authority for validity.

## Server implementation

`compiler_bridge` walks union `parts`, case-arm `bindings` and constructor
`values` from the compiler's AST and type metadata (`AST_CHILD_FIELDS`). It
converts them to typed server facts before publication. A shorthand binding is
both a part selection and a local declaration at the same span.
`semantic_index.SharedCaseName` records that dual role, and
`semantic_occurrences.case_part_id` persists the selected part. Workspaces with
an incompatible cache are rebuilt; see
[workspace storage](sqlite-backend-storage.md#location-and-opening).

## Server data models

The server's own unions follow one rule. Use named parts for data that only a
variant owns. Keep a record when the data has an independent typed API, is a
reusable domain value, has methods, or shares a mutable lifetime. Examples of
kept records:

- `application.View`, the published feature snapshot;
- `dispatcher.DispatchResult`, `SemanticRequest` and `CompletionRequest`, used
  outside routing;
- `lsp_types.OpenDocument`, `ChangeDocument` and `TextDocument`, which are
  precise parser results;
- `protocol.InputDelivery`, a mutable owner whose methods manage
  acknowledgement;
- `compiler_bridge.AdjustmentInfo`, the common shape of all six adjustment
  variants.

A named variant is not a type, so flattening a record into parts helps only
when consumers need the union and its selected parts, never the record on its
own.

The reflection boundary is `wire`. `wire.as_array` matches
`reflect.inspect(subject)` against `is_array{array = value}` and returns the
original array. JSON-RPC encodes explicit map and array envelopes and never
encodes server model unions.
