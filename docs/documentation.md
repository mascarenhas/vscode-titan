# Declaration documentation

Titan's compiler keeps LDoc-style comments on modules, top-level declarations
and interface methods. The language server shows that documentation below the
type, signature and visibility information in hover, and in a completion item's
extra information panel.

```titan
--- Select a count.
-- @param count The returned number.
-- @return The selected integer.
-- @usage functions.md#named-calls
function select(count: integer): integer
  return count
end
```

A leading module comment uses `@module` to tell it apart from the first
declaration's documentation. Ordinary comments and text inside string literals
do not become documentation. The compiler's
[documentation comment manual](https://github.com/mascarenhas/titan/blob/master/doc/language/documentation-comments.md)
defines attachment and the supported comment forms.

## Rendering

The compiler supplies a detached summary, a description and an ordered list of
tags. `compiler_bridge` validates this payload and converts it into
`documentation.Documentation` records. `Documentation:markdown` in
`src/server/documentation.titan` formats parameters, returns, fields, usage,
see-also and extension tags as Markdown, keeping repeated tags in order. It
skips `@module`, `@name` and `@class`.

A `@usage` or `@see` value that looks like a relative Markdown path (`.md`,
optionally with a fragment) becomes a link under `MANUAL_ROOT`, Titan's
upstream `doc/language/` directory. Absolute paths and values containing `..`
are not linked. Other usage values render as Titan code blocks. Compiler
metadata keeps the relative form, so a future documentation host can change
the rendering without rebuilding producers.

## Saved and unsaved documentation

Saved publication stores rendered documentation beside scalar occurrences,
completion members and module descriptors. Hover and completion selection read
these SQL facts without traversing ASTs or decoding compiler metadata.
Compiled provider interfaces, retained project descriptors and an unchanged
warm startup all preserve documentation. Editing documentation changes the
declared manifest, so dependent source facts are refreshed.

Unsaved documentation follows the completion capture rules in
[completion](completion.md). Private preparation formats documentation from the
captured active module and the committed dependency descriptors. An editor
buffer for a dependency does not override that dependency's saved
documentation. Hover after completion uses the same session, version,
contributor and saved-generation identity as its other facts. Editing a
comment retires that context, and saving never promotes TEMP facts.

`src/server/documentation_test.titan` covers Markdown and link rendering.
Bridge, store and stdio protocol tests cover typed rejection, persistent and
TEMP round trips, cached dependency completion and comment-edit invalidation.
