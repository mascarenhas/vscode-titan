# Connect Codex to the Titan language server

Codex and the VS Code extension use the same native language-server executable.
The repository exposes saved-file queries to Codex through the repo-local
`vscode-titan` marketplace and the skills-only `titan-lsp` plugin. Its bundled
`titan-lsp-query` skill runs a deterministic stdio client instead of relying on
an unsupported plugin-manifest language-server registration.

## Build and install the executable

From this repository:

```sh
make server-test server
make install-server INSTALL_PREFIX="$HOME/.local"
```

Ensure `$HOME/.local/bin` is on the `PATH` inherited by Codex, then verify:

```sh
command -v titan-language-server
```

The executable contains the selected statically linked Titan runtime modules,
embedded Lua interpreter, and selected native dependencies. Each initialized
statically linked module registers its runtime opener in `package.preload`.
Separately, the executable embeds a metadata-only inventory of all SDK-selected
canonical Titan standard-module interfaces. Compiler language-server API 1
validates and decodes this inventory and its build target's C type profile for project
typechecking; it is not module code, a Titan provider archive, headers, or an
SDK payload.

The executable does **not** contain the Titan compiler. The embedded Lua state
loads the ordinary `titan-compiler` Lua modules through `package.path` and native
compiler dependencies through `package.cpath`.

`make install-server` installs the standalone executable and its notices, not
the VSIX's private compiler module trees. At startup the server replaces ambient
Lua discovery with `./?.lua` and `./?.so`. Unless compatible modules are in its
working directory, start Codex with complete `TITAN_LS_LUA_PATH` and
`TITAN_LS_LUA_CPATH` templates, for example:

```sh
export TITAN_LS_LUA_PATH='/opt/titan/share/lua/5.5/?.lua;/opt/titan/share/lua/5.5/?/init.lua'
export TITAN_LS_LUA_CPATH='/opt/titan/lib/lua/5.5/?.so'
```

Replace `5.5` with the Lua ABI version used to build the server. These variables
are passed directly to `package.path` and `package.cpath`; they do not use the
ambient `LUA_PATH`/`LUA_CPATH` defaults or terminal-`;;` expansion.

The target-specific VSIX handles this automatically: it carries
`dist/titan/share/lua/5.5` and `dist/titan/lib/lua/5.5`, and the extension passes
absolute templates for those private trees to its server process. That
self-contained VSIX behavior does not change the standalone installation
contract above. Those exact trees are the complete bundled compiler-module
payload: the VSIX does not add `lib/titan`, a provider archive, Titan headers,
or any other native SDK content.

## Install the repository plugin

The marketplace file is `.agents/plugins/marketplace.json`. Because this is a
repository marketplace rather than Codex's implicit personal marketplace, add
the repository root explicitly:

```sh
codex plugin marketplace add /absolute/path/to/vscode-titan
codex plugin add titan-lsp@vscode-titan
```

Start a new Codex thread after installation so the bundled skill is discovered.
See OpenAI's
[Build plugins](https://developers.openai.com/plugins/build/plugins)
documentation for the current Codex plugin workflow.

When a definition, reference, hover, folding, or rename-preview request applies
to saved Titan source, Codex can use the skill's
`scripts/titan-lsp-query.mjs`. The script launches `titan-language-server` from
`PATH`, waits for the initial saved-file index, performs one query, shuts it
down, and emits one JSON object on stdout.
For direct development testing from this checkout:

```sh
node plugins/titan-lsp/skills/titan-lsp-query/scripts/titan-lsp-query.mjs \
  definition --root /absolute/project --file src/main.titan \
  --line 12 --character 8
```

On managed Codex hosts, an agent must run this read-only command with
`sandbox_permissions: "require_escalated"` on its first attempt. Node presents
child stdio as Unix socket pairs, while the workspace sandbox blocks the
socket-kind inspection libuv uses to distinguish protocol pipes from
unsupported handles; the server would otherwise fail with
`stdio.parent.kind` before LSP startup. It should not retry inside the sandbox.
This is a command-sandbox compatibility requirement and does not authorize
source-file writes.

Line and character values use zero-based LSP coordinates; characters count
UTF-16 code units. The `rename-preview` operation requires `--new-name` and
returns a `WorkspaceEdit` with `applied: false`. It never changes source files.

## Protocol and workspace expectations

- Pass the Titan project root as `--root`; the script uses it as the LSP
  workspace and server working directory.
- Stdout belongs exclusively to `Content-Length`-framed JSON-RPC; server logs
  go to stderr internally. The adapter consumes those frames and reserves its
  own stdout for the final JSON result.
- Version 1 derives semantic answers from saved files on disk. Save a file
  before expecting updated definitions, references, rename previews, hover, or
  folding.
- The compiler modules and any native Lua dependencies must be ABI-compatible
  with the embedded Lua/Titan runtime in the executable. The compiler driver
  must also export `LANGUAGE_SERVER_API_VERSION = 1`; API 1 includes the typed
  metadata, checked-project and C-header graph codecs, FFI conversion reuse,
  incremental-analysis hooks, timestamp observations and C-header dependency
  restat contract, resolver-scoped I/O strategy with checked-module yield sequencing,
  bounded graph decoding and cooperative registry assembly, and the
  validated metadata-only embedded-interface resolver used here. The provider's
  validated build target profile supports portable C types and their numeric
  conversions without requiring a C compiler or Titan SDK for reflection
  imports and ordinary semantic analysis. C header imports and native
  compilation still require the configured C toolchain and SDK. The complete
  inventory covers `titan.async`, `titan.coroutine`, `titan.fs`,
  `titan.gc`, `titan.http`, `titan.io`, `titan.iteration`, `titan.json`, `titan.lua`,
  `titan.math`, `titan.net`, `titan.os`, `titan.path`, `titan.peg`, `titan.reflect`,
  `titan.sqlite3`, `titan.ssl`, `titan.string`, `titan.test`, `titan.timer`,
  `titan.url`, `titan.uv`, and `titan.websocket`.
  Current master SDKs also supply `titan.protobuf`, `titan.thread`, and
  `titan.transfer` (26 entries); older release SDKs supply the original 23.
  The Titan ABI alone does not promise that surface.

To remove the integration, use the ordinary Codex plugin commands:

```sh
codex plugin remove titan-lsp@vscode-titan
codex plugin marketplace remove vscode-titan
```
