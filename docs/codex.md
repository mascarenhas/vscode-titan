# Connect Codex to the Titan language server

Codex and the VS Code extension use the same native language-server
executable. The repository exposes saved-file queries to Codex through the
repository marketplace `vscode-titan` (`.agents/plugins/marketplace.json`) and
the skills-only plugin `titan-lsp` (`plugins/titan-lsp`). Its bundled
`titan-lsp-query` skill runs a deterministic stdio client instead of relying
on plugin-manifest language-server registration.

## Install the executable

From this repository:

```sh
make server
make install-server INSTALL_PREFIX="$HOME/.local"
command -v titan-language-server
```

Put `$HOME/.local/bin` on the `PATH` that Codex inherits. A standalone server
carries no compiler modules; see the
[README](../README.md#standalone-server) for its default search paths. Unless
compatible modules are in the project root, start Codex with complete
templates for the same Titan installation the server was built against:

```sh
export TITAN_LS_LUA_PATH='/opt/titan/share/lua/5.5/?.lua;/opt/titan/share/lua/5.5/?/init.lua'
export TITAN_LS_LUA_CPATH='/opt/titan/lib/lua/5.5/?.so'
```

The server uses these values verbatim, without `;;` expansion.

## Install the repository plugin

The marketplace lives in this repository rather than in Codex's implicit
personal marketplace, so add the repository root explicitly:

```sh
codex plugin marketplace add /absolute/path/to/vscode-titan
codex plugin add titan-lsp@vscode-titan
```

Start a new Codex thread after installation so the skill is discovered. See
OpenAI's [Build plugins](https://developers.openai.com/plugins/build/plugins)
documentation for the current plugin workflow. `make plugin-validate`
(`scripts/validate-plugin.mjs`) checks the marketplace, plugin and skill
metadata.

To remove the integration:

```sh
codex plugin remove titan-lsp@vscode-titan
codex plugin marketplace remove vscode-titan
```

## Query client

`plugins/titan-lsp/skills/titan-lsp-query/scripts/titan-lsp-query.mjs`
launches `titan-language-server` from `PATH`, or the executable named by
`--server`, with extra `--server-arg` values. It waits for the initial
saved-file index, performs one query, shuts the server down and writes one JSON
object to stdout. To test it directly from this checkout:

```sh
node plugins/titan-lsp/skills/titan-lsp-query/scripts/titan-lsp-query.mjs \
  definition --root /absolute/project --file src/main.titan \
  --line 12 --character 8
```

- `--root` is the Titan project root. The client uses it as the LSP workspace
  and the server's working directory.
- `definition`, `references` and `hover` need `--line` and `--character`:
  zero-based LSP coordinates, with characters counted in UTF-16 code units.
  `folding` needs only `--root` and `--file`.
- `rename-preview` also needs `--new-name`. It returns the server's
  `WorkspaceEdit` with `applied: false` and never changes files.
- `--timeout-ms` bounds each wait for startup, a protocol frame or exit
  (default 300,000 ms, between 100 and 600,000 ms).
- A failure prints `{"ok": false, "error": {"code": ..., "message": ...}}` and
  exits nonzero, with exit code 1 unless noted. These are all the codes that
  `titan-lsp-query.mjs` raises:
  - `invalid_arguments` (exit 2): malformed command-line arguments.
  - `invalid_input` (exit 2): an inaccessible or invalid root, file, position
    or new name.
  - `server_start`: the server could not be spawned.
  - `server_exit`: writing to the server failed, or it exited with a nonzero
    code or a signal.
  - `timeout`: a startup, frame or exit wait exceeded `--timeout-ms`.
  - `protocol_error`: a malformed or oversized frame, invalid JSON, an
    unexpected message or response id, or an invalid `titan/indexingStatus`
    sequence.
  - `indexing_failed`: the server reported failed indexing.
  - `lsp_error`: the server answered with an LSP error. The JSON object adds
    `lspCode` when the server supplied an integer code.
  - `interrupted` (exit 130 for SIGINT, 143 for SIGTERM): the client stopped
    the server after a signal.
  - `query_failed`: any other unexpected failure.

Answers come from saved files on disk, so save files before you query them.
Server logs go to stderr. The client consumes the server's framed stdout and
reserves its own stdout for the final JSON result.

On managed Codex hosts, run the read-only client with
`sandbox_permissions: "require_escalated"` on the first attempt. Node gives the
child Unix socket pairs for stdio, and the workspace sandbox blocks the
socket-kind inspection that libuv uses to tell protocol pipes from unsupported
handles. Inside the sandbox, Titan's runtime fails with `stdio.parent.kind`
before LSP startup, so do not retry there. The escalation covers only the
query command; it does not authorize source changes.

On Windows, Node cannot deliver a catchable `SIGTERM` to the client. A forced
termination therefore cannot promise the `interrupted` JSON result. The server
still exits when its parent-owned stdio closes.

`make codex-native-test` (`scripts/test-codex-native.mjs`) runs the client
against the built server. `src/test/unit/codexAdapter.test.ts` covers argument
validation, timeouts, interruption and cleanup.
