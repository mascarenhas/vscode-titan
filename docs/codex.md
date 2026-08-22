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

The executable contains the statically selected Titan standard library,
embedded Lua interpreter, and selected native dependencies. It does **not**
contain the Titan compiler. The embedded Lua state loads the ordinary
`titan-compiler` Lua modules through `package.path` and native compiler
dependencies through `package.cpath`.

A server built by this repository's project-local toolchain already has that
toolchain's `.titan` Lua paths as its compiled defaults. If the compiler is in a
different installation, start Codex with `LUA_PATH` and `LUA_CPATH` that select
the ABI-compatible compiler installation. Preserve Lua's defaults with the
terminal `;;`, for example:

```sh
export LUA_PATH='/opt/titan/share/lua/5.5/?.lua;/opt/titan/share/lua/5.5/?/init.lua;;'
export LUA_CPATH='/opt/titan/lib/titan/0.26/?.so;/opt/titan/lib/lua/5.5/?.so;;'
```

Replace `0.26` and `5.5` with the ABI and Lua versions used to build the
server. The Titan ABI entry is also how the server discovers the default
binary-module root; the Lua entry supplies native compiler dependencies.

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
  must also export `LANGUAGE_SERVER_API_VERSION = 3`; API 3 includes the typed
  metadata, incremental-analysis hooks, C-header dependency restat contract,
  and resolver-scoped I/O strategy with checked-module yield sequencing used
  here. The Titan ABI alone does not promise that surface.

To remove the integration, use the ordinary Codex plugin commands:

```sh
codex plugin remove titan-lsp@vscode-titan
codex plugin marketplace remove vscode-titan
```
