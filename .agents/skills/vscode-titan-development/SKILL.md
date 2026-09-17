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
Titan installation. Packaging checks an exact production SDK inventory. Keep
upstream compiler test tools such as Busted and coverage modules in a separate
test prefix; they are not part of the extension's compiler payload.

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
shared graph with declared top-level member/type manifests and exact filesystem
provenance. Project bodies exist only during fresh checking and semantic
extraction; release them after accepted SQL publication and retain unchanged
modules' SQL facts. External source and binary modules retain manifests and
provenance only. Compiler-observed C-header dependency closures are metadata.

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
Update Project status/priority/size with `gh`, then work in a focused branch,
stage exact paths, and open a PR only when the owned acceptance criteria are
satisfied. Leave the PR open for maintainer review. The direct-commit allowance
was limited to initial repository development and is retired; do not merge a PR
or commit or push directly to `main` unless the maintainer explicitly authorizes
that exact action.

If the compiler needs changes, work in a new branch under `../titan`, preserve
its existing compiler behavior for `titanc`, run its own focused and broad
tests, and defer its PR until the extension/server work is wrapped. Leave the
compiler PR open for maintainer review; opening it does not authorize merging
it.

## Compiler syntax updates and architecture review

Use the exact requested compiler commit in CI and the isolated development
installation. During prerelease development the compiler/server API stays at
`1`; update both consumers and fixtures against the pinned metadata contract.
Treat source syntax, saved-source fixture strings, hover text, semantic spans,
TextMate scopes and editor bracket/indent rules as separate migration surfaces.
Do not rewrite SQL, embedded Lua or other string payloads as Titan syntax.
Compare production string payloads after automated migrations and validate the
result with the compiler parser and semantic/protocol tests.

Read the compiler's current AST/type definitions before adapting the typed
bridge. Foreign type names live in a distinct C namespace and do not acquire
ordinary Titan definition-navigation targets. Retain lexical traversal order
and exclude compiler DAG backreferences when walking the saved AST.

Architecture reviews should examine the entire server. Configuration flow is
one example: trace environment inputs and project configuration to the compiler
owner, its resolver contexts and cache identity. Prefer one accepted normalized
snapshot and one production composition path. Remove repeated discovery,
parallel loader implementations, copying adapters and per-node allocations
where ownership permits. Preserve the deliberate rescan after watcher
registration, short SQL publication transactions, cancellation cleanup and
snapshot isolation. Prefer record-owned conversions over new forwarding layers.

For performance changes, retain a fixed executable and isolated saved-source
snapshots for both Titan and vscode-titan. Use the workspace-cache benchmark's
`--startup-only` mode for cold and unchanged-process-restart comparisons. Record
cache state, diagnostic success, warm work avoided, full background restoration,
compiler/source revisions and host-load limits; an early READY notification is
not full restoration. Keep failed runs as failed evidence.

CI builds and caches the complete compiler installation by its exact commit,
platform/build policy and absolute installation prefix. Include the unpacked
LuaRocks COPYING and core/cfg.lua licensing inputs used by stage-notices.mjs; a
fresh compiler checkout does not contain those generated dependency directories.
No fallback cache may supply a different compiler. Native tests compile once and execute in two
parallel shards on the two-CPU runner. Maintain the module inventory in
`scripts/run-server-tests.mjs` when adding a test owner, inspect positive test
selection and both shard outcomes, and use `make verify` for the complete gate.

## Incremental native builds

Read [native-build.md](../../../docs/native-build.md) before changing the Make
object graph. Make owns dependency and configuration invalidation; the compiler's
`--incremental` check only validates source timestamps. Keep generated outputs in
persistent build stages, and discover imports with the compiler parser so Titan
fixture strings do not become build dependencies. Folder contributors form one
logical module and object.

Use `make -j2 server server-test-build` for parallel object compilation. Each
object recipe uses `-c --incremental -j1`; final links reuse those objects.
`server-objects` and `server-test-objects` stop before linking. Keep production
and test graphs separate with consistent flags and source/provider selection in
every phase. Production uses `--static`; tests follow the compiler stdlib test
policy and build shared `titan.test` support before test owners. Never reuse a
production object in the test graph. Native payloads, exported Lua symbols and
bootstrap flags belong at the final link.

Verify unchanged builds preserve all generated companions and executables, and
that module, import, folder inventory, C header, compiler/SDK and flag changes
invalidate the expected closure. Preserve two execution shards independently of
object compilation. Run incremental build regressions and the complete gate
before delivery. The shipping compiler defaults to O3 and Linux fat LTO; a
cheaper fixture build must set consistent C and link overrides and must not
replace validation of the shipping configuration. Use one Make process per
`BUILD_ROOT`; independent concurrent builds need separate roots and, when
linking servers, separate `SERVER` destinations.

The SQLite directory is also the native server's default C probe-cache prefix.
Use the shared workspace-cache directory helper and set this default before
compiler modules first load; preserve a nonempty inherited `TITAN_PREFIX`.
The extension must not replace that policy with VS Code workspace storage.
Probe-prefix selection must not change compiler Lua, provider or SDK discovery.
