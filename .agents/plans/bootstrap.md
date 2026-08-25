# Titan VS Code extension and language-server bootstrap plan

Status: active

Scope authority: [Titan issue #91](https://github.com/mascarenhas/titan/issues/91)

Work board: [Titan VSCode Extension project #2](https://github.com/users/mascarenhas/projects/2)

## Objective

Deliver a VS Code extension with Titan syntax highlighting and a reusable,
out-of-process Titan language server that supports saved-file go-to-definition,
hover, references, rename, and folding for an entire project. The server must
build as one native executable and be usable independently by VS Code and
Codex.

The executable statically selects the Titan standard-library provider, which
carries the embedded Lua interpreter and configured native dependencies. The
compiler itself remains ordinary Lua code: the server's embedded Lua discovers
and loads the installed compiler modules through `package.path` with
`titan.lua.require`. Packaging and diagnostics must keep those two facts
distinct.

## V1 boundaries

In scope:

- TextMate syntax highlighting and Titan language configuration.
- A thin Node extension client that launches the Titan executable over stdio.
- LSP lifecycle, request dispatch, cancellation/coalescing, and correct JSON-RPC
  framing.
- Saved-file semantics for definition, hover, references, rename, and folding.
- Project configuration, module discovery, compiler integration, a shared typed
  AST cache, dependency-aware invalidation, and filesystem watching.
- Titan server tests, JavaScript extension tests, extension-host smoke tests,
  build/package documentation, local development installation, and Codex
  connection guidance.

Explicitly out of scope:

- Completion.
- Semantic analysis of unsaved editor buffers.
- Definition navigation for foreign declarations.
- Definition navigation into external source modules.
- Watching external source trees or retaining their complete ASTs.

Only advertise LSP capabilities that are implemented and covered by a protocol
test.

## Source-grounded architecture

### Process and packaging

The VS Code extension runs as a workspace extension so the native server is on
the same machine and filesystem as the workspace. Its client is intentionally
small: resolve the configured or packaged executable, choose the workspace
root, launch it with stdio, and translate lifecycle failures into an output
channel. Stdout from the server carries only `Content-Length` framed protocol
messages; stderr carries logs.

The Makefile owns the cross-language build:

1. compile the Titan server with the project-local `.titan/bin/titanc` and
   static Titan-provider preference;
2. compile/bundle the extension and run its JavaScript tests;
3. assemble a platform-specific VSIX containing the native executable;
4. provide focused and complete test targets.

The executable has no Titan stdlib or Lua DSO requirement when the installed
static provider supplies them. This does not mean the compiler Lua sources are
inside the binary: the runtime installation must expose compatible
`titan-compiler` modules on Lua's `package.path` and their ordinary native Lua
modules on `package.cpath`. On ELF systems the server link must export the
embedded Lua API (for example with `-Wl,-E`) so those native modules bind to the
same Lua state.

### Server layers

Keep protocol plumbing separate from compiler semantics:

1. **Transport and JSON** — incremental stdin framing, strict request/response
   envelopes, JSON values, UTF-16/LSP positions, URI/path conversion, error and
   cancellation handling.
2. **Lifecycle and dispatch** — initialize, initialized, shutdown, exit,
   capability advertisement, request IDs, notifications, and serialized output.
3. **Project model** — workspace root, optional `titan-config.lua`, module-path
   rules matching `titanc --tree`, project/external classification, and folder
   module membership.
4. **Compiler boundary** — load compiler Lua modules normally through
   `package.path`, cast the returned tables once, and normalize compiler data to
   typed Titan records/unions with exact spans, declaration identity, localness,
   original type, and coerced type.
5. **Cache and scheduler** — one module graph per project, annotated ASTs for
   project modules, manifests for every dependency, reverse imports, generation
   checks, and cooperative yields so stale work cannot overwrite newer state.
   Compiler work holds one permit around the shared embedded Lua state, but its
   resolver-scoped I/O strategy delegates files and child processes to Titan's
   async modules and yields after each completely published source module.
6. **Feature queries** — one symbol/reference index feeds definition,
   references, and rename; typed nodes feed hover; source structure feeds folding.

The first implementation should adapt the compiler's real AST and APIs rather
than inventing a parallel Titan parser. A small JSON parser/encoder for LSP is a
separate protocol concern.

### Disk snapshots and invalidation

LSP open/change notifications do not become semantic input in V1. A request is
answered from the newest completed generation derived from files on disk.
Changes are detected through project `.titan` watchers and coalesced.

Every read-only request starts or shares a background refresh and returns
without joining it. It may use the immutable preceding completed generation
while revalidating intentionally unwatched external inputs; after a saved-file
hint it returns the feature's empty/null result until that saved generation is
published. Rename always joins and performs its second disk-generation check.
A known refresh failure invalidates the fallback until a later refresh
succeeds.

- File content change invalidates its owning module.
- Creating or deleting a constituent of a folder module invalidates that whole
  module and updates membership.
- Project modules retain their full annotated AST and manifest.
- Every project module is explicitly `dirty`, `checking`, `clean`, or `failed`.
  A diagnostic or explicit nil-manifest compiler result is current and
  `failed`, not pending work: it contributes saved coordinates and diagnostics
  but no semantic AST. Only a source, dependency, external-provider,
  configuration, or compiler-observed header change returns it to `dirty`.
  Exceptions and malformed compiler results remain retryable rather than being
  mistaken for current diagnostics.
- External source and binary modules retain only manifest and filesystem
  provenance metadata, never complete ASTs. An external source entry may also
  retain its compiler-observed C-header fingerprint closure.
- External trees are never watched. Imported external modules are revalidated
  by exact provenance when encountered again; C FFI modules additionally
  revalidate the ordered direct/transitive header bytes and include-search
  candidates observed by the compiler, both before analysis and immediately
  before publication. This detects edits, deletion/recovery, and a newly
  shadowing header without watching or walking an external include tree.
- After rechecking a module, compare the new public manifest with the previous
  manifest. A changed manifest recursively invalidates immediate importers; an
  unchanged one stops propagation.
- Every asynchronous result carries a project generation. Discard stale
  generations before publishing indexes or replies.
- A compiled interface or contextual nominal owner may discover its physical
  provider only while the compiler is loading it. The async I/O bridge records
  the exact followed provider identity during that analysis and publication
  re-stats it. A stable first binary/contextual discovery commits immediately;
  same-path replacement or different providers selected for one logical module
  across compiler attempts invalidates the consumer and retries.

### Configuration

Read an optional project-root `titan-config.lua` in the embedded Lua state and
normalize it immediately to a typed record. Evaluate it in an otherwise empty
environment and read configuration from its global assignments; it does not
return a table. Support:

- `source_modules_root`, defaulting to the project root;
- `extra_ffi_include_dirs`, expressed as an ordinary Lua array table such as
  `{ "./include" }`;
- `binary_modules_root`, defaulting to the installed Titan library-versioned
  tree.

Paths are resolved relative to the configuration file. Configuration changes
invalidate project discovery and the module graph.

## Implementation phases and gates

### Phase 0 — repository and toolchain bootstrap

- Add `AGENTS.md`, this plan, the repository-local agent skill, and `.titan/`
  ignore rule.
- Install the sibling Titan checkout into the project-local `.titan` prefix.
- Add a Makefile, package manifest/lockfile, TypeScript/JavaScript build setup,
  VS Code launch/tasks, and test entry points.
- Create the board-sized GitHub issues, add Titan #91 as the umbrella project
  item, and assign initial Kanban fields.

Gate: clean reproducible tool versions, `npm ci`, a locally compiled static
Titan executable that successfully requires `titan-compiler.parser`, and a
committed bootstrap scaffold.

### Phase 1 — highlighting and extension shell

- Contribute the Titan language id, `.titan` extension, language configuration,
  and a TextMate grammar based on Titan's current syntax.
- Implement executable resolution, workspace-root selection, stdio launch,
  output-channel logging, start/stop, and configuration validation.
- Unit-test manifest/configuration and process option construction; add an
  extension-host activation smoke test.

Gate: highlighting works in an Extension Development Host and the client can
launch a fixture stdio server without polluting protocol stdout.

### Phase 2 — Titan protocol core

- Implement JSON representation, parser/encoder, and byte-accurate LSP framing.
- Implement lifecycle and dispatch with only the V1 capabilities advertised.
- Make stderr logging explicit and serialize all stdout writes.
- Add Titan unit tests and transcript tests for fragmented/multiple frames,
  malformed headers/JSON, notifications, errors, shutdown/exit, UTF-8 bytes,
  UTF-16 positions, and cancellation/generation behavior.

Gate: the single native executable passes protocol transcripts and a real
  language client completes initialize/shutdown/exit.

### Phase 3 — compiler bridge and project graph

- Load the compatible installed compiler Lua modules through normal
  `package.path`; report actionable discovery/version failures.
- Identify the smallest compiler API changes required for independent module
  checking, manifests, annotated AST retention, I/O injection, and cooperative
  yield. Keep any such work on a new Titan repository branch.
- Convert raw string/integer-keyed Lua maps into typed Titan AST structures at
  one audited boundary.
- Implement configuration, module discovery, project/external ownership, folder
  modules, dependency/reverse-dependency graphs, and manifest comparison.
- Add watcher, coalescing, external-mtime, recursive invalidation, unchanged
  manifest, deletion/addition, and stale-generation tests.

Gate: an instrumented project fixture proves unchanged modules are not reparsed
or rechecked and every required invalidation case selects exactly the expected
modules.

### Phase 4 — semantic features

- Build declaration/use identity and exact location indexes from typed ASTs.
- Implement project-only definition, all-project references, and validated
  workspace edits for rename.
- Implement hover with term type, local-declaration status, and both original
  and coerced types when coercion occurred.
- Implement structural folding ranges.
- Cover cross-module, folder-module, shadowing, Unicode/UTF-16, malformed source,
  external-source, FFI, and stale-cache negative cases.

Gate: each advertised feature passes focused Titan tests and end-to-end requests
through the compiled server.

### Phase 5 — packaging, agents, and delivery

- Package the correct platform executable in a VSIX and document how other
  platforms are built.
- Document clean builds, all tests, F5 development, VSIX creation, and local
  `code --install-extension` installation.
- Package an agent-readable, skills-only Codex adapter whose deterministic
  read-only query script launches the same executable directly, including root
  and compiler `package.path` requirements, then test its framing and lifecycle
  through definitions, references, hover, folding, and rename previews.
- Run the full Make/npm/Titan gates, inspect the packaged contents and native
  dependencies, and review scope against every acceptance criterion.
- Commit exact paths to `main`. If Titan changed, finish its separate tests and
  open its PR only after this repository is wrapped.

Gate: a clean checkout can reproduce the executable and VSIX, Titan and
JavaScript suites pass, VS Code and Codex both connect, and every Project item
has evidence before moving to Done.

## Review checklist

- No compiler Lua modules claimed to be embedded in the executable.
- Native compiler dependencies can bind to the exported embedded Lua API.
- No server logging on stdout.
- No unsaved text used for semantic answers.
- No completion or unsupported capability advertised.
- No untyped compiler AST tables beyond the adapter layer.
- Correct UTF-16 positions and URI normalization at every LSP boundary.
- Cache invalidation includes create/delete and folder membership changes.
- External sources are not watched or navigated into.
- Rename rejects invalid/colliding targets before returning edits.
- Tests build and run, rather than stopping after compilation.
- Project fields and dependency notes match the actual implementation state.

## Resolved investigation outcomes

- Compiler API 3 exposes resolver-scoped incremental analysis, complete project
  AST reuse, detached public manifests, exact external provenance, and ordered
  checked-module checkpoints without embedding compiler Lua modules.
- The resolver context owns one I/O strategy. Ordinary `titanc` uses the Lua
  implementation; the server supplies a Titan-record proxy backed by Titan
  async filesystem/process APIs and `async.yield`. The one focused Titan
  standard-library surface addition exposes `fs.Stat.device` and `fs.Stat.inode`
  as opaque equality-only fields so async compiler I/O preserves hard-link
  identity; it adds no new I/O operation.
- Parser/checker-private metadata supplies exact source spans, declaration
  identity, localness, surface type arguments, named arguments, and original
  and coerced types. The bridge normalizes those tables once into typed Titan
  records and unions.
- The Makefile selects Titan's static provider and exports the embedded Lua C
  API. Packages are host/architecture-specific; Linux CI runs directly on an
  Ubuntu 24.04 Ubicloud runner and rejects binaries importing GLIBC symbols
  newer than 2.39.
- Codex's supported plugin surface is a bundled skill and deterministic query
  script. Marketplace-level `lspServers` registration is not part of the
  supported manifest contract.
- Project analysis states distinguish pending work from a current diagnostic.
  Failed revisions leave the compiler queue and partial semantic index until a
  relevant observed input changes; repeated semantic requests only revalidate
  intentionally unwatched inputs.
- Compiler-observed provider identities close first binary and contextual
  discovery races without forcing a duplicate whole-project pass when the
  installed provider remained stable. The bridge retains and revalidates every
  binary provider observation, requires one consistent binary kind/path across
  attempts, and still permits a later source-required import to select source
  for the final snapshot.
- On the final integrated native server, the actual-usage vscode-titan
  benchmark cold-indexed all 47 saved files in one compiler analysis and 27
  root attempts: 8,894.386 ms wall, 8,860 ms child CPU, and 804,576 KiB peak
  server RSS. The preceding duplicate-pass build took 18,058.798 ms and
  reported 54 attempts, so removing the redundant pass reduced measured cold
  wall time by 50.75%. A hover issued before readiness returned the intentional
  no-data result in 0.759 ms; ready hover and method definition took 1.232 ms
  and 1.379 ms, and an unchanged refresh took 20.185 ms with no progress work.
  The cold run published 48 progress updates through 47/47 files, while the
  unchanged refresh published none.
