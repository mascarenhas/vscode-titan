# Multiple named union payload parts

The extension supports the union syntax introduced by
[Titan PR #169](https://github.com/mascarenhas/titan/pull/169). Build with the exact
compiler revision pinned in the CI workflow and refresh the complete local SDK
when changing that revision. Language-server API 1 remains the prerelease API.

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

Each part has its own name and type. The earlier `item(string)` spelling means
`item(value: string)`, and `empty()` still carries no data. Positional
construction follows ordinary call adjustment. A direct named constructor uses
the declared part names, regardless of their written order.

Patterns can select a positional prefix (`when pair(first)`) or any named
subset (`when pair{label = right}`). In a named alias, the local name is on the
left and the declared part is on the right. The shorthand `when pair{left}`
binds a local named `left` from the part also named `left`. Omitted parts do not
create local bindings. A reserved-word part needs an alias in a named pattern.

## Editor behavior

Highlighting recognizes declarations, constructors and both pattern forms.
Variant names, declared part names and named constructor labels have distinct
scopes, including contextual names such as `end`. Nested payload types retain
their type coloring; constructor values retain expression coloring. TextMate
tokenization is line based: an `end` variant separated from its opening `(` by
a comment or newline can still be read as the union terminator.
Saved-file analysis retains references to every part's type and every case
binding. Variant hover signatures show all declared part names and types.
Part declarations, named constructor labels and named pattern selectors share
one identity within their variant; a same-named part in another variant is
independent. A pattern alias has its own local binding identity.

Generic constructor hover preserves applied payload types: for
`Packet<|integer|>.moved`, a payload declared as `x: T` displays as `x: integer`.
The compiler's analysis-only mode retains the checked source expression before
runtime generic erasure; module-signature metadata remains a separate interface.

Rename preserves shorthand semantics. Renaming the local `left` in
`when pair{left}` to `first` produces `when pair{first = left}`. Renaming the
declared part to `first` instead produces `when pair{left = first}`, leaving
the local binding and its uses unchanged.

Diagnostics, navigation, references and rename continue to use saved
files. Completion uses captured unsaved buffers, including constructor
members and case-arm locals, and prepares the bounded ephemeral hover context
described in [completion behavior](completion.md). Its provisional-result policy is unchanged; the
compiler remains the authority for validity.

## Server implementation

The compiler boundary reads union `parts`, case-arm `bindings` and constructor
`values` from the pinned AST and type metadata. It converts compiler-owned
tables to typed server facts before publication. Persisted semantic facts
distinguish part selection from a local shorthand binding, and incompatible
workspace caches are rebuilt.

The [server payload audit](union-payload-audit.md) records which wrapper records
were replaced and which records retain an independent role. Named parts suit
data owned solely by a variant. Records remain useful for reusable domain
values, methods and shared mutable ownership.
