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

The executable statically selects the Titan standard-library runtime modules
needed by the server, together with the embedded Lua interpreter and configured
native dependencies. Initialized statically linked modules register their
runtime openers in `package.preload`. The executable separately embeds a
metadata-only inventory of all 19 canonical standard-module interfaces;
compiler language-server API 5 validates and decodes it and its build target's
C type profile for project typechecking. This inventory is analysis data, not
module implementation or a linkable provider.

The compiler itself remains ordinary Lua code: the server's embedded Lua
discovers and loads compiler modules through `package.path` with `lua.require`.
The VSIX supplies matching private Lua source and native-module trees, while
standalone callers supply their own paths. Packaging and diagnostics must keep
those facts distinct.

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

1. compile the Titan server with the project-local `.titan/bin/titanc`, static
   Titan-provider preference, and the complete metadata-only standard-interface
   inventory;
2. compile/bundle the extension and run its JavaScript tests;
3. assemble a platform-specific VSIX containing the native executable plus
   exactly the private `dist/titan/share/lua/5.5` and
   `dist/titan/lib/lua/5.5` trees, with no `lib/titan` tree, Titan provider
   archive, Titan headers, or additional native SDK payload;
4. provide focused and complete test targets.

Initialized statically selected Titan runtime modules register their openers in
`package.preload`; the VSIX does not copy their provider archive to disk. This
does not mean the compiler Lua sources are inside the binary. The VSIX carries
the ordinary compiler modules under `dist/titan/share/lua/5.5` and their native
Lua dependencies under `dist/titan/lib/lua/5.5`, then launches the server with
absolute `TITAN_LS_LUA_PATH` and `TITAN_LS_LUA_CPATH` templates. A standalone
server instead uses those environment variables or its `./?.lua` and `./?.so`
defaults. On ELF systems the server link must export the embedded Lua API (for
example with `-Wl,-E`) so native Lua modules bind to the same Lua state.

Project typechecking does not discover Titan standard-module interfaces through
an on-disk provider. API 5 validates and decodes the executable's metadata-only
19-entry inventory before considering disk-backed compiled providers. The
inventory covers `titan.async`, `titan.coroutine`, `titan.fs`, `titan.gc`,
`titan.http`, `titan.io`, `titan.iteration`, `titan.lua`, `titan.math`,
`titan.net`, `titan.os`, `titan.peg`, `titan.reflect`, `titan.ssl`,
`titan.string`, `titan.test`,
`titan.timer`, `titan.url`, and `titan.uv`; it carries serialized ABI/type data,
not implementations or link inputs. The provider also carries a validated
build target profile describing portable C types and numeric conversions, so
ordinary semantic analysis can consume reflection metadata without a C compiler
or Titan SDK. C header imports and native compilation still require the
configured C toolchain and SDK.

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

An unchanged read-only request uses the immutable completed generation without
starting a source-tree scan. A saved-file watcher hint starts one coalesced
background refresh; while its newer epoch is pending, read-only requests keep
using the preceding immutable generation without joining. Intentionally
unwatched external inputs are revalidated by the next saved-project refresh or
strict rename refresh. Rename always joins and performs its second
disk-generation check. A known refresh failure is authoritative only for that
exact saved epoch, and unchanged read-only requests do not retry it. A later
saved hint supersedes the failure while its repair refresh runs, so read-only
requests may again use the preceding immutable view; a strict rename instead
joins its explicit retry.

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
- The metadata-only embedded provider is the running executable itself and
  cannot be reloaded in place. The bridge captures its followed identity before
  the first analysis, requires the same baseline at every later analysis, and
  observes it again before publication. Replacement is a terminal request to
  restart the language-server process rather than attributing in-memory
  interfaces to a different file at the same pathname.

### Configuration

Read an optional project-root `titan-config.lua` in the embedded Lua state and
normalize it immediately to a typed record. Evaluate it in an otherwise empty
environment and read configuration from its global assignments; it does not
return a table. Support:

- `include`, an ordered Lua array of recursive saved-project discovery and
  watcher roots defaulting to `{ "./src" }`;
- `exclude`, a Lua array of files or directory subtrees omitted from watching
  while remaining in recursive project discovery;
- `source_module_roots`, an independent ordered Lua array defaulting to
  `{ "./src" }`; its normalized roots form the compiler's complete, exact
  semicolon-separated source-module search path, normally beginning with the
  project roots and optionally appending unwatched external source folders;
- `extra_ffi_include_dirs`, expressed as an ordinary Lua array table such as
  `{ "./include" }`;
- `extra_ffi_cppflags`, expressed as a shell-word string parsed with the
  compiler's existing `TITAN_EXTRA_CPPFLAGS` rules and appended after the
  inherited preprocessing flags;
- `binary_modules_root`, defaulting to the installed Titan library-versioned
  tree.

Paths are resolved relative to the configuration file. FFI flags are installed
only while that workspace owns the shared compiler state and the inherited
driver table is restored before another compiler runs. Semantic configuration
changes, including include order or a flags-only change, invalidate project
discovery and the module graph. An exclude-only change reconciles watcher
policy without discarding compatible analysis.

`include` selects the saved project files and watcher scope but does not name
modules. Project indexing derives each selected file's logical name from its
most-specific containing `source_module_roots` entry, then validates that
candidate against compiler lookup order, including per-root folder-before-flat
and blocked-constituent precedence. A shadowed or overlap-ambiguous candidate,
or an included source outside every source root, is a deterministic discovery
issue. A source root not selected by `include` remains external and unwatched.

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

- Load compatible compiler Lua modules through normal `package.path`; use the
  VSIX-owned tree by default and report actionable discovery/version failures
  for standalone or configured overrides. Require compiler
  `LANGUAGE_SERVER_API_VERSION = 5` and give each resolver context the validated
  metadata-only `embedded_interface_provider` option, including the validated
  `target_profile` exported from the server build toolchain.
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

- Package the correct platform executable and exactly its private
  `dist/titan/share/lua/5.5` and `dist/titan/lib/lua/5.5` trees in a VSIX, and
  document how other platforms are built. Do not package `lib/titan`, provider
  archives, Titan headers, or any other native SDK payload.
- Document clean builds, all tests, F5 development, VSIX creation, and local
  `code --install-extension` installation.
- Package an agent-readable, skills-only Codex adapter whose deterministic
  read-only query script launches the same executable directly, including root
  and standalone `TITAN_LS_LUA_PATH` / `TITAN_LS_LUA_CPATH` requirements, then
  test its framing and lifecycle through definitions, references, hover,
  folding, and rename previews.
- Run the full Make/npm/Titan gates, inspect the packaged contents and native
  dependencies, and review scope against every acceptance criterion.
- Commit exact paths to a feature branch and open a reviewed pull request. If
  Titan changed, publish its separately tested prerequisite branch first and
  pin the exact compiler commit in this repository's CI until that prerequisite
  lands.

Gate: a clean checkout can reproduce the executable and VSIX, Titan and
JavaScript suites pass, VS Code and Codex both connect, and every Project item
has evidence before moving to Done.

## Review checklist

- No compiler Lua modules claimed to be embedded in the executable.
- VSIX compiler artifacts are confined to `dist/titan/share/lua/5.5` and
  `dist/titan/lib/lua/5.5`.
- No `lib/titan` tree, Titan provider/archive, Titan headers, or additional
  native SDK payload in the VSIX.
- Initialized statically linked standard modules use `package.preload`; the
  complete 19-entry embedded inventory is validated metadata-only analysis
  input, not runtime code or a linkable provider.
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

- Compiler API 5 exposes resolver-scoped incremental analysis, complete project
  AST reuse, detached public manifests, exact external provenance, ordered
  checked-module checkpoints, and validation/resolution of the executable's
  metadata-only standard-interface provider and its build target profile without
  embedding compiler Lua modules. The profile supplies portable C type traits
  for ordinary semantic analysis; explicit C header imports continue to use a
  live configured toolchain and SDK.
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
  relevant observed input changes. Repeated semantic requests reuse the settled
  ready generation or failure without rescanning; intentionally unwatched
  inputs are revalidated by the next saved-project refresh or strict rename.
- Compiler-observed provider identities close first binary and contextual
  discovery races without forcing a duplicate whole-project pass when the
  installed provider remained stable. The bridge retains and revalidates every
  binary provider observation, requires one consistent binary kind/path across
  attempts, and still permits a later source-required import to select source
  for the final snapshot.
- On the earlier forced-refresh integrated server, the actual-usage vscode-titan
  benchmark cold-indexed all 47 saved files in one compiler analysis and 27
  root attempts: 9,175.704 ms wall, 9,140 ms child CPU, and 805,836 KiB peak
  server RSS. A hover issued before readiness returned the intentional no-data
  result in 3.271 ms; ready hover and method definition took 1.275 ms and
  1.450 ms, and the then-required unchanged refresh took 20.153 ms with no
  progress work. The
  cold run published 48 progress updates through 47/47 files, while the
  unchanged refresh published none. The bounded-cache comparison which
  isolated the language-server change measured 18,058.798 ms and 54 attempts
  with the redundant pass versus 8,894.386 ms and 27 attempts without it, a
  50.75% cold-wall reduction.
- With the Titan checkout's production FFI configuration and the refreshed
  0.6.0 compiler, one persistent-server confirmation indexed generation 89's
  143 saved files in one initial epoch: 262,698.682 ms wall, 177,610 ms child
  CPU, and 2,952,360 KiB peak RSS. There was no duplicate pass or dirty-watch
  restart. Ready `uv.sleep` hover/definition took 1.429/1.704 ms;
  `async.titan` and `fs.titan` hovers took 3.344/3.800 ms; and the
  `os.titan` source-import definition took 4.122 ms. The unchanged request pair
  emitted zero indexing statuses and consumed zero sampled child CPU.
- The pre-#108 exclusive-attribution trace is
  `/tmp/vscode-titan-cold-profile-phases.json`, SHA-256
  `5ac2b57223cb87483010a3d8156261ff94ff6f991ddcddac64d0dd2879dcae31`.
  It indexed the same 143 saved files in one generation and took 314,637.283 ms
  wall, 185,590 ms sampled child CPU, and 2,757,148 KiB peak server RSS. Source
  self time decomposed into 959.517 ms parsing, 65,897.188 ms checking and
  direct probe orchestration, and 2,110.215 ms other driver work; bridge
  normalization used 4,325.915 ms and complete header processing plus Titan
  FFI conversion used 89,690.821 ms. `titan.uv` accounted for 18,335.078 ms:
  57.657 ms parsing, 17,231.156 ms checking/probes, 640.401 ms other work, and
  405.864 ms normalization. Its first attributable call used 17,823.844 ms;
  27 later calls used 511.234 ms in total. The ready hover/source-import
  definition probes all succeeded, and the unchanged request batch completed
  in 14.600 ms with zero indexing-status notifications. The persistent-success
  probe stream recorded 10 hits and 1,075 misses after the isolated toolchain
  rebuild; that run established the P0 negative-result cache work subsequently
  implemented by Titan #108 / PR #110.
- The final PR #110 integration pins Titan commit
  `ccd29f09f0d2f71320c826be7a97b6e48f9039ff` and compares one uniquely
  namespaced empty-cache run with its unchanged warm successor. Both indexed
  generation 89's 143 saved files in one initial epoch. The empty-cache run
  took 278,950.401 ms wall, 201,230 ms language-server-process CPU, and
  3,296,740 KiB peak server RSS; its 1,084 physical compiler launches comprised 336
  successes and 748 deterministic rejections and used 96,046.773 ms summed
  child wall time. The logical stream reduced 92,428 semantic requests to
  9,608 compiler keys, including 374 distinct rejected keys. The warm run
  served all 9,608 compiler keys from persistent evidence, performed zero
  physical compiler launches, and took 168,812.703 ms wall, 166,880 ms
  language-server-process CPU, and 3,259,828 KiB peak server RSS: reductions of
  110,137.698 ms (39.48%) wall and 34,350 ms (17.07%) process CPU without a
  meaningful RSS increase. During the two runs, an immediate hover completed
  before readiness with the intentional no-data result in 1.488/1.275 ms;
  ready hover took 0.736/0.806 ms; source-import definition took 0.877/1.013
  ms; and unchanged request batches took 2.225/2.445 ms with no indexing-status
  notification. The evidence is
  `/tmp/vscode-titan-pr35-a3b168a1-cold.json` (SHA-256
  `f175805f05ffeaf871f999a9cee21cf7828fb72a8e7041e665e8b3a3bdb7d969`)
  and `/tmp/vscode-titan-pr35-a3b168a1-warm.json` (SHA-256
  `466cff279dcb28faf59baa1eb3577b690e3120356051f5d37efec902dc081645`).
  The first Titan amend after these captures changed only documentation,
  compiler coverage specs, and coverage-process grouping. A final coverage
  follow-up centralized the already enforced 1 MiB persistent-diagnostic
  bound in the record codec and added its direct regression. It does not alter
  cache keys, encoded bytes, or service behavior for any persistable result,
  so the `a3b168a1` performance evidence remains representative. The final
  compiler follow-ups restore the repository's documented 30/30/35-minute
  Linux job timeouts, reduce compiler coverage-test cost without dropping
  semantic or runtime oracles, and capture `cdriver`'s physical module root
  once at load time. None changes probe cache keys, evidence, or reuse.
