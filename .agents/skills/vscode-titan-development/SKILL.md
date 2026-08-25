---
name: vscode-titan-development
description: Build, test, review, and package the vscode-titan extension and its standalone Titan language server. Use for this repository's LSP protocol, compiler bridge, project cache, editor client, syntax grammar, packaging, or GitHub Project workflow.
---

# vscode-titan development

Treat [../../plans/bootstrap.md](../../plans/bootstrap.md) and
[Titan issue #91](https://github.com/mascarenhas/titan/issues/91) as the scope
contract. Use GitHub Project 2 as the live Kanban record.

## Establish the environment

Read the sibling `../titan/.agents/skills/titan-programmer/SKILL.md` before any
Titan source work. Add `titan-tester`, `titan-async`, `titan-ffi`, or
`titan-pegs` when their boundaries apply. Use this repository's `.titan/bin`
toolchain and its installed Lua paths; do not silently compile with an ambient
Titan installation.

Before changing code, identify the board issue that owns the work and its
acceptance criteria. If the unit is still broad, split it into board-sized
issues and record dependencies before implementation.

## Preserve the runtime boundary

The deliverable is one native language-server executable over stdio. Select the
static Titan standard-library provider so the server carries the Titan runtime,
embedded Lua, and configured native dependencies.

The compiler is different: it remains external Lua source and must load normally
from the embedded Lua state's `package.path` through `lua.require`.
Export the embedded Lua C API from the executable so compiler dependencies on
`package.cpath` bind to the same state; on ELF builds this requires the
executable-export linker flag. Keep that dynamic boundary narrow:

1. require the reviewed compiler module;
2. cast the module or AST once to string/integer-keyed maps;
3. validate required fields and tags;
4. construct typed Titan records/unions;
5. keep `value` out of the rest of the server.

Test missing, incompatible, and malformed compiler modules as startup/project
errors. Do not solve discovery by embedding the compiler into the executable.

## Keep the protocol reusable

- Put all language semantics in the Titan server; the Node extension is a thin
  launcher/client.
- Reserve stdout for `Content-Length` framed JSON-RPC. Log only to stderr.
- Treat JSON byte lengths, LSP UTF-16 positions, and URI/path conversion as
  explicit boundaries with focused tests.
- Advertise only implemented capabilities.
- V1 semantics come from saved disk files. Open/change notifications may affect
  user messaging, but their text is not compiler input.
- Attach project generations to asynchronous work and discard stale results.

## Project and cache rules

Match `titanc --tree` module discovery, including folder modules. Keep one
shared graph with complete annotated ASTs for project modules and only
manifest and exact filesystem provenance metadata for external source and
binary modules. Compiler-observed C-header dependency closures are metadata,
not retained external ASTs.

Project watchers cover `.titan` creation, changes, and deletion. They never
watch external trees. Revalidate an encountered external import from its exact
source/provider provenance, including ordered C-header bytes and include-search
candidates where applicable. Propagate invalidation through immediate importers
only when a module's public manifest changed; stop when it did not.

Definition navigation stays inside project source and excludes foreign
declarations. Completion and unsaved-buffer semantics remain out of scope.

## Verification and delivery

Keep tests beside the layer they prove:

- Titan unit tests for JSON, framing, positions, typed AST conversion, graph
  behavior, and feature queries;
- Titan transcript/integration tests for the compiled server;
- JavaScript unit tests for client options, executable resolution, and manifest
  wiring;
- extension-host smoke tests for activation and process lifecycle.

Use focused gates during development and the Makefile's complete gate before
delivery. For a direct focused `titanc` invocation, copy `src/` to a temporary
source stage first; using the working tree itself as `--tree` can emit generated
`.c`/`.o` files beside the authored Titan modules. Inspect the VSIX contents and
the executable's native dependencies.
Update Project status/priority/size with `gh`, then stage exact paths and commit
to `main` only when the owned acceptance criteria are satisfied.

If the compiler needs changes, work in a new branch under `../titan`, preserve
its existing compiler behavior for `titanc`, run its own focused and broad
tests, and defer its PR until the extension/server work is wrapped.
