# vscode-titan agent guidance

This repository contains the VS Code extension and the standalone language
server for Titan. Titan issue
[mascarenhas/titan#91](https://github.com/mascarenhas/titan/issues/91) is the
scope authority for the first version. The durable implementation plan is
`.agents/plans/bootstrap.md`.

## Load Titan guidance before editing Titan

The sibling Titan checkout is `../titan`. Before writing or reviewing any
`.titan` file, read its `.agents/skills/titan-programmer/SKILL.md` completely.
Also read the matching specialist skill when the work touches it:

- `titan-tester` for Titan tests;
- `titan-async` for tasks, cancellation, files, watchers, or runtime ownership;
- `titan-ffi` for `import "lua"`, compiler Lua modules, or C boundaries;
- `titan-pegs` for protocol or source parsers.

Use the repository-local `.agents/skills/vscode-titan-development/SKILL.md` for
work that changes the server, extension, protocol, build, tests, packaging, or
project workflow.

## Product invariants

- The language server is written in Titan and runs out of process over stdio.
- The server build produces one native executable. Its Titan standard library,
  embedded Lua interpreter, and selected native dependencies are linked through
  Titan's static-provider path.
- The Titan compiler is not embedded in that executable. The embedded Lua loads
  the ordinary compiler Lua modules through `package.path` and
  `lua.require`.
- The executable must export the embedded Lua C API so ordinary compiler
  dependencies loaded through `package.cpath` can bind to that same Lua state.
- Stdout is exclusively for LSP framing. Diagnostics and debug logs go to
  stderr.
- Version 1 computes semantics from saved files on disk. Do not silently add
  unsaved-buffer semantics.
- Completion, FFI-definition navigation, external-source navigation, and
  watching external source trees are out of scope for version 1.
- Convert compiler-owned Lua tables into typed Titan records/unions at a narrow
  boundary. Do not spread untyped `value` maps through the server.
- Cache complete annotated ASTs only for project modules. External source and
  binary modules retain manifests/mtimes only.

## Toolchain and verification

Titan is not publicly released. Keep its language-server API version at `1`
until the first public release; update the compiler and its consumers together
without incrementing that API version during prerelease development.

The project owns an isolated Titan installation at `.titan/`; it is ignored by
Git. Prefer `.titan/bin/titanc`, `.titan/bin/lua`, and
`.titan/bin/luarocks` over ambient installations. Keep the package lockfile
checked in and use `npm ci` for reproducible JavaScript installs.

Tests live with their implementation:

- Titan unit and protocol tests exercise the server, framing, cache,
  invalidation, and language features.
- JavaScript unit tests exercise extension configuration and process launch.
- Extension-host smoke tests exercise activation and client/server wiring.

Run the focused tests while iterating and the complete documented gate before
committing. A passing compile alone is not a passing test.

## Work tracking and delivery

GitHub Project 2, `Titan VSCode Extension`, is the Kanban source of truth.
Create board-sized issues rather than treating each broad feature as one task;
record dependencies and acceptance criteria in each issue. Keep item status,
priority, and size current with `gh project` commands.

The direct-commit allowance applied only during the repository's initial
development and is now retired. Work in a focused branch, inspect the worktree,
stage exact paths, verify the intended commit, and open a PR after the owned
acceptance criteria pass. Leave the PR open for maintainer review. Do not merge
it or commit or push directly to `main` unless the maintainer explicitly
authorizes that exact action.

If compiler changes become necessary, make them in a new branch in `../titan`;
do not mix them into this repository, and open the Titan PR only after the
extension/server work is wrapped and locally verified. Leave that PR open for
maintainer review as well; opening it does not authorize merging it.
