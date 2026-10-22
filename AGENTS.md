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

## Documentation map

Each fact has one home. Elsewhere, link to it in one line.

| Topic | Home |
| --- | --- |
| Users: features, build commands, settings, `titan-config.lua`, workspace cache, logging, packaging, Windows limits | `README.md` |
| Make object graph, build profiles, test execution, staging, CI, Windows driver | `docs/native-build.md` |
| Configuration inputs, compiler compatibility, loader and Service composition | `docs/server-data-flow.md` |
| SQLite schema, cache compatibility, header provenance, startup revalidation | `docs/sqlite-backend-storage.md` |
| Completion, hover after completion, TEMP storage and bounds | `docs/completion.md` |
| Declaration documentation | `docs/documentation.md` |
| Multi-part unions and server data-model rules | `docs/union-payload-parts.md` |
| Native line coverage | `docs/coverage.md` |
| Benchmark scripts, measured conclusions, retired evidence records | `docs/benchmarks.md` |
| Codex plugin and query client | `docs/codex.md` |

Documentation rules:

- Describe current behavior, and update the owning page in the same change as
  the code.
- Point to code by path and symbol, never by line number.
- Do not add measurement, audit or research records under `docs/`. Fold their
  durable conclusions into the owning page, and list the record in
  `docs/benchmarks.md#retired-evidence-records` with a permalink.
- Keep every relative Markdown link and anchor valid.

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
- Definition, references, rename, folding and diagnostics use saved disk files.
  Completion uses captured editor buffers, and hover follows them only after
  completion activates private analysis; follow `docs/completion.md`.
- FFI-definition navigation, external-source navigation, and watching external
  source trees remain out of scope.
- Completion captures sessions, versions, contributors and the committed saved
  generation before deferred work. Private preparation reads baseline
  descriptors fenced by that generation without awaiting shared restoration;
  the compiler permit still serializes Lua state. SQL selection reads only
  qualified scalar facts. Only the watcher writes saved facts and caches; never
  promote TEMP data on save.
- Convert compiler-owned Lua tables into typed Titan records/unions at a narrow
  boundary. Do not spread untyped `value` maps through the server.
- Retain declared top-level member/type manifests and exact provenance for
  project modules. Bodies are transient during checking and SQL extraction;
  release them after accepted publication. Reuse unchanged modules' SQL facts.
  External source and binary modules retain manifests/provenance only.

## Toolchain and verification

Titan is not publicly released. Keep its language-server API version at `1`
until the first public release, and update the compiler and its consumers
together without incrementing it.

Consume an installed Titan SDK, selected by `TITAN_PREFIX` or by
`titanc --print-prefix`, and use its compiler, Lua, modules, headers and
providers together. Do not bootstrap a compiler or require a Titan checkout in
consumer builds, and never modify the SDK. Keep the package lockfile checked in
and use `npm ci`. `docs/native-build.md` owns the build profiles, staging rules,
CI and the release-job requirements.

Before changing Make rules or the compiler release, read
`docs/native-build.md` and run `make incremental-build-test`. Keep
source/provider policy consistent within each object graph. Use the ordinary
installed provider, including compiled `titan.test`, without special
test-support compilation or installed test sources. Independent concurrent
builds need separate `BUILD_ROOT` values and, when linking servers, separate
`SERVER` destinations. Add each new native test module to `serverTestShards`
in `scripts/run-server-tests.mjs`.

Tests live with their implementation:

- Titan unit and protocol tests exercise the server, framing, cache,
  invalidation, and language features.
- JavaScript unit tests exercise extension configuration and process launch.
- Extension-host smoke tests exercise activation and client/server wiring.

Run the focused tests while iterating and `make verify` before committing. A
passing compile alone is not a passing test.

## Work tracking and delivery

GitHub Project 2, `Titan VSCode Extension`, is the Kanban source of truth.
Create board-sized issues rather than treating each broad feature as one task;
record dependencies and acceptance criteria in each issue. Keep item status,
priority, and size current with `gh project` commands.

Work in a focused branch, inspect the worktree, stage exact paths, verify the
intended commit, and open a PR after the owned acceptance criteria pass. Leave
the PR open for maintainer review. Do not merge it or commit or push directly
to `main` unless the maintainer explicitly authorizes that exact action.

If compiler changes become necessary, make them in a new branch in `../titan`
(use a separate worktree when that checkout is in use);
do not mix them into this repository, and open the Titan PR only after the
extension/server work is wrapped and locally verified. Leave that PR open for
maintainer review as well; opening it does not authorize merging it.
