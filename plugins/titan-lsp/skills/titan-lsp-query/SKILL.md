---
name: titan-lsp-query
description: Query saved Titan project files for definitions, references, hover, folding, and rename previews through the standalone Titan language server. Use for read-only Titan code intelligence; do not use it to modify source files.
---

# Titan LSP query

Use the deterministic client at
`scripts/titan-lsp-query.mjs`, resolved relative to this `SKILL.md`. It launches
`titan-language-server` from `PATH`, performs one saved-file query, shuts the
server down, and writes one JSON object to stdout. Server and client diagnostics
remain on stderr.

Run it with an absolute project root and a project `.titan` file:

```sh
node <this-skill-directory>/scripts/titan-lsp-query.mjs definition \
  --root /absolute/project --file src/main.titan --line 12 --character 8
```

The operations are:

- `definition`, `references`, and `hover`: require zero-based LSP `--line` and
  UTF-16 `--character` values.
- `folding`: requires only `--root` and `--file`.
- `rename-preview`: also requires `--new-name`; it returns the server's
  `WorkspaceEdit` with `applied: false` and never changes files.

Titan V1 semantics always come from disk. Ask the user to save relevant files
before querying. Treat a returned rename edit as a preview; apply it only in a
separate, explicitly authorized source-editing step.
