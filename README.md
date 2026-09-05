# Titan for VS Code

This repository contains the VS Code extension and standalone language server
for the [Titan programming language](https://github.com/mascarenhas/titan).
Version 1 provides syntax highlighting and saved-file language intelligence for
Titan projects. The server is an ordinary LSP process over stdio. A bundled
skills-only Codex plugin queries that same executable for read-only saved-file
code intelligence.

The native executable statically links the selected Titan standard-library
runtime modules, the embedded Lua interpreter, and the selected native
dependencies. Initialized statically linked modules register their runtime
openers in `package.preload`. Separately, the executable carries a metadata-only
inventory of all 19 canonical Titan standard-module interfaces; compiler
language-server API 5 validates and decodes those serialized interfaces and
their build target's C type profile for project typechecking. The inventory
contains no standard-module implementation, provider archive, header, or SDK
payload.

The Titan compiler itself is not embedded in that executable: its Lua state
loads the ordinary `titan-compiler` modules through `package.path` and their
native Lua dependencies through `package.cpath`. A target-specific VSIX carries
compatible module trees under exactly `dist/titan/share/lua/5.5` and
`dist/titan/lib/lua/5.5`, so the extension does not require a separate system
Titan compiler installation.

## Prerequisites

- A sibling Titan checkout at `../titan` (override with `TITAN_REPO=...`).
- A C toolchain and the native prerequisites used by Titan.
- Node.js 24 and npm.
- VS Code 1.106 or newer for extension development and installation.

Version 1 builds native packages on Linux and macOS. Windows requires a future
native Titan toolchain/package path rather than relabeling another host's
executable.

The repository owns an ignored Titan installation in `.titan/`; build commands
do not rely on an ambient `titanc` or Lua installation. These prerequisites are
for building the repository. Installing its target-specific VSIX does not
require that development toolchain.

## Build and test

```sh
make toolchain
make npm-ci
make
make test
```

`make` produces `bin/titan-language-server` and `dist/extension.js`, and stages
the project-local Lua source and native-module trees under exactly
`dist/titan/share/lua/5.5` and `dist/titan/lib/lua/5.5`. It does not stage a
`lib/titan` tree, a Titan provider archive, Titan headers, or any other Titan SDK
payload. The server build uses Titan's static-provider path and, on ELF systems,
exports the embedded Lua API so compiler dependencies loaded from
`package.cpath` bind to that same Lua state.

If `.titan/` already exists after the sibling Titan checkout changes, run
`make toolchain-refresh` before rebuilding so the isolated compiler modules and
static providers match that checkout.

The complete local gate builds the server and extension, runs Titan and
JavaScript tests plus the Extension Host smoke test, queries the native server
through the Codex adapter, packages the VSIX, checks its contents, validates the
Codex plugin metadata, and inspects native linkage:

```sh
make verify
```

On a headless Linux machine, run the Extension Host under a virtual display:

```sh
xvfb-run -a make verify
```

GitHub CI runs that gate directly on the same Ubuntu 24.04
`ubicloud-standard-2` runners used by Titan. Because both repositories are
private, the vscode-titan repository must define an Actions secret named
`SSH_PRIVATE_KEY`; its public half must be registered as a read-only deploy key
in `mascarenhas/titan`.

Use `make help` for focused targets. In particular, `make server-test` runs the
native Titan suite and `make extension-test` runs the extension unit tests. A
successful compilation by itself is not a successful test run.

To measure the production server against this repository's saved Titan source,
including cold-index wall/CPU time, peak RSS, request responsiveness, and an
unchanged hover/definition pair that must not start indexing, run:

```sh
node scripts/benchmark-server.mjs --server bin/titan-language-server
```

The benchmark defaults to the extension's `debug` server-emission level so its
numbers represent normal VS Code use. Pass `--log-level off` only when measuring
the lower bound without structured-log overhead.

For a controlled persistent-cache fill/warm comparison, set one unique
`TITAN_PROBE_CACHE_IDENTITY` value and reuse it for the consecutive server
processes. The value selects an isolated hashed cache namespace; changing it
starts another namespace without deleting ordinary developer cache entries.

An alternate saved target and additional ready-state probes can exercise a
larger workspace in the same persistent server session. Probe positions are
zero-based LSP line/character coordinates. The benchmark canonicalizes the
workspace root and requires target files to be direct regular files below it;
target paths that traverse symlinks are rejected, matching project discovery.

```sh
node scripts/benchmark-server.mjs \
  --server bin/titan-language-server --root ../titan \
  --file titan/timer.titan --marker 'uv.sleep(milliseconds)' --symbol sleep \
  --probe hover:titan/async.titan:7:16 \
  --probe definition:titan/os.titan:196:15
```

The per-file cold-start breakdown requires compiler trace records:

```sh
node scripts/benchmark-server.mjs \
  --server bin/titan-language-server --root ../titan \
  --file titan/timer.titan --marker 'uv.sleep(milliseconds)' --symbol sleep \
  --log-level trace
```

With trace logging enabled, `coldProfile.modules` reports each module's own
compiler CPU plus language-server normalization without charging recursive
dependencies to its importer. A row's `inclusiveCpuMs` retains recursive timing
context, but those overlapping values are deliberately not added to the module
totals. Within `selfCpuMs`, `parseCpuMs` and `checkCpuMs` attribute the
compiler's parsing and checking work, while `otherCpuMs` is the remaining
direct compiler work; apart from displayed rounding, those three fields sum to
`selfCpuMs`. Structurally impossible trace records whose parse and check work
exceeds self-time are rejected instead of concealing overlap. Per-identity
`firstCallCpuMs`, `reuseTotalCpuMs`, `reuseCalls`,
`reuseAverageCpuMs`, and `reuseMaxCpuMs` separate the first observed attributed
operation from later reuse work. Source self-time and normalization are separate
streams, as are complete header processing and downstream FFI conversion: the
first value combines the first record from each stream, while reuse statistics
combine every remaining record. `reuseCalls` counts those remaining attributable
records, and the average and maximum use that same set. The trace has no call ID,
so these fields do not claim that a source record is correlated with a particular
normalization record or that a header request is correlated with a particular
conversion record.

`coldProfile.headers` attributes only each header's complete processing time
plus downstream FFI conversion. Component header phases remain visible for
diagnosis but are not added again. `coldProfile.probeCaches` summarizes
completed-result disk-cache lookups by their real `baseline` or `candidate`
probe stage; hit rates are fractions from zero to one. Its backward-compatible
`persistentSuccess` section also ranks the modules responsible for those disk
lookups, including misses which may become persisted deterministic rejections.

`coldProfile.probeTraces.logical` counts semantic requests and unique keys by
eventual success, compiler rejection, or infrastructure outcome; cache tier;
first/repeated use; publication result; requesting module; and readable header
context. `coldProfile.probeTraces.physical` separately counts execution attempts,
children which actually started, launches with a valid monotonic duration, and
their child wall time by outcome, single/batch kind, persistent lookup result,
publication, module, and header context. A fully warm cache can therefore retain
logical success and rejection requests while reporting zero physical attempts,
zero compiler launches, and zero child wall time. These aggregates preserve the
distinction without retaining source, command arguments, or diagnostics in the
benchmark process.

Module and header durations are process-CPU attribution, not Task-exclusive
clocks. An async suspension can therefore let unrelated server Task CPU enter an
active interval. The benchmark sends only its intentional empty immediate-hover
responsiveness probe before the index is ready; all data-bearing semantic probes
wait for readiness, so the cold-start rows principally isolate compiler work.

## Run the extension during development

1. Open this repository in VS Code.
2. Run `make server npm-ci` in a terminal.
3. Press F5 and choose **Run Titan Extension**.
4. In the Extension Development Host, open a folder containing saved `.titan`
   files.

By default the extension launches its packaged `bin/titan-language-server` once
per workspace folder. These settings can override discovery:

- `titan.languageServer.path`: absolute path, or a path relative to the
  workspace folder.
- `titan.languageServer.arguments`: extra process arguments.
- `titan.languageServer.logLevel`: structured server diagnostics written to
  stderr (`off`, `error`, `info`, `debug`, or `trace`; default `debug`).
- `titan.compiler.luaPath`: optional `TITAN_LS_LUA_PATH` override for compiler
  modules.
- `titan.compiler.luaCPath`: optional `TITAN_LS_LUA_CPATH` override for native
  Lua dependencies.

When these settings are empty, the extension supplies absolute search templates
for its own `dist/titan/share/lua/5.5` and `dist/titan/lib/lua/5.5` trees. The
VSIX is therefore self-contained for compiler discovery and does not inherit
ambient `LUA_PATH` or `LUA_CPATH` defaults. Configured values replace the
corresponding packaged template verbatim, so an override must be a complete Lua
search path. Compatibility still requires both the matching Titan ABI and
`titan-compiler.driver.LANGUAGE_SERVER_API_VERSION == 5`; API 5 includes the
compiler's typed semantic metadata, incremental-analysis hooks, C-header
dependency restat contract, resolver-scoped I/O strategy with named
completed-module yield checkpoints, and the validated metadata-only embedded
interface provider used before disk-backed compiled providers. The provider's
validated build target profile describes portable C types in those interfaces
and their numeric conversions, allowing reflection imports and ordinary
semantic analysis without a C compiler or Titan SDK. C header imports and
native compilation still require the configured C toolchain and SDK. The ABI
alone is not the language-server API contract.

The two bundled trees contain ordinary Lua source and native Lua modules; they
are not embedded into the executable. They contain no `lib/titan` provider tree,
provider archive, Titan headers, or other SDK payload. Initialized Titan
standard-library runtime modules are instead statically linked into the
executable and registered for `require` through `package.preload`. Project
typechecking uses the executable's separate, validated metadata-only inventory
for `titan.async`, `titan.coroutine`, `titan.fs`, `titan.gc`, `titan.http`,
`titan.io`, `titan.iteration`, `titan.lua`, `titan.math`, `titan.net`,
`titan.os`, `titan.peg`, `titan.reflect`, `titan.ssl`, `titan.string`, `titan.test`,
`titan.timer`, `titan.url`, and `titan.uv`.

In Remote SSH, WSL, or container workspaces, the workspace extension and native
server run on that remote host. The client maps the workspace's remote URI
scheme to that host's `file:` paths at the stdio boundary and maps returned
project locations back to the original remote scheme and authority.

A workspace root opened through a directory symlink is resolved once for the
server's working directory and protocol paths; returned project locations are
mapped back to the lexical workspace URI. In a nested multi-root workspace,
VS Code's most-specific workspace folder exclusively owns semantic requests for
its documents.

While the server builds or refreshes saved-file project state, VS Code shows a
busy **Titan indexing N/M files** language-status item for that workspace
folder once the active saved-file workset is known. It disappears when the
generation is ready. An indexing failure remains visible as an error and opens
the language-server output when selected. Read-only language features stay
responsive during indexing and return their ordinary empty result until an
initial generation is available.

Compiler errors from each completed saved-file generation appear in VS Code's
**Problems** view. Their locations are converted from compiler byte columns
using the saved source text; unsaved editor contents are not diagnostic input.
Repairing or deleting a file, changing the configured source roots, or stopping
the workspace language client clears the corresponding stale entries.

### Language-server diagnostics and protocol tracing

Run **Titan: Show Language Server Output** from the Command Palette to reveal
the shared log. Every server and client record is prefixed with its workspace
folder in a multi-root window. Server stderr is structured and routed at its
declared severity; malformed or unstructured stderr remains an error. The
extension launches the server with `debug` emission by default, so the **Titan
Language Server** output channel's VS Code log-level selector is the only
control needed to switch between normal and debug output. The channel still
filters records without restarting the server. To collect trace records, first
set
`titan.languageServer.logLevel` to `trace`, which restarts each affected server,
then set the output channel to Trace. Explicit `off`, `error`, `info`, `debug`,
and `trace` emission overrides remain available when reducing server-side work
or collecting deeper diagnostics.

Indexing always emits an `indexing.chain.start` record and a paired
`indexing.chain.complete` record, including the trigger, pass count, generation,
wall time, and CPU time. Starts and successful terminals are Info; failed
terminals are Error. Debug adds scan/analysis phase records and one bounded
`compiler.module.complete` checkpoint after each source module the compiler has
fully published. A graph generation counts project-graph changes; it is not a
refresh-pass counter.

Client/server protocol tracing is separately opt-in and does not restart the
server. Set `titan.trace.server` to `messages` for message summaries, or
to `verbose` for full payloads. Both modes write to the same per-workspace-
prefixed output channel; `verbose` traces can include source text and other
workspace data. Restore the setting to `off` after collecting a trace.

### Project configuration

An optional `titan-config.lua` at the workspace root assigns configuration
values as globals. Relative paths are resolved from that root:

```lua
include = { "./titan", "./spec/stdlib/titan" }
exclude = { "./examples", "./spec/fixtures" }
source_module_roots = { ".", "./spec/stdlib/titan", "./vendor/titan" }
binary_modules_root = ".titan/lib/titan/0.6"
extra_ffi_include_dirs = { "include", "vendor/include" }
extra_ffi_cppflags = "-DPROJECT_FFI=1 '-Ivendor path/include'"
```

All fields are optional. `include` and `source_module_roots` each independently
default to `{ "./src" }`, `exclude` defaults to an empty list, the binary root
defaults to the compatible compiler installation, and the FFI include list
defaults to empty. `include` selects the roots recursively scanned for saved
project `.titan` files and watched for `.titan` changes. `exclude` removes
files or directory subtrees from that watch set without removing their saved
modules from project discovery. `source_module_roots` is the compiler's
complete ordered source-module search path and determines the logical names of
the project files selected by `include`. It normally starts with the project
roots and may append external source folders that should not be watched. Its
normalized entries are joined with `;` and installed as `TITAN_SOURCE_PATH`.
A normalized source-module root therefore cannot contain `;`; watcher-only
include roots do not have that restriction.
`extra_ffi_cppflags` is parsed with the
compiler's existing `TITAN_EXTRA_CPPFLAGS` shell-word rules and appended to
the value inherited by the workspace-isolated server process. It accepts the
same ordered `-I`/`-D` preprocessing arguments used by `titanc`. Unknown fields
and returned values are rejected. Configuration runs in an otherwise empty
Lua environment, so it can assign these values but cannot write unframed bytes
to the language server's stdout or mutate compiler state.

This setting controls language-server analysis only. Keep the normal build's
`TITAN_EXTRA_CPPFLAGS` equivalent when invoking `titanc`; otherwise editor
semantics and command-line compilation can intentionally see different C
preprocessing environments.

`include` controls project membership and watching only. Each selected file's
logical name is relative to its most-specific containing
`source_module_roots` entry, so overlapping source roots still give one saved
file one canonical project identity. The server checks that identity against
the compiler's declared-root order and per-root folder-before-flat rules. A
shadowed, blocked, or overlap-ambiguous project provider is reported as a
configuration issue instead of being submitted under an identity that differs
from `titanc`. An included `.titan` file outside every source root is likewise
reported instead of receiving an include-relative name.

Project discovery intentionally ignores symlinked files and directories below
the configured include roots in version 1. This keeps project identity and the
watch set inside the resolved source trees; use ordinary files/directories for
project modules. A file or directory listed in `exclude` remains part of the
recursive saved-source scan but is not watched. Its changes become visible on
the next refresh triggered by another watched input. Conversely, a path listed
only in `source_module_roots` is compiler-resolved external source: it is not
watched, indexed, or a navigation target in version 1. This restriction does
not prohibit opening the workspace root itself through a symlink, as described
above.

## Package and install the VSIX

```sh
make package
make install-vsix
# Equivalent direct VS Code CLI installation:
code --install-extension .build/vsix/titan-linux-x64.vsix --force
```

The package is named for and tagged with its native target, for example
`.build/vsix/titan-linux-x64.vsix`. Build it separately on each target platform;
this repository does not cross-compile native server binaries. The Makefile
rejects a `VSIX_TARGET` that would merely relabel the host-built executable.
Linux packages also inherit the build host's glibc baseline. Build distributable
artifacts on the oldest supported Linux baseline. `make inspect-server` reports
the maximum imported GLIBC symbol version; release CI additionally sets
`TITAN_MAX_GLIBC_VERSION` so a newer requirement cannot silently raise the
supported baseline.

To install only the server under a custom prefix:

```sh
make install-server INSTALL_PREFIX="$HOME/.local"
```

The VSIX includes the native server, the private compiler module trees under
exactly `dist/titan/share/lua/5.5` and `dist/titan/lib/lua/5.5`, this project's
license, and Titan/native, Lua-module, and bundled JavaScript dependency
notices. It does not include a Titan provider/archive, `lib/titan` tree, Titan
headers, or any other native SDK payload, and does not depend on a system
compiler module tree.

A server-only installation includes the executable plus this project's license
and the Titan/native notices under `share/doc/titan-language-server` in the
selected prefix. It does not install the VSIX's private compiler module trees or
bundled JavaScript dependencies. A standalone server therefore uses
`TITAN_LS_LUA_PATH` and `TITAN_LS_LUA_CPATH` when its compiler modules are not
available as `./?.lua` and `./?.so`; see [the Codex setup guide](docs/codex.md).

## Version 1 behavior

Semantic requests use files saved on disk. Unsaved editor buffers are not
silently compiled. Completion, foreign-definition navigation, navigation into
external source modules, and watching external source trees are outside the
first-version scope.

Hover presents a named declaration signature, including parameter names, for
functions, methods, associated functions, and supported foreign callables.
Function-valued variables retain their bare function type. Record, union, and
interface hovers summarize the members visible at that occurrence; module
hovers summarize visible top-level members without recursively expanding
nominal types. These summaries are normalized and cached with the immutable
semantic index rather than rebuilt by individual hover requests.

An unchanged read-only request uses the immutable completed generation without
rescanning the project. Before the initial index is ready it returns the
feature's ordinary empty result. A watcher hint classified as a saved-project
change starts one coalesced refresh; read-only requests keep using the preceding
immutable generation while that work runs. Intentionally unwatched external
inputs are revalidated by the next saved-project refresh or strict rename
refresh. A known compiler/configuration failure remains authoritative for its
exact saved epoch and is not retried by unchanged read-only requests. A later
saved hint supersedes that failure while its repair refresh runs, allowing
read-only requests to use the preceding immutable generation; a strict rename
instead joins its explicit retry. Rename always waits for the stable newest
generation and revalidates disk state after preflight.

A saved module rejected by the compiler has no semantic data for that
generation, but it does not prevent independently valid project modules from
forming the immutable semantic view.

Server stdout is reserved exclusively for `Content-Length`-framed JSON-RPC.
Diagnostics and debug logs go to stderr.

For the repository-local Codex skill, its deterministic query command, and
compiler search-path setup, see [docs/codex.md](docs/codex.md). Development
scope and milestones are recorded in
[the bootstrap plan](https://github.com/mascarenhas/vscode-titan/blob/main/.agents/plans/bootstrap.md).
