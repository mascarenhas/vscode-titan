# Codex Plugin and Query Client

Codex and the VS Code extension share the same native `titan-language-server`
executable. This repository exposes saved-file queries to Codex through the
repository marketplace `vscode-titan`
([`.agents/plugins/marketplace.json`](../.agents/plugins/marketplace.json)) and
the skills-only plugin `titan-lsp` (`plugins/titan-lsp`). Its bundled
`titan-lsp-query` skill runs a deterministic stdio client directly.

## Install the executable and environment

Build and install the standalone server on the `PATH` that Codex inherits:

```sh
make server
make install-server INSTALL_PREFIX="$HOME/.local"
command -v titan-language-server
```

Point the Codex environment at the matching installed Titan SDK:

```sh
export TITAN_ROOT='/opt/titan'
export TITAN_LS_LUA_PATH='/opt/titan/share/lua/5.5/?.lua;/opt/titan/share/lua/5.5/?/init.lua'
export TITAN_LS_LUA_CPATH='/opt/titan/lib/lua/5.5/?.so'
```

See [installing and compiler discovery](language-server.md#installing-and-compiler-discovery)
for default search paths, verbatim Lua path rules, and `--print-paths`.

## Install the repository plugin

Register this repository's marketplace and install the plugin:

```sh
codex plugin marketplace add /absolute/path/to/vscode-titan
codex plugin add titan-lsp@vscode-titan
```

Start a new Codex thread after installation so Codex discovers the skill. See
OpenAI's [Build plugins](https://developers.openai.com/plugins/build/plugins)
documentation for the plugin workflow. Run `make plugin-validate`
([`scripts/validate-plugin.mjs`](../scripts/validate-plugin.mjs)) to check
marketplace, plugin, and skill metadata.

To uninstall:

```sh
codex plugin remove titan-lsp@vscode-titan
codex plugin marketplace remove vscode-titan
```

## Query client (`titan-lsp-query.mjs`)

[`plugins/titan-lsp/skills/titan-lsp-query/scripts/titan-lsp-query.mjs`](../plugins/titan-lsp/skills/titan-lsp-query/scripts/titan-lsp-query.mjs)
launches `titan-language-server` from `PATH` (or `--server PATH`, with optional
repeatable `--server-arg VALUE`), waits for the initial saved-file index, runs
one query, shuts the server down, and prints one JSON object to stdout. Server
logs remain on stderr.

```sh
node plugins/titan-lsp/skills/titan-lsp-query/scripts/titan-lsp-query.mjs \
  definition --root /absolute/project --file src/main.titan \
  --line 12 --character 8
```

- **Root and SDK trust:** `--root` sets the LSP workspace folder and server
  working directory. Because the client sends no `initializationOptions`, a root
  using `compiler_root` requires `TITAN_LS_TRUSTED_ROOTS` in the environment
  (see [per-root SDK selection and trust](language-server.md#per-root-sdk-selection-and-trust)
  and [`SKILL.md`](../plugins/titan-lsp/skills/titan-lsp-query/SKILL.md)).
- **Operations and coordinates:** `definition`, `references`, and `hover`
  require zero-based LSP `--line` and UTF-16 `--character` offsets; `folding`
  requires only `--root` and `--file`; `rename-preview` also requires
  `--new-name` and returns a `WorkspaceEdit` with `applied: false` without
  modifying disk files.
- **Saved inputs:** Answers come from saved files on disk; save files before
  querying.
- **Timeouts:** `--timeout-ms` bounds each startup, frame, or exit wait (default
  `300000` ms, range `100`–`600000` ms).

### Managed Codex sandboxes

On managed Codex hosts, invoke the read-only client with
`sandbox_permissions: "require_escalated"` on the first attempt. Node creates
child stdio as Unix socket pairs, and the workspace sandbox blocks the
socket-kind check libuv uses to distinguish protocol pipes from unsupported
handles. Inside the sandbox, Titan's runtime fails with `stdio.parent.kind`
before LSP startup; do not retry inside the sandbox. Escalation covers only the
read-only query command.

On Windows, Node cannot deliver a catchable `SIGTERM` to the client, so forced
termination may skip the `interrupted` JSON envelope; the server exits when its
parent-owned stdio closes.

### Error codes and exit status

On failure, `titan-lsp-query.mjs` writes
`{"ok": false, "error": {"code": ..., "message": ...}}` to stdout and exits
nonzero (exit code `1` unless noted):

| Code | Exit | Meaning |
| --- | --- | --- |
| `invalid_arguments` | `2` | Malformed or missing CLI arguments |
| `invalid_input` | `2` | Inaccessible or invalid root, `.titan` file, position, or new name |
| `server_start` | `1` | Failed to spawn the language server |
| `server_exit` | `1` | Write to server failed, or server exited nonzero or by signal |
| `timeout` | `1` | Startup, protocol frame, or exit wait exceeded `--timeout-ms` |
| `protocol_error` | `1` | Malformed or oversized frame, invalid JSON, unexpected response ID, or invalid `titan/indexingStatus` sequence |
| `indexing_failed` | `1` | Server reported failed initial indexing |
| `lsp_error` | `1` | Server returned an LSP error (adds integer `lspCode` when provided) |
| `interrupted` | `130` / `143` | Stopped after `SIGINT` (`130`) or `SIGTERM` (`143`) |
| `query_failed` | `1` | Any other unexpected error |

`make codex-native-test`
([`scripts/test-codex-native.mjs`](../scripts/test-codex-native.mjs)) tests the
client against the built server;
[`src/test/unit/codexAdapter.test.ts`](../src/test/unit/codexAdapter.test.ts)
covers argument validation, timeouts, interruption, and cleanup.
