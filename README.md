# Titan for VS Code

This repository provides the VS Code extension and the standalone stdio
language server for the
[Titan programming language](https://github.com/mascarenhas/titan). The server
is written in Titan (~30,000 lines) and speaks standard `Content-Length`-framed
JSON-RPC over stdio. A bundled, skills-only Codex plugin queries the same
executable; see [Codex Plugin and Query Client](docs/codex.md).

A target-specific VSIX is self-contained for ordinary native and browser
editing: it bundles the statically linked `titan-language-server` executable
(Titan runtime, embedded Lua 5.5, libuv, llhttp, SQLite, and metadata-only
standard interfaces), compatible `titan-compiler` Lua modules, SDK headers, Lua
sources, and the matching browser semantic pack. Running `titan-language-server`
outside VS Code acts as a multi-root router that loads external compiler
modules from an installed Titan SDK.

## Using the VS Code extension

Install a platform VSIX (or build one locally with `make package install-vsix`)
and open any trusted workspace folder containing `.titan` files:

```sh
code --install-extension .build/vsix/titan-linux-x64.vsix --force
```

Out of the box, the extension provides:

- Syntax highlighting for `.titan` files, including `foreign` types and
  unprefixed C types inside `foreign function` declarations.
- Saved-file go-to-definition, references, rename (with shorthand-preserving
  multi-part union rename), folding, hover, and compiler diagnostics in
  **Problems**.
- Unsaved-buffer completion triggered by `.` and `:` (with named callable
  signatures and editable call placeholders) and live hover following edits
  after completion.
- LDoc-style module and declaration documentation in hover and completion, with
  links into the Titan manual.
- Native and browser (`target = "browser"`) typechecking in separate roots of
  one workspace.
- Module-local hover and references for `foreign import` C namespaces (`ffi`).

Projects default to `./src` and `target = "native"`. Add an optional
`titan-config.lua` at the workspace root to customize source roots, C header
search paths, or the browser target:

```lua
-- titan-config.lua (optional global assignments; relative paths resolve from the root)
include = { "./src", "./tests" }
source_module_roots = { "./src", "./tests" }
target = "native" -- or "browser"
extra_ffi_include_dirs = { "./include" }
```

See [Using the Titan VS Code Extension](docs/vscode-extension.md) for all
configuration fields, extension settings, browser roots, remote/multi-root
workspaces, logging, workspace cache management, and Windows notes.

## Using the standalone language server

Build and install the native executable for Neovim, Helix, `omp`, Codex, or
other LSP clients:

```sh
make -j2 server
make install-server INSTALL_PREFIX="$HOME/.local"
```

Because compiler Lua modules stay external to the binary, point the server's
environment at the matching installed Titan SDK:

```sh
export TITAN_ROOT="$HOME/.local/titan"
export TITAN_LS_LUA_PATH="$TITAN_ROOT/share/lua/5.5/?.lua;$TITAN_ROOT/share/lua/5.5/?/init.lua"
export TITAN_LS_LUA_CPATH="$TITAN_ROOT/lib/lua/5.5/?.so"
```

See [Using the Standalone Language Server](docs/language-server.md) for LSP
initialization options, multi-root routing, per-root SDK selection
(`compiler_root` and `trustedRoots`), `omp` multi-worktree setup, and cache
layout.

## Building and developing from source

Building from source requires:

- an installed Titan SDK (`titanc` on `PATH`, or `TITAN_PREFIX` pointing to its
  prefix), including its
  [paired browser semantic pack](docs/native-build.md#paired-browser-semantic-pack)
  for full builds and VSIX packaging (`make server` needs only a native SDK);
- a C toolchain with Titan's native prerequisites;
- GNU Make 4.2 or newer (on macOS, install Homebrew `make` and place its
  `libexec/gnubin` directory first on `PATH`; see
  [SDK selection](docs/native-build.md#sdk-selection));
- Node.js 24 with npm, and VS Code 1.106 or newer.

Build the server and extension and run the test suites:

```sh
make npm-ci
make -j2
make test
```

Run the full local verification gate—including Extension Host smoke tests,
packaging, linkage checks, and plugin validation—with `make verify` (or
`xvfb-run -a make verify` on headless Linux). Pass
`TITAN_PREFIX="$HOME/.local/titan"` to target a specific SDK, and run
`make help` to list every target.

To launch the extension in a VS Code Extension Development Host:

1. Open this repository in VS Code.
2. Run `make server npm-ci` in a terminal.
3. Press F5 and choose **Run Titan Extension**.
4. Open a folder containing saved `.titan` files in the Extension Development
   Host window.

## Documentation

| Document | Covers |
| --- | --- |
| [Using the Titan VS Code Extension](docs/vscode-extension.md) | VSIX installation, editing features, `titan-config.lua`, extension settings, multi-root/symlink/remote workspaces, logs, `.titan-ls` cache, Windows notes |
| [Using the Standalone Language Server](docs/language-server.md) | `titan-language-server` CLI install, compiler discovery, LSP initialization options, multi-root routing, per-root SDKs and trust, `omp` setup, probe cache layout |
| [Codex Plugin and Query Client](docs/codex.md) | Repository marketplace setup, `titan-lsp-query.mjs` one-shot JSON CLI, sandbox escalation, exit codes |
| [*Inside `vscode-titan`*](docs/index.md) | Architecture book: multi-root routing, framing and async concurrency, Lua/C compiler bridge, SQLite indexing, semantic features, completion, native builds, coverage, benchmarks |

Titan issue [mascarenhas/titan#91](https://github.com/mascarenhas/titan/issues/91)
defines the initial scope, and
[the bootstrap plan](https://github.com/mascarenhas/vscode-titan/blob/main/.agents/plans/bootstrap.md)
records its milestones. Contributor and agent rules live in
[AGENTS.md](AGENTS.md).
