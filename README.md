# Titan for VS Code

This repository contains the VS Code extension and standalone language server
for the [Titan programming language](https://github.com/mascarenhas/titan).
Version 1 provides syntax highlighting and saved-file language intelligence for
Titan projects. The server is an ordinary LSP process over stdio. A bundled
skills-only Codex plugin queries that same executable for read-only saved-file
code intelligence.

The native executable statically links the Titan standard-library provider,
the embedded Lua interpreter, and the selected native dependencies. The Titan
compiler itself is not embedded: that Lua state loads the normal installed
`titan-compiler` modules through `package.path` and their native dependencies
through `package.cpath`.

## Prerequisites

- A sibling Titan checkout at `../titan` (override with `TITAN_REPO=...`).
- A C toolchain and the native prerequisites used by Titan.
- Node.js 24 and npm.
- VS Code 1.106 or newer for extension development and installation.

Version 1 builds native packages on Linux and macOS. Windows requires a future
native Titan toolchain/package path rather than relabeling another host's
executable.

The repository owns an ignored Titan installation in `.titan/`; build commands
do not rely on an ambient `titanc` or Lua installation.

## Build and test

```sh
make toolchain
make npm-ci
make
make test
```

`make` produces `bin/titan-language-server` and `dist/extension.js`. The server
build uses Titan's static-provider path and, on ELF systems, exports the embedded
Lua API so compiler dependencies loaded from `package.cpath` bind to that same
Lua state.

If `.titan/` already exists after the sibling Titan checkout changes, run
`make toolchain-refresh` before rebuilding so the isolated compiler modules and
static providers match that checkout.

The complete local gate builds the server and extension, runs Titan and
JavaScript tests plus the Extension Host smoke test, queries the native server
through the Codex adapter, packages the VSIX, checks its contents, validates the
Codex plugin metadata, and inspects native linkage:

```sh
make verify
```

On a headless Linux machine, run the Extension Host under a virtual display:

```sh
xvfb-run -a make verify
```

GitHub CI runs that gate directly on the same Ubuntu 24.04
`ubicloud-standard-2` runners used by Titan. Because both repositories are
private, the vscode-titan repository must define an Actions secret named
`SSH_PRIVATE_KEY`; its public half must be registered as a read-only deploy key
in `mascarenhas/titan`.

Use `make help` for focused targets. In particular, `make server-test` runs the
native Titan suite and `make extension-test` runs the extension unit tests. A
successful compilation by itself is not a successful test run.

To measure the production server against this repository's saved Titan source,
including cold-index wall/CPU time, peak RSS, request responsiveness, and an
unchanged refresh, run:

```sh
node scripts/benchmark-server.mjs --server bin/titan-language-server
```

The benchmark defaults to the extension's `debug` server-emission level so its
numbers represent normal VS Code use. Pass `--log-level off` only when measuring
the lower bound without structured-log overhead.

## Run the extension during development

1. Open this repository in VS Code.
2. Run `make server npm-ci` in a terminal.
3. Press F5 and choose **Run Titan Extension**.
4. In the Extension Development Host, open a folder containing saved `.titan`
   files.

By default the extension launches its packaged `bin/titan-language-server` once
per workspace folder. These settings can override discovery:

- `titan.languageServer.path`: absolute path, or a path relative to the
  workspace folder.
- `titan.languageServer.arguments`: extra process arguments.
- `titan.languageServer.logLevel`: structured server diagnostics written to
  stderr (`off`, `error`, `info`, `debug`, or `trace`; default `debug`).
- `titan.compiler.luaPath`: optional `LUA_PATH` override for compiler modules.
- `titan.compiler.luaCPath`: optional `LUA_CPATH` override for native Lua
  dependencies.

Empty compiler path settings preserve the extension host's environment and
Lua's compiled defaults. A packaged server still needs a compatible Titan
compiler installation at runtime. Compatibility requires both the matching
Titan ABI and `titan-compiler.driver.LANGUAGE_SERVER_API_VERSION == 3`; API 3
includes the compiler's typed semantic metadata, incremental-analysis hooks,
C-header dependency restat contract, and the resolver-scoped I/O strategy with
named completed-module yield checkpoints. The ABI alone is not the
language-server API contract. If the compiler is not in the compiled defaults,
configure both paths explicitly. `LUA_CPATH` must include
both the Titan library-versioned provider directory (for example
`/opt/titan/lib/titan/0.6/?.so`) and the Lua native module directory (for
example `/opt/titan/lib/lua/5.5/?.so`). This runtime discovery requirement is
separate from the native executable's static standard-library linkage.

In Remote SSH, WSL, or container workspaces, the workspace extension and native
server run on that remote host. The client maps the workspace's remote URI
scheme to that host's `file:` paths at the stdio boundary and maps returned
project locations back to the original remote scheme and authority.

A workspace root opened through a directory symlink is resolved once for the
server's working directory and protocol paths; returned project locations are
mapped back to the lexical workspace URI. In a nested multi-root workspace,
VS Code's most-specific workspace folder exclusively owns semantic requests for
its documents.

While the server builds or refreshes saved-file project state, VS Code shows a
busy **Titan indexing N/M files** language-status item for that workspace
folder once the active saved-file workset is known. It disappears when the
generation is ready. An indexing failure remains visible as an error and opens
the language-server output when selected. Read-only language features stay
responsive during indexing and return their ordinary empty result until an
initial generation is available.

### Language-server diagnostics and protocol tracing

Run **Titan: Show Language Server Output** from the Command Palette to reveal
the shared log. Every server and client record is prefixed with its workspace
folder in a multi-root window. Server stderr is structured and routed at its
declared severity; malformed or unstructured stderr remains an error. The
extension launches the server with `debug` emission by default, so the **Titan
Language Server** output channel's VS Code log-level selector is the only
control needed to switch between normal and debug output. The channel still
filters records without restarting the server. To collect trace records, first
set
`titan.languageServer.logLevel` to `trace`, which restarts each affected server,
then set the output channel to Trace. Explicit `off`, `error`, `info`, `debug`,
and `trace` emission overrides remain available when reducing server-side work
or collecting deeper diagnostics.

Indexing always emits an `indexing.chain.start` record and a paired
`indexing.chain.complete` record, including the trigger, pass count, generation,
wall time, and CPU time. Starts and successful terminals are Info; failed
terminals are Error. Debug adds scan/analysis phase records and one bounded
`compiler.module.complete` checkpoint after each source module the compiler has
fully published. A graph generation counts project-graph changes; it is not a
refresh-pass counter.

Client/server protocol tracing is separately opt-in and does not restart the
server. Set `titan.trace.server` to `messages` for message summaries, or
to `verbose` for full payloads. Both modes write to the same per-workspace-
prefixed output channel; `verbose` traces can include source text and other
workspace data. Restore the setting to `off` after collecting a trace.

### Project configuration

An optional `titan-config.lua` at the workspace root assigns configuration
values as globals. Relative paths are resolved from that root:

```lua
source_modules_root = "src"
binary_modules_root = ".titan/lib/titan/0.6"
extra_ffi_include_dirs = { "include", "vendor/include" }
```

All fields are optional. The source root defaults to the workspace root, the
binary root defaults to the compatible compiler installation, and the FFI
include list defaults to empty. Unknown fields and returned values are
rejected. Configuration runs in an otherwise empty Lua environment, so it can
assign these values but cannot write unframed bytes to the language server's
stdout or mutate compiler state.

Project discovery intentionally ignores symlinked files and directories below
the configured source root in version 1. This keeps project identity and the
watch set inside the resolved source tree; use ordinary files/directories for
project modules. This restriction does not prohibit opening the workspace root
itself through a symlink, as described above.

## Package and install the VSIX

```sh
make package
make install-vsix
# Equivalent direct VS Code CLI installation:
code --install-extension .build/vsix/titan-linux-x64.vsix --force
```

The package is named for and tagged with its native target, for example
`.build/vsix/titan-linux-x64.vsix`. Build it separately on each target platform;
this repository does not cross-compile native server binaries. The Makefile
rejects a `VSIX_TARGET` that would merely relabel the host-built executable.
Linux packages also inherit the build host's glibc baseline. Build distributable
artifacts on the oldest supported Linux baseline. `make inspect-server` reports
the maximum imported GLIBC symbol version; release CI additionally sets
`TITAN_MAX_GLIBC_VERSION` so a newer requirement cannot silently raise the
supported baseline.

To install only the server under a custom prefix:

```sh
make install-server INSTALL_PREFIX="$HOME/.local"
```

The VSIX includes this project's license plus Titan/native and bundled
JavaScript dependency notices. A server-only installation includes this
project's license and the Titan/native notices under
`share/doc/titan-language-server` in the selected prefix; it contains no
bundled JavaScript dependencies.

## Version 1 behavior

Semantic requests use files saved on disk. Unsaved editor buffers are not
silently compiled. Completion, foreign-definition navigation, navigation into
external source modules, and watching external source trees are outside the
first-version scope.

Hover presents a named declaration signature, including parameter names, for
functions, methods, associated functions, and supported foreign callables.
Function-valued variables retain their bare function type. Record, union, and
interface hovers summarize the members visible at that occurrence; module
hovers summarize visible top-level members without recursively expanding
nominal types. These summaries are normalized and cached with the immutable
semantic index rather than rebuilt by individual hover requests.

A read-only request starts a shared saved-file refresh without waiting. Before
the initial index is ready it returns the feature's ordinary empty result; an
unchanged background revalidation can serve the immutable completed generation.
A watcher hint classified as a saved-project change makes that preceding
generation ineligible until the changed saved state has been checked. A known
compiler/configuration failure remains authoritative during retry. Rename always
waits for the stable newest generation and revalidates disk state after
preflight.

A saved module rejected by the compiler has no semantic data for that
generation, but it does not prevent independently valid project modules from
forming the immutable semantic view.

Server stdout is reserved exclusively for `Content-Length`-framed JSON-RPC.
Diagnostics and debug logs go to stderr.

For the repository-local Codex skill, its deterministic query command, and
compiler search-path setup, see [docs/codex.md](docs/codex.md). Development
scope and milestones are recorded in
[the bootstrap plan](https://github.com/mascarenhas/vscode-titan/blob/main/.agents/plans/bootstrap.md).
