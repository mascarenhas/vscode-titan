---
name: titan-lsp-query
description: Query saved Titan project files for definitions, references, hover, folding, and rename previews through the standalone Titan language server. Use for read-only Titan code intelligence; do not use it to modify source files.
---

# Titan LSP query

Use the deterministic client at
`scripts/titan-lsp-query.mjs`, resolved relative to this `SKILL.md`. It launches
`titan-language-server` from `PATH`, waits for its initial saved-file index,
performs one query, shuts the server down, and writes one JSON object to stdout.
Server and client diagnostics remain on stderr.

The standalone server defaults to `./?.lua` and `./?.so`; the skill does not
carry compiler modules. Unless matching modules are deliberately present in
the project root, pass complete Lua 5.5 module trees from the same Titan build
in the query process environment, for example:

```sh
export TITAN_LS_LUA_PATH='/opt/titan/share/lua/5.5/?.lua;/opt/titan/share/lua/5.5/?/init.lua'
export TITAN_LS_LUA_CPATH='/opt/titan/lib/lua/5.5/?.so'
```

Use the actual compatible installation prefix; do not append `;;` or rely on
ambient `LUA_PATH` and `LUA_CPATH` expansion. Keep these variables in the
environment used for every query command.

Run it with an absolute project root and a project `.titan` file:

```sh
node <this-skill-directory>/scripts/titan-lsp-query.mjs definition \
  --root /absolute/project --file src/main.titan --line 12 --character 8
```

On managed Codex hosts, run this read-only client with
`sandbox_permissions: "require_escalated"` on the first attempt. Node exposes
child stdio as Unix socket pairs, while the workspace sandbox blocks the
socket-kind inspection required by libuv; the server would otherwise fail with
`stdio.parent.kind` before LSP startup. Do not retry inside the sandbox. This
escalation authorizes only the query command and does not authorize source
changes.

The operations are:

- `definition`, `references`, and `hover`: require zero-based LSP `--line` and
  UTF-16 `--character` values.
- `folding`: requires only `--root` and `--file`.
- `rename-preview`: also requires `--new-name`; it returns the server's
  `WorkspaceEdit` with `applied: false` and never changes files.

Titan V1 semantics always come from disk. Ask the user to save relevant files
before querying. Treat a returned rename edit as a preview; apply it only in a
separate, explicitly authorized source-editing step.

The server is a router: it serves one LSP session and starts one worker per
Titan root. One executable serves every SDK — a root's `compiler_root` selects
the prefix that worker loads — so the compiler Lua modules and SDK do not have
to match the server's own build. What is still fixed is the C support table the
executable links: an SDK whose compiler calls a support function that build
lacks fails that root with a clear error, and the fix is a server built from a
matching SDK. API version `1` is held constant during prerelease development; it
is not evidence that two arbitrary compiler revisions are interchangeable.

Loading a selected SDK executes its code, so a root that sets `compiler_root` is
only honoured when it is trusted. This query client sends no
`initializationOptions`, so export `TITAN_LS_TRUSTED_ROOTS` (an OS path list)
when the queried slice selects its own prefix; otherwise that root fails with an
error naming the root, the setting and the trust option, and no fallback SDK is
loaded.

Derive the UTF-16 `--line` and `--character` values from the saved text before
each query; never reuse positions computed against an earlier revision of the
file. Foreign type metadata can contribute hover information, but FFI definition
navigation remains outside V1's scope.

A warm workspace can serve saved SQL facts before background compiler-manifest
restoration finishes. Query readiness does not measure complete restoration;
use the repository's startup benchmark for cold/warm analysis regressions.

The native server defaults its C probe prefix to `<workspace>/.titan-ls`, the
SQLite directory. A nonempty inherited `TITAN_PREFIX` overrides only the probe
prefix, and then a router session gives each root its own
`<TITAN_PREFIX>/roots/<digest>` namespace, because probe results depend on that
root's SDK headers and flags. The VS Code extension uses the same default; it
does not supply a workspace-storage prefix. Preserve an explicit override when
reproducing a query, and use a fresh override only for a deliberately isolated
measurement.
