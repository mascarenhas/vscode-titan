# Declaration documentation

Titan's compiler retains LDoc-style comments on modules, top-level declarations
and interface methods. The language server displays that documentation below
the existing type, signature and visibility information in hover, and in a
completion item's extra information panel.

```titan
--- Select a count.
-- @param count The returned number.
-- @return The selected integer.
-- @usage functions.md#named-calls
function select(count: integer): integer
  return count
end
```

A leading module comment uses `@module` to distinguish it from documentation
for the first declaration. Ordinary comments and text inside string literals
do not become documentation. See the compiler's
[documentation comment manual](https://github.com/mascarenhas/titan/blob/master/doc/language/documentation-comments.md)
for attachment and supported comment forms.

The compiler supplies a detached summary, description and ordered list of
tags. The bridge validates this payload and converts it into typed records.
The presentation module formats parameters, returns, fields, usage and
extension tags as Markdown. Repeated tags retain their order. An `@usage` or
`@see` value naming a Markdown file relative to Titan's `doc/language` root
becomes a link to that file in the upstream repository, including its fragment.
Other usage values remain code examples. Relative links stay relative in
compiler metadata, so a future documentation host can change the rendering
without rebuilding producers.

Saved publication retains rendered documentation beside scalar occurrences,
completion members and module descriptors. Hover and completion selection
read SQL facts without traversing ASTs or decoding compiler metadata.
Compiled provider interfaces, retained project descriptors and unchanged warm
startup preserve documentation; a documentation edit changes the declared
manifest so dependent source facts are refreshed.

Unsaved documentation follows the existing completion capture rules. Private
preparation formats documentation from the captured active module and the
committed dependency descriptors. An editor buffer in a dependency does not
override saved dependency documentation. Recent-completion hover uses the
same exact session, version, contributor vector and saved generation as its
other facts. Editing comments retires that context, and saving never promotes
TEMP facts.

The new compiler module is included in staging and VSIX inventory checks.
Compiler, ABI, descriptor, language-server API, extension and cache version
numbers remain unchanged for this prerelease feature. The compiler content
identity rejects an older workspace cache before its SQL facts are reused.

Verification covers typed rejection and detachment, Markdown and link
rendering, persistent and TEMP SQL round trips, cached dependency completion,
stdio completion/hover and comment-edit invalidation. Delivery uses the full
local Linux compiler and extension gates; Windows and macOS VM testing was
waived for issue #96.
