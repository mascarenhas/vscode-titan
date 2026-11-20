# Using the Titan VS Code Extension

The Titan VS Code extension bundles a platform-specific native language server,
compatible `titan-compiler` Lua modules, SDK headers, Lua sources, and the
release-matched browser semantic pack. Editing native or browser Titan projects
in VS Code requires no separate Titan installation.

## Installing and updating

Install a prebuilt platform VSIX from the command line:

```sh
code --install-extension titan-linux-x64.vsix --force
```

To package and install directly from a local checkout:

```sh
make package
make install-vsix
```

Packages are target-specific (`linux-x64`, `linux-arm64`, `linux-armhf`,
`darwin-x64`, `darwin-arm64`, and experimental `win32-x64`; see
[Windows](#windows) and
[experimental Windows builds](native-build.md#experimental-windows-build)).
Packaging inputs, glibc baselines, and bundled-library notices are covered in
[paired browser semantic pack](native-build.md#paired-browser-semantic-pack).

The extension declares `untrustedWorkspaces.supported: false` and
`virtualWorkspaces.supported: false` in [`package.json`](../package.json). Open
a trusted local or remote workspace folder to activate language support.

## Editing Titan code

### Saved-file intelligence and unsaved buffers

Definition, references, rename, folding, and **Problems** diagnostics operate on
saved files on disk. Save edits before expecting updated diagnostics or
cross-file navigation.

- **Responsive indexing:** Read-only requests answer immediately while indexing
  runs. Before the first saved generation completes, they return ordinary empty
  results; afterward, they serve from the most recent completed generation while
  a refresh runs in the background.
- **Diagnostics:** Compiler errors from each completed saved generation appear
  in **Problems** with UTF-16 columns converted from compiler byte offsets. A
  rejected module and its dependency closure publish no reusable interfaces for
  that generation, while independently valid modules remain indexed. Repairing
  or deleting a file, changing source roots, or stopping the client clears stale
  entries.
- **Rename safety:** Rename joins or starts an explicit refresh and verifies
  saved files on disk after preflight, ensuring edits apply against the newest
  stable generation.
- **Out-of-scope navigation:** FFI definition navigation, external-source
  navigation, and watching external source trees are excluded from editor
  navigation.

Completion and live hover operate on unsaved editor buffers:

- **Completion:** Triggered by `.`, `:`, or the editor's completion command,
  including after `foreign` in type annotations and at unprefixed C types inside
  `foreign function` blocks. Callable candidates display named signatures and
  insert editable parameter-name call placeholders when
  `titan.completion.insertCallSnippets` is `true` (default). Disable that
  setting to insert plain names when taking function or bound-method references.
- **Live hover:** After a completion request, hover tracks subsequent unsaved
  edits in the active module. See [Chapter 6: Completion](completion.md) for
  capture rules, TEMP storage, and edit mapping.

### Hover summaries and LDoc documentation

Hover displays named declaration signatures for functions, methods, associated
functions, and supported foreign callables; function-valued variables display
their bare function type. Record, union, and interface hovers summarize members
visible at that occurrence. Module hovers summarize visible top-level members
without expanding nominal types recursively.

LDoc-style comments (`--- ...`) attached to modules (marked with `@module`),
top-level declarations, record fields, union variants, and interface methods
appear below the signature in hover and in completion detail panels. `@usage`
and `@see` tags containing a relative `.md` path (with optional `#anchor`)
render as clickable links into Titan's upstream language manual; other `@usage`
content renders as a Titan code block. See the
[Titan documentation comments manual](https://github.com/mascarenhas/titan/blob/master/doc/language/modules.md#documentation-comments)
for attachment rules and [Chapter 3: Compiler Bridge](compiler-bridge.md) for
Markdown rendering internals.

### Multi-part union payloads

Titan union variants can declare multiple named payload parts. Variant hover
displays every part name and type, preserving applied type arguments for generic
constructors (for example, a part `x: T` appears as `x: integer` on
`Packet<|integer|>.moved`). Part declarations, named constructor labels, and
named `case` pattern selectors share one symbol identity within their variant,
while same-named parts on other variants and pattern aliases keep distinct
identities.

Rename preserves shorthand `case` semantics:

- Renaming the local `left` in `when pair{left}` to `first` expands to
  `when pair{first = left}`.
- Renaming the declared part `left` to `first` expands to
  `when pair{left = first}`, leaving the local binding and its uses intact.

The TextMate grammar ([`syntaxes/titan.tmLanguage.json`](../syntaxes/titan.tmLanguage.json))
highlights variant names and declared part names, including contextual names
such as `end`. Because tokenization is line-based, separating an `end` variant
from its opening `(` with a comment or newline can cause the scanner to treat
`end` as the union terminator. See [Chapter 5: Semantic Features](semantic-features.md)
for the rename implementation.

### C imports and `foreign function` highlighting

`foreign import "header.h"` declarations and explicit `.titan` source imports
contribute in declaration order to the module's builtin `ffi` namespace.
Written `ffi` roots and C value members support hover and references within
their module (without definition or rename targets). Foreign types live in their
own unqualified namespace (`foreign int`, `foreign *Name`,
`foreign type Name = ...`).

Ordinary Titan analysis needs no C compiler. A native root that imports C
headers requires a native C toolchain on the host. The VSIX supplies Titan, Lua,
libuv, llhttp, and SQLite headers, plus OpenSSL headers when built against a
bundled-OpenSSL SDK; with system OpenSSL or third-party C libraries, supply
headers through the host C toolchain or `extra_ffi_include_dirs` and
`extra_ffi_cppflags`.

A `foreign function` omits the `foreign` prefix on C types in its signature and
body (for example `local count: *int = context as *int`), while
`foreign T.new()`, `foreign T.new_array(N)`, `foreign T.sizeof`, and
`foreign T.alignof` keep their prefix. The TextMate grammar colors unprefixed C
types after `:` and `as` (including multiword primitives such as
`unsigned long`) using a single-line scanner that matches `if`, `do`, and
`repeat` blocks to their closing `end` or `until` while ignoring keywords used
as member names, named-argument labels, or C typedef names (even across comments
or line breaks). Three line-scanner limits apply:

1. The header must write `foreign function Name` on one line separated only by
   spaces, or no foreign-function region opens.
2. An unclosed block extends C-type coloring to the next unmatched `end`,
   typically the end of the following function.
3. Inside a C function-pointer type, only parameter types spelled like block
   keywords receive type coloring.

## Project configuration

An optional `titan-config.lua` at the workspace root sets project options through
global assignments in an empty Lua environment. Returned values and unknown
fields are rejected. Relative paths resolve from the workspace root.

```lua
include = { "./titan", "./spec/stdlib/titan" }
exclude = { "./examples", "./spec/fixtures" }
source_module_roots = { ".", "./spec/stdlib/titan", "./vendor/titan" }
binary_modules_root = ".titan/lib/titan/0.6"
target = "native"
extra_ffi_include_dirs = { "include", "vendor/include" }
extra_ffi_cppflags = "-DPROJECT_FFI=1 '-Ivendor path/include'"
```

| Field | Default | Meaning |
| --- | --- | --- |
| `include` | `{ "./src" }` | Directories scanned recursively for saved `.titan` files and watched for changes |
| `exclude` | `{}` | Files or subtrees removed from watching only; their modules remain indexed and refresh on the next change to another watched input (editing `exclude` alone preserves cached semantics) |
| `source_module_roots` | `{ "./src" }` | Complete ordered compiler source search path determining logical module names (entries may not contain `;`; paths outside `include` resolve as external source without watching or navigation) |
| `target` | `"native"` | Analysis target: `"native"` or `"browser"` (tracked `titan-config.lua` only) |
| `binary_modules_root` | selected SDK provider directory | Compiled provider directory for the active target |
| `extra_ffi_include_dirs` | `{}` | Additional C include directories for `foreign import` |
| `extra_ffi_cppflags` | none | `-I` and `-D` flags in `TITAN_EXTRA_CPPFLAGS` shell-word syntax, appended to the inherited environment for editor analysis only (pass matching flags to `titanc`) |
| `compiler_root` | server's `TITAN_ROOT` | Installed Titan SDK prefix for this root; relative paths resolve from the root |

### Logical module identity and target variants

A saved file's logical module name is relative to the most specific containing
entry in `source_module_roots`, validated against root order and Titan's
folder-before-flat rule. Shadowed, blocked, or ambiguous providers produce a
configuration diagnostic rather than analyzing the file under an identity
`titanc` would reject.

Target variants (`name.<label>.titan`) group under their logical filename and
select according to the root's `target` (ambient `TITAN_TARGET` is ignored).
Unselected variants are excluded from analysis and receive an
information-severity `inactive-variant` diagnostic. An included `.titan` file
outside every `source_module_roots` entry receives an `unmapped-source` warning
and stays excluded from indexing, navigation, and watching until a subsequent
discovery pass or configuration edit.

Project discovery ignores symlinked files and directories below `include` roots.
Opening the workspace root itself through a symlink works normally.

### Browser roots

Setting `target = "browser"` selects `.browser.titan` variants ahead of
unlabeled files and reads standard-library interfaces from Wasm provider
archives. The language server performs typechecking only; building, linking, and
running browser targets remain command-line tasks.

The default VSIX carries the matching browser semantic pack (`analysis-target`,
`absent-modules`, and Wasm `titan.a`), so ordinary browser editing requires no
Emscripten installation. When a browser root imports C headers or requires a C
probe, install Emscripten **6.0.13** and put `emcc` on `PATH` or set `EMSDK` in
the environment launching VS Code. Without Emscripten, only the affected
C-importing module receives a diagnostic; the server never runs a native C
compiler for browser analysis.

When a browser root also sets `compiler_root`, that SDK must supply its own
matching `lib/titan-browser/0.6/{analysis-target,absent-modules,titan.a}`. An
incomplete or mismatched SDK fails that root without borrowing the VSIX pack.

### Per-root SDK overrides (`titan-config.local.lua`)

To point a checkout at a machine-specific Titan SDK without modifying tracked
files, create a gitignored `titan-config.local.lua` beside `titan-config.lua`
assigning only `compiler_root = "/path/to/titan-sdk"`. Any other key or invalid
path fails the root instead of substituting the default SDK. Because the
extension runs only in trusted workspaces, it automatically adds each launched
workspace folder to `trustedRoots`. Keep command-line `titanc` invocations on
the same SDK. See
[per-root SDK selection and trust](language-server.md#per-root-sdk-selection-and-trust)
and [compiler compatibility](server-data-flow.md#compiler-compatibility).

## Extension settings

| Setting | Default | Scope | Meaning |
| --- | --- | --- | --- |
| `titan.languageServer.path` | `""` (packaged server) | `machine-overridable` | Executable path, absolute or relative to the workspace folder; empty uses packaged `bin/titan-language-server` (`bin/titan-language-server.exe` on Windows) |
| `titan.languageServer.arguments` | `[]` | `machine-overridable` | Extra arguments passed to the server process |
| `titan.languageServer.logLevel` | `"debug"` | `machine-overridable` | Server structured log emission (`off`, `error`, `info`, `debug`, `trace`); changing restarts the affected server |
| `titan.trace.server` | `"off"` | `window` | LSP protocol tracing (`off`, `messages`, `verbose`); updates live without restarting |
| `titan.compiler.luaPath` | `""` (packaged tree) | `machine-overridable` | Complete Lua search path passed as `TITAN_LS_LUA_PATH` (empty uses bundled `dist/titan/share/lua/5.5`) |
| `titan.compiler.luaCPath` | `""` (packaged tree) | `machine-overridable` | Complete native Lua search path passed as `TITAN_LS_LUA_CPATH` (empty uses bundled `dist/titan/lib/lua/5.5`) |
| `titan.completion.insertCallSnippets` | `true` | `resource` | Insert parentheses and editable parameter placeholders for callable completions; changing restarts the affected server |

When `titan.compiler.luaPath` or `titan.compiler.luaCPath` is non-empty, its
value replaces the packaged template verbatim (no `;;` expansion; ambient
`LUA_PATH` and `LUA_CPATH` are ignored). The extension also sets `TITAN_ROOT` to
its packaged `dist/titan` tree so C imports and live analysis find bundled
headers and Lua sources. Changing any `titan.languageServer.*`,
`titan.compiler.*`, or `titan.completion.*` setting restarts the affected
workspace folder's server (`TitanClientManager.scheduleRestart` in
[`src/extension/extension.ts`](../src/extension/extension.ts));
`titan.trace.server` toggles live (`ProtocolTraceController` in
[`src/extension/outputChannel.ts`](../src/extension/outputChannel.ts)).

## Multi-root, symlinked, and remote workspaces

The extension runs on the workspace host (`extensionKind: ["workspace"]`) and
starts one server session per VS Code workspace folder.

- **Multi-root and nested folders:** Each workspace folder owns its own server
  process, and in nested multi-root layouts VS Code's most specific workspace
  folder owns each document's requests (`createWorkspaceMiddleware` in
  [`src/extension/workspaceUris.ts`](../src/extension/workspaceUris.ts)). Adding
  or removing a nested folder restarts enclosing folder clients so open buffers
  transfer cleanly.
- **Symlinked workspace roots:** Opening a workspace folder through a directory
  symlink resolves its physical root once and maps returned protocol locations
  back to the lexical workspace URI (`createWorkspaceUriConverters` in
  [`src/extension/workspaceUris.ts`](../src/extension/workspaceUris.ts)).
- **Remote SSH, WSL, and containers:** Both the extension and native server run
  on the remote host. The client translates the workspace's remote URI scheme to
  host `file:` paths and maps returned locations back. Non-`file:` folders
  without a local host mapping are ignored.

## Status, logs, protocol tracing, and workspace cache

- **Indexing status item:** While claimed roots index or refresh saved files, a
  **Titan indexing** language-status item stays busy (`Titan indexing N/M files`
  when every busy root reports its workset) and clears once ready. Failures stay
  visible as an error item; selecting it runs **Titan: Show Language Server
  Output**.
- **Output channel and log levels:** Run **Titan: Show Language Server Output**
  (`titan.showLanguageServerOutput`) to open the **Titan Language Server**
  channel, where every line is prefixed with `[<folder-name>]`. Structured
  server records map to their declared severity; unstructured stderr shows as an
  error. Because the extension launches servers at `debug` emission, VS Code's
  output-channel level selector switches between `Info` and `Debug` without
  restarting. For `Trace` records, set `titan.languageServer.logLevel` to
  `trace` (restarting the server) and select `Trace` in the channel. Indexing
  emits paired `indexing.chain.start` and `indexing.chain.complete` records
  (Info on start/success, Error on failure) with trigger, pass count,
  generation, wall time, and CPU time; `Debug` adds scan/analysis phases and
  per-module `compiler.module.complete` entries.
- **Protocol tracing:** Set `titan.trace.server` to `messages` for summaries or
  `verbose` for full JSON-RPC payloads (live, without restarting). Reset to
  `off` afterward because `verbose` traces can contain source text.
- **Workspace cache (`.titan-ls`):** Each root stores its SQLite index in
  `<root>/.titan-ls/index.sqlite3` and its C probe cache in
  `<root>/.titan-ls/var/cache/titan-probes/2` (`.titan-ls` includes a
  `.gitignore` and is never scanned or watched). Compatible restarts answer from
  SQLite immediately while restoring compiler declarations in the background;
  compiler, server-build, or semantic config changes rebuild automatically. If
  the database cannot open, the server logs the error and runs in memory. To
  reset the cache, close VS Code (or stop the server) and delete `.titan-ls`—or
  delete only `index.sqlite3` to keep C probe results. Clear the probe directory
  separately when host headers change or when `TITAN_PREFIX` relocates probes
  ([cache and probe prefix layout](language-server.md#cache-and-probe-prefix-layout)).
  See [workspace storage](sqlite-backend-storage.md#location-and-opening).

## Windows

Windows x64 support is experimental. It uses a native CLANG64/UCRT Titan SDK, a
DLL application, and a shared Lua DLL; the extension launches
`bin/titan-language-server.exe` and loads `.dll` compiler modules. See
[experimental Windows builds](native-build.md#experimental-windows-build) for
build setup and validation gates.

A trusted root's `compiler_root` on Windows requires `bin/lua.exe` and
`lib/titan/0.6/titan.dll` in the selected SDK (the language server retains its
own runtime DLLs); an incomplete or incompatible SDK fails that root without
substituting the bundled SDK. See
[compiler compatibility](server-data-flow.md#compiler-compatibility).

Windows source paths must be fully qualified drive paths (`C:/project`,
including mapped shares such as `W:/project`) or UNC paths
(`//server/share/project`) with bounded ASCII host names. Drive-relative,
current-drive-rooted, and device-namespace paths are rejected. Drive letters are
normalized while full paths are not case-folded. A workspace opened through a
traversable directory symlink resolves to its physical root regardless of
drive-letter casing. File watching on shared folders is best effort; keep active
projects on a local NTFS volume for reliable notifications.
