# Completion usability research (2026-10-05)

## Primary evidence

- [LSP 3.17 completion specification](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/language/completion.md): `label` stays the unqualified name; `labelDetails.detail` is intended for function signatures/type annotations. `detail` can provide a full signature to older clients. Advertised `snippetSupport` gates snippet syntax, and `insertTextFormat: 2` applies to `textEdit.newText`. An explicit whole-token `textEdit` avoids client word guessing; `filterText` keeps filtering on the identifier. Compute edit/filter/snippet fields eagerly unless the client specifically supports resolving those fields.
- [LuaLS settings](https://luals.github.io/wiki/settings/#completionshowparams): `showParams` defaults to true. `callSnippet` supports Disable, Both, and Replace; it defaults to Disable. This provides a useful precedent for displaying signatures independently of insertion policy and offering a function-value escape hatch.
- [rust-analyzer configuration](https://rust-analyzer.github.io/book/configuration#rust-analyzercompletioncallablesnippets): argument snippets default to `fill_arguments`; complete function signatures are a separate option. Its [function renderer](https://github.com/rust-lang/rust-analyzer/blob/master/crates/ide-completion/src/render/function.rs) gates insertion on snippet capability, expression context, and absence of existing call parentheses. Matching callable expected types suppress insertion. Bound receiver calls omit `self`. Zero-argument insertion is `name()$0`; parameter insertion uses ordered named placeholders and a final `$0`.
- [VS Code TypeScript completion](https://github.com/microsoft/vscode/blob/main/extensions/typescript-language-features/src/languageFeatures/completions.ts): displays structured label details, obtains full signature/detail from semantic display parts, and prevents duplicate parentheses or calls in binding/import positions. Its [snippet builder](https://github.com/microsoft/vscode/blob/main/extensions/typescript-language-features/src/languageFeatures/util/snippetForFunctionCall.ts) uses top-level parameter names, ignores explicit `this`, excludes trailing optional/rest arguments from mandatory placeholders, and ends at `$0`.
- [gopls settings](https://go.dev/gopls/settings#completeFunctionCalls): call completion defaults on, but placeholders default off. Statement position or expected return type can justify a call. This reinforces that a callable candidate alone does not prove the user wants to invoke it.
- [LSP document synchronization](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/textDocument/didChange.md): changes carry increasing document versions, and requests must observe synchronized document state. [HoverParams](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/language/hover.md) contains position and document identity, with no version field.
- [gopls hover handler](https://github.com/golang/tools/blob/master/gopls/internal/server/hover.go) requests a file handle and snapshot together and passes that pair to hover. Its [snapshot](https://github.com/golang/tools/blob/master/gopls/internal/cache/snapshot.go) retains consistent bytes and derived semantic state, including unsaved overlays. This is a precedent for hover reusing a coherent captured analysis, rather than combining latest buffer positions with older saved semantic spans.

## Recommended Titan behavior

1. Display the compiler's parameter names, parameter types, generic parameters and return values; do not infer names from source snippets or parse a rendered function type. Keep the declaration's metadata authority through imported/source/static-provider candidates. Method presentation and call snippets exclude the bound receiver parameter.
2. Keep bare identifiers as `label` and `filterText`, and preserve the existing stable ranking in `sortText`. Use `labelDetails.detail` for the parameter/return suffix when supported and a complete `detail` signature for all clients.
3. Insert `name(${1:parameter}, ${2:other})$0` in callable expression contexts for snippet clients. Keep the current whole-token range so a suffix after the caret disappears. Preserve the preceding `.`/`:`. Escape snippet metacharacters in placeholder defaults.
4. Avoid duplicate parentheses when the active token is followed by `(` after whitespace, including the remainder of the identifier after the caret. Insert the bare name in type/import/declaration positions and where callable-reference intent is known. Retain an explicit name-only mode or alternative candidate for ambiguous callback/bound-method positions. Titan's `receiver:method` can be a callable value.
5. A missing parameter name should get a stable fallback placeholder. Titan permits omitted fixed parameters through its nil adjustment; another language's optional/default-parameter policy should not be copied without checking that rule. A variadic rest should not become an invented mandatory argument. Do not pretend C/foreign metadata contains names if it does not.
6. Reuse scalar ephemeral occurrence facts and continue private source analysis after completion activates it. Capture hover inputs before scheduling and recheck them before responding. Fresh publication requires exact sessions, versions, contributors and saved generation. A bare string name is insufficient because of shadowing.
7. Retain the preceding accepted analysis while replacement runs, with its old provenance explicit. Map untouched occurrence ranges across edits; omit substituted/deleted tokens and verify complete token bytes and boundaries. Semantic types/docs may remain stale until a usable rebuild replaces them. Closed/reopened sessions and eviction end reuse. Never return old byte spans as current ranges or attach saved symbols to dirty text by coincidental coordinates. See the follow-up research below.

## Suggested regression matrix

- Local/exported/static functions, record/interface methods, constructors, imported source and provider metadata.
- Parameterless, multi-parameter, generic, function-valued arguments, defaults/optional and variadic signatures; foreign missing-name fallback.
- Snippet and label-details capability combinations, snippet escaping, UTF-16 and complete-token replacement.
- Existing parentheses, whitespace, token suffix after caret, `.`/`:` preservation, callable references and qualified-type positions.
- Hover for a new unsaved local and unsaved receiver; shadowing; completion then accepted insertion; changed version/contributor/generation; close and reopen; Unicode ranges; second-connection/main-index isolation.

These recommendations extend the requested work with interoperability, insertion guards and bounded ephemeral hover ownership. They do not require adding signature-help, auto-imports, fuzzy ranking, general malformed-source recovery or whole-project unsaved navigation to this PR.

## Existing compiler boundary and implementation direction

The compiler's completion observer sees both the resolved callable type and its declaration descriptor while lexical scopes and specialized receiver members are alive. Its current scalar fact drops the declaration's parameter names. The server already has a declaration-aware callable renderer for saved hover, so presentation can reuse that renderer at this observation boundary rather than recover names from a rendered type.

A temporary observer around `titan-compiler.completion.fact` during private preparation can enrich only the transient candidates. It must delegate candidate eligibility and identity to the original observer, emit scalar presentation fields, and restore the exact original callable before releasing the compiler permit, including on errors and cancellation. The wrapper must not yield through a Lua callback. This approach preserves the existing compiler revision and avoids reconstructing lexical or specialization rules in the server.

The wrapper belongs only to `Compiler:analyze_completion`. Saved descriptor `completion_facts` have a closed compiler schema and must not acquire server-specific insertion fields. Every completion item is selected from privately prepared TEMP rows; imported source and binary declarations can be rendered again during that private analysis. Regressions should exercise restored source descriptors, static-provider metadata, and unchanged warm startup to prove that no result depends on retaining an old compiler AST.

`Type.Method.params` already describes the bound callable's explicit parameters. Its receiver is separate. Presentation or insertion must not remove its first explicit parameter a second time. Function-value types may have no declaration names; retaining anonymous type display and using stable `arg1`, `arg2` placeholders accurately represents that absence.

The current compiler completion API does not expose the expected callable type at the hole. Automatic reference-versus-call selection therefore remains a future compiler capability; this extension change uses an explicit insertion preference for ambiguous named function and bound-method references. Reconstructing that expected type from source text would duplicate checker policy and weaken the compiler boundary.

## Continuous hover and debouncing (2026-10-06)

Accepting a completion is an ordinary document edit. Clearing the accepted hover
context on every version change creates a whole-file gap after snippet insertion.
Completion's synthetic hole also excludes the selected callee, so continuing to
analyze that same hole does not repair the gap. Background refresh must analyze
the ordinary current buffer independently of completion selection.

[Haskell Language Server's hover handler](https://github.com/haskell/haskell-language-server/blob/5327ae014b5fa7fce028f22c55499ddd9f0d2de7/ghcide/src/Development/IDE/Core/Actions.hs#L47-L64)
retrieves a potentially stale semantic AST, maps the current cursor back to it,
then maps the returned range forward. Its
[scheduler](https://github.com/haskell/haskell-language-server/blob/5327ae014b5fa7fce028f22c55499ddd9f0d2de7/ghcide/src/Development/IDE/Core/Shake.hs#L1100-L1154)
returns a retained result immediately and queues rebuilding; without an earlier
result it waits for initial computation. A
[failed rebuild](https://github.com/haskell/haskell-language-server/blob/5327ae014b5fa7fce028f22c55499ddd9f0d2de7/ghcide/src/Development/IDE/Core/Shake.hs#L1309-L1325)
preserves the previous successful result as stale. Its
[position mapping](https://github.com/haskell/haskell-language-server/blob/5327ae014b5fa7fce028f22c55499ddd9f0d2de7/ghcide/src/Development/IDE/Core/PositionMapping.hs#L40-L101)
distinguishes exact unchanged positions from substituted regions. This supports
retained hover with conservative coordinate translation through malformed edits,
without claiming the older semantic result is current.

[clangd's scheduler](https://clangd.llvm.org/design/threads) collapses pending
updates and rebuilds when the debounce deadline expires or a read arrives.
Its [default adaptive policy](https://clang.llvm.org/extra/doxygen/structclang_1_1clangd_1_1ClangdServer_1_1Options.html)
ranges from 50 to 500 ms and considers recent rebuild cost. Titan starts with a
fixed **200 ms trailing interval** to accumulate ordinary typing and snippet
edits while allowing prompt refresh. That value is our tuning choice within a
documented prior-art range, rather than a universal language-server standard.
Retained hover remains immediate, and compiler preparation stays off the hover
SQL query path. Adaptive timing or expediting refresh on a cache miss can follow
if measured preparation cost justifies it.

[gopls's diagnostics delay](https://go.dev/gopls/settings#diagnosticsDelay) applies
to deeper diagnostics, while initial parse/type errors are computed immediately;
it does not supply a hover debounce recommendation. Its
[save/change handling](https://github.com/golang/tools/blob/3e15c990d6868f3369d69fcc9bcb565f12eeeba8/gopls/internal/server/text_synchronization.go#L122-L200)
and [snapshot overlays](https://github.com/golang/tools/blob/3e15c990d6868f3369d69fcc9bcb565f12eeeba8/gopls/internal/cache/snapshot.go#L490-L515)
separate editor bytes from saved state. Titan likewise retains private hover
through save and queues new private analysis after watcher-owned publication,
without promoting TEMP facts into the saved index.

Regression coverage must apply the actual returned snippet/edit, hover its newly
inserted function and method names without requesting another completion, and
exercise edit bursts, malformed source, token replacement, Unicode/CRLF ranges,
contributor changes, same-version reopen and save/watcher handoff.
