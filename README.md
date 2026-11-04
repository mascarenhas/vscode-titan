# Titan for VS Code

This repository contains the VS Code extension and the standalone language
server for the [Titan programming language](https://github.com/mascarenhas/titan).
The server is written in Titan and runs as an ordinary LSP process over stdio.
A bundled, skills-only Codex plugin queries the same executable; see
[Codex setup](docs/codex.md).

On Linux and macOS, the native executable statically links the Titan
standard-library runtime, an embedded Lua interpreter, libuv, llhttp and
SQLite. OpenSSL follows the selected Titan SDK: by default it uses the
system's OpenSSL 3 libraries, while a bundled-OpenSSL SDK links its own archive.
The executable also embeds
metadata-only interfaces for all SDK-selected canonical Titan standard
modules, so ordinary project typechecking needs no SDK at run time.

The Titan compiler is not linked into the executable. The embedded Lua state
loads the ordinary `titan-compiler` modules through `package.path`, and their
native dependencies through `package.cpath`. The executable exports its Lua C
API so those dependencies bind to the same Lua state. A target-specific VSIX
carries compatible compiler module trees, the SDK headers and the matching Lua
sources, so installing it requires no separate Titan compiler.

## Features

- Syntax highlighting for `.titan` files.
- Definition, references, rename, folding, hover and diagnostics for saved
  files.
- Completion from unsaved editor buffers, triggered by `.` and `:` or the
  usual completion command, including after `foreign` in a type annotation.
  Callable candidates show named signatures and insert parameter-name call
  placeholders. After a completion request, hover follows edits to the active
  module. See [completion](docs/completion.md).
- Hover shows named declaration signatures for functions, methods, associated
  functions and supported foreign callables. Function-valued variables keep
  their bare function type. Record, union and interface hovers summarize the
  members visible at that occurrence. Module hovers summarize visible
  top-level members without expanding nominal types recursively.
- LDoc-style declaration and module comments in hover and completion, with
  links into the Titan manual. See [declaration documentation](docs/documentation.md).
- Multiple named union payload parts, including named constructors, selective
  case bindings and shorthand-preserving rename. See
  [union payload parts](docs/union-payload-parts.md).

C imports use `foreign import "header.h"` and contribute, in declaration order,
to the module's builtin `ffi` namespace. Explicit `.titan` source imports also
contribute their C environment through the compiler's generated `.ffi.h`
headers. Written `ffi` roots and C value members support hover and references
within their module, but they have no definition or rename target. Foreign
types use their own unqualified namespace (`foreign int`, `foreign *Name`,
`foreign type Name = ...`) and are not selected through the `ffi` value.

Navigation to FFI definitions or to external source, and watching external
source trees, are out of scope for version 1.

## Prerequisites

To build this repository you need:

- an installed Titan SDK. Put its `titanc` on `PATH`, or set `TITAN_PREFIX` to
  its installation prefix, such as `$HOME/.local/titan`;
- a C toolchain and the native prerequisites that Titan needs;
- GNU Make 4.2 or newer. macOS ships GNU Make 3.81, so install Homebrew's
  `make` and put its `libexec/gnubin` directory first on `PATH`; see
  [native builds](docs/native-build.md#sdk-selection);
- Node.js 24 and npm;
- VS Code 1.106 or newer.

Builds use the selected SDK's compiler, Lua interpreter, modules, headers and
standard-library providers together, and they never modify it. The SDK must
include Titan's installed license at `share/titan/LICENSE`, and its compiler
must provide compiler-owned incremental builds (certified object, native-C,
and final-link reuse, native input switches, `--output`, and `--exe`).
Installing a packaged VSIX needs none of this toolchain.

Native packages build on Linux and macOS. Windows is
[experimental](#windows).

## Build and test

```sh
make npm-ci
make -j2
make test
```

`make` builds `bin/titan-language-server` and `dist/extension.js`. It also
stages the SDK's compiler modules under `dist/titan/share/lua/5.5` and
`dist/titan/lib/lua/5.5`, the SDK include tree under `dist/titan/include`, and
the matching Lua sources under `dist/titan/src`. To use a specific SDK:

```sh
make -j2 TITAN_PREFIX="$HOME/.local/titan"
```

Native image targets always invoke `titanc --incremental`; Make maintains no
Titan module graph or compiler/SDK/configuration stamps. The compiler
discovers imports, schedules source misses, certifies native C helpers passed
with `--c-source`, and reuses unchanged final links. Make runs the
embedded-interface generator, stages runtime files, packages the extension,
and executes tests.

The server selects `src` with `--tree`, writes to `--output .build/server`,
and uses `--exe bin/titan-language-server`; tests use `.build/tests` and
`--exe .build/tests/server/tests` with the explicit `server.tests` root.
`--exe` is relative to the working directory, not the output tree. Generated
module files preserve the source hierarchy; each output tree also owns
`.native/` for C helpers, `.titan-links/<key>/synthetic/` for target-specific
runner/entrypoint files, and a disposable `.titan/digests` precise-stat cache.
Missing or malformed digest data is ignored; inputs without matching precise
observations are read again. Keep source-root spelling stable because changing
it can change generated source locations and legitimately miss.

Run `make server TITAN_FLAGS=-v` for native command echoes and object/native/link
decisions on stderr; worker output and diagnostics use stderr too. Capture both
streams for build logs. No-op certification performs no object compilation or
final link; it is not a Make-only skip. See the native-build guide for profile,
SDK, output-root, and jobserver policy.

`make verify` is the complete local gate. It runs the native, protocol, Codex
adapter and JavaScript suites and the Extension Host smoke test. It also
checks the incremental-build smoke, packages a VSIX, inspects it and the
executable's native linkage, validates the Codex plugin metadata and tests a
server-only installation. On a headless Linux machine, run it as
`xvfb-run -a make verify`. Test and verify targets build with the unoptimized
validation profile; `make`, `make server`, `make package` and installation use
the optimized production profile.

Run `make help` for every target. `make server-test` runs the native
suite serially, while `make server-test-sharded` runs it in two parallel
shards; `make test` and `make verify` use the sharded runner.
`make extension-test` runs the JavaScript unit tests. A successful compile is
not a successful test run.

More build documentation:

- [Native builds](docs/native-build.md): compiler-owned builds, build profiles,
  test execution, CI and the Windows driver.
- [Line coverage](docs/coverage.md).
- [Performance measurement](docs/benchmarks.md).

## Run the extension during development

1. Open this repository in VS Code.
2. Run `make server npm-ci` in a terminal.
3. Press F5 and choose **Run Titan Extension**.
4. In the Extension Development Host, open a folder that contains saved
   `.titan` files.

## Settings

The extension starts one server per workspace folder, by default the packaged
`bin/titan-language-server`. That process is a router for the LSP session and
starts one worker per Titan root it serves
([multiple roots](#multiple-roots-in-one-server-session)). Untrusted and
virtual workspaces are not supported.

| Setting | Default | Meaning |
| --- | --- | --- |
| `titan.languageServer.path` | packaged server | Executable path, absolute or relative to the workspace folder |
| `titan.languageServer.arguments` | `[]` | Extra server arguments |
| `titan.languageServer.logLevel` | `debug` | Server log emission: `off`, `error`, `info`, `debug` or `trace`. Changing it restarts the server |
| `titan.trace.server` | `off` | LSP protocol tracing: `off`, `messages` or `verbose` |
| `titan.compiler.luaPath` | packaged tree | Compiler module search path, passed as `TITAN_LS_LUA_PATH` |
| `titan.compiler.luaCPath` | packaged tree | Native Lua module search path, passed as `TITAN_LS_LUA_CPATH` |
| `titan.completion.insertCallSnippets` | `true` | Insert call placeholders when completing callables. Changing it restarts the server |

With the Lua path settings empty, the extension passes absolute templates for
its own `dist/titan/share/lua/5.5` and `dist/titan/lib/lua/5.5` trees. A
configured value replaces the template verbatim, so it must be a complete Lua
search path. The server never uses ambient `LUA_PATH` or `LUA_CPATH`. The
extension also passes the packaged `dist/titan` tree as `TITAN_ROOT`, because
the compiler reads its SDK headers and Lua sources from an installation root
rather than from a Lua search path. Disable
`titan.completion.insertCallSnippets` to insert plain names when you take
function references.

The bundled compiler must report Titan ABI `2` and
`LANGUAGE_SERVER_API_VERSION == 1`; a matching ABI alone is not enough. See
[compiler compatibility](docs/server-data-flow.md#compiler-compatibility).
Ordinary semantic analysis needs no C compiler. Importing C headers needs a
configured C toolchain. The VSIX supplies the Titan and Lua SDK headers and the
bundled libuv, llhttp and SQLite headers; a bundled-OpenSSL SDK also supplies
OpenSSL's headers. With system OpenSSL, its headers come from the C toolchain.
Supply headers of other libraries through the project configuration.

## Project configuration

An optional `titan-config.lua` at the workspace root assigns configuration
values as globals. Relative paths resolve from the workspace root:

```lua
include = { "./titan", "./spec/stdlib/titan" }
exclude = { "./examples", "./spec/fixtures" }
source_module_roots = { ".", "./spec/stdlib/titan", "./vendor/titan" }
binary_modules_root = ".titan/lib/titan/0.6"
extra_ffi_include_dirs = { "include", "vendor/include" }
extra_ffi_cppflags = "-DPROJECT_FFI=1 '-Ivendor path/include'"
```

Every field is optional:

- `include` (default `{ "./src" }`) selects the roots that are scanned
  recursively for saved project `.titan` files and watched for `.titan`
  changes.
- `exclude` (default empty) removes files or directory subtrees from the
  watch set only. Their saved modules stay in the project, and their changes
  become visible on the next refresh triggered by another watched input.
  Changing only `exclude` does not invalidate cached semantics.
- `source_module_roots` (default `{ "./src" }`) is the compiler's complete,
  ordered source-module search path, and it determines logical module names.
  It normally starts with the project roots and may add external source
  folders that should not be watched. Its entries cannot contain `;`.
- `binary_modules_root` defaults to the bundled compiler's installed provider
  root.
- `extra_ffi_include_dirs` (default empty) adds C include directories.
- `extra_ffi_cppflags` takes `-I` and `-D` preprocessing arguments in the same
  shell-word syntax as `TITAN_EXTRA_CPPFLAGS`. They are appended to the
  inherited value. This affects editor analysis only: keep the matching
  `TITAN_EXTRA_CPPFLAGS` when you run `titanc`, or the editor and the command
  line will see different preprocessing environments.
- `compiler_root` (default: the server's own `TITAN_ROOT`) names an installed
  Titan SDK prefix for this root. Relative paths resolve from the root. See
  [choosing an SDK per root](#choosing-an-sdk-per-root).

Unknown fields and returned values are rejected. The file runs in an otherwise
empty Lua environment, so it cannot write to the server's stdout or change
compiler state.

A file's logical name is relative to the most specific `source_module_roots`
entry that contains it. Overlapping roots therefore still give a saved file one
identity. The server checks that identity against the compiler's root order and
its folder-before-flat rule. It reports a shadowed, blocked or ambiguous
provider as a configuration issue instead of analyzing the file under an
identity that `titanc` would not use. Target variants (`name.<label>.titan`)
are grouped under their logical filename and selected for the host target
(`TITAN_TARGET` is ignored); an unselected variant is excluded from analysis and
receives an information-severity `inactive-variant` diagnostic. An included file
outside every source root gets an `unmapped-source` warning. Such a file is
excluded from compilation, indexing, navigation and watching. The next ordinary
discovery pass updates the warning, for example after a mapped source is saved
or the configuration changes.

Project discovery ignores symlinked files and directories below the include
roots; use ordinary files and directories for project modules. Opening the
workspace root itself through a symlink works. A path listed only in
`source_module_roots` is external source: the compiler resolves it, but it is
not watched, indexed or a navigation target.

### Choosing an SDK per root

`compiler_root` names an installed Titan SDK prefix for one root, for example
`/tmp/titan-314/slice-a/prefix`; relative paths resolve from the root. One
server executable serves every SDK, because the setting selects what that
root's worker loads. An SDK that is missing, that has the wrong Titan ABI or
language-server API, or that this server build cannot use is a root-scoped
error naming the prefix, and the root never falls back to another compiler.
[Server data flow](docs/server-data-flow.md#compiler-compatibility) owns how a
selected SDK is installed and the one case that needs a matching server build.

Because a machine-specific prefix must not dirty a tracked checkout, the
optional `titan-config.local.lua` beside `titan-config.lua` may assign only
`compiler_root`, and overrides the tracked value:

```lua
-- titan-config.local.lua, ignored by version control
compiler_root = "/tmp/titan-314/slice-a/prefix"
```

Any other key in that file is rejected, and the tracked `titan-config.lua`
stays the authority for discovery: the local file changes only which SDK that
root uses. An override this server cannot read, or one whose `compiler_root` is
not a non-empty string, fails its root with that error instead of falling back
to the default SDK.

A root's editor and command line must agree: run `titanc` from the same SDK the
root selects, or the editor will report a different ABI or a different
standard-library inventory.

### Trusting a root's SDK

Loading an SDK means executing its Lua and native modules, so `compiler_root` is
honoured only for a trusted root. A root is trusted when its canonical path is
equal to or inside a trusted directory. Trusted directories come from the
client's `initializationOptions.trustedRoots` (an array of absolute paths) or
`TITAN_LS_TRUSTED_ROOTS` (an OS path list). The extension declares the workspace
folder it launched, because it never runs in an untrusted workspace.

An untrusted root that selects `compiler_root` gets a root-scoped error naming
the root, the setting and the trust option, and the server publishes a
`configuration` diagnostic on the configuration file that set it. The
publication is replaced by an empty one once the selection is accepted. That
root starts no worker and never falls back to the default SDK. A root without
`compiler_root` needs no trust and behaves exactly as before.

For how each input reaches the compiler, see
[server data flow](docs/server-data-flow.md).

## Multiple roots in one server session

The native server is a router: it owns the client session and starts one worker
process per Titan root (`src/server/router.titan`,
`src/server/worker_process.titan`). Each worker has its own compiler, index,
watchers and caches, so roots cannot see each other's facts.

- Every `workspaceFolders` entry is an independent Titan root. The server
  advertises `workspace.workspaceFolders.changeNotifications` and accepts
  additions and removals at any time. Roots are canonicalized, so a folder
  opened through a symlink shares the root it names.
- A document belongs to the most specific of the known roots that contain it
  and its nearest ancestor `titan-config.lua`: a project nested inside an outer
  folder is its own root, and an inner folder narrows routing without
  restarting the outer root. A folder that merely contains a project (a checkout
  root inferred from a marker directory, a home directory, a monorepo) is a root
  only for documents it owns itself, and an added folder starts no worker until
  a document routes to it.
- A document with no containing root and no configuration ancestor is unowned:
  the server drops its notifications and fails its requests with an error naming
  the file, instead of borrowing another root's settings.
- At most four workers run at once (`initializationOptions.maxWorkers`, or
  `TITAN_LS_MAX_WORKERS`). A worker is idle when its root has no open documents,
  no request in flight and no background indexing pass running. An idle worker
  is stopped after `initializationOptions.idleTimeoutSeconds` (default 600
  seconds; a fractional value is accepted). Open editor buffers are replayed
  into a worker that starts again, so unsaved text survives eviction and a
  crashed worker.
- A document whose owning root changes — a folder added or removed, a nested
  project discovered, a worker restarted — keeps its unsaved text, and
  diagnostics a previous owner published for it are cleared. Buffers are
  retained under the same size limits the worker applies, and a document too
  large to retain is reported as unavailable rather than analysed from its saved
  bytes.
- A worker that exits unexpectedly fails its pending requests. Three crashes of
  one root within a minute stop automatic restarts until that root's settings
  change or the client sends `workspace/didChangeConfiguration`.
- Changing a root's configuration, or reinstalling its SDK, restarts only that
  root's worker, immediately and without client action. A tracked
  `titan-config.lua` edit that leaves `compiler_root` unchanged needs no
  restart: the worker rescans it.
- Removing a folder releases its root; it does not stop it. The warm worker is
  kept, the released root owns only documents that its own `titan-config.lua`
  claims, and adding the same folder again reuses that worker without a restart
  or a fresh index. Only idle eviction and the worker cap stop a released root.
  A client that adds a sibling checkout for one call and removes it afterwards
  therefore pays the index cost once, not once per call.

The router answers the custom request `titan/workspaceStatus` (no params) with
one entry per known root: canonical `root`, `origin` (`folder` or
`discovered` or `released`), `trusted`, effective `compilerRoot`, `state`
(`inactive`, `starting`, `ready`, `failed` or `evicted`), `failure`, `workerPid`
and restart `generation`. `titanRoot` and `probePrefix` are what the worker itself reports
for its `TITAN_ROOT` and `TITAN_PREFIX`, so they prove per-root SDK and probe
isolation instead of restating the router's decision; a root with no worker
reports them as null. The router also logs every root transition to stderr with
the root path.

## Indexing and diagnostics

While the server builds or refreshes its saved-file state, a busy
**Titan indexing N/M files** language-status item appears for that workspace
folder. It disappears when the generation is ready. An indexing failure stays
visible as an error, and selecting it opens the language-server output.
Read-only features stay responsive during indexing. Until the first generation
is ready they return their ordinary empty result. Afterward an unchanged
request uses the most recent completed generation without rescanning, also
while a refresh runs. A watcher event for a saved project change starts one
coalesced refresh. Unwatched external inputs are revalidated by the next
saved-project refresh or by rename's strict refresh.

A client which advertises `window.workDoneProgress` also receives standard
work-done progress for the same work: one `window/workDoneProgress/create` token
per contiguous indexing period, then a `$/progress` `begin` when that period
starts, `report` updates with the saved-file workset, and exactly one `end`.
`end` follows publication of the completed generation and its diagnostics, so a
request issued after `end` observes that generation. A coalesced follow-up pass
keeps the same token. A client which does not advertise the capability receives
no progress request, and `titan/indexingStatus` remains for the
language-status item above.

The server advertises `diagnosticProvider` and answers `textDocument/diagnostic`
from the same published rows it pushes, so pull and push never disagree. Every
pull is a freshness barrier: it requests one saved-change refresh pass through
the same coalescing path a watcher hint uses, then answers from the generation
that pass completed, so a dependency or another contributor of the requested
document's module is revalidated before the client reads the report. A pass that
finds nothing dirty only scans: the report and its `resultId` are unchanged, so
a pull whose `previousResultId` still matches answers `unchanged`, and no
analysis runs. A cancelled pull is answered as cancelled, and a pull that
follows a failed pass reports that failure after the barrier pass (which
re-indexes a project repaired on disk). A newly written module reports its own
diagnostics, and a `.titan` file the project does not contain answers an empty
report. Passing
`initializationOptions.pullDiagnostics = false` omits `diagnosticProvider`; the
VS Code extension always passes it because `vscode-languageclient` collects
pulled and pushed diagnostics separately, and a pull-only client would lose
diagnostics for closed files. See
[server data flow](docs/server-data-flow.md#protocol-boundary) for the protocol
ownership of these requests.

Compiler errors from each completed saved generation appear in the
**Problems** view, with columns converted from compiler bytes using the saved
text. Unsaved editor contents are not diagnostic input. A module the compiler
rejects has no semantic data for that generation; it and its dependency
closure publish no reusable interfaces, but independently valid modules still
form the semantic view. Repairing or deleting a file, changing the source roots or
stopping the client clears stale entries. A known compiler or configuration
failure stays authoritative for its saved state, so unchanged read-only
requests do not retry it. A later saved change retries it, and meanwhile
read-only requests use the preceding generation; a rename joins or starts an
explicit refresh instead (`Application:fresh_view`). Rename always waits for
the newest stable generation and rechecks the disk after its preflight.

## Logging and tracing

Run **Titan: Show Language Server Output** to open the **Titan Language
Server** output channel. Every record is prefixed with its workspace folder's
name. The server writes structured records to stderr, and the channel shows
them at their declared level; unstructured stderr shows as an error. Because
the extension launches servers at `debug` emission, the channel's own
log-level selector is enough to switch between normal and debug output. To
collect trace records, set `titan.languageServer.logLevel` to `trace`, which
restarts the server, then set the channel to Trace.

Indexing always logs a paired `indexing.chain.start` and
`indexing.chain.complete` record with the trigger, pass count, generation, wall
time and CPU time. The generation counts project-graph changes, not refresh
passes. Starts and successful completions are Info, and failed completions
are Error. Debug adds scan and analysis phase records, plus one
`compiler.module.complete` record per fully published source module.

Protocol tracing is separate and does not restart the server. Set
`titan.trace.server` to `messages` for summaries or `verbose` for full
payloads. `verbose` traces can include source text, so reset the setting to
`off` afterward.

## Workspace cache

The server stores one index per root, in `.titan-ls/index.sqlite3` inside that
root. The directory includes a `.gitignore` and is never scanned or watched. By
default the compiler's C probe cache lives in the same directory, under
`.titan-ls/var/cache/titan-probes/2`. A nonempty inherited `TITAN_PREFIX` moves
only the probe cache, and then each root uses its own namespace below it,
`<TITAN_PREFIX>/roots/<digest>`; clear an overridden probe directory
separately. Roots never share a probe directory, because probe results depend on
each root's SDK headers and flags. If the database cannot be created or opened,
the server logs that persistence is unavailable and keeps the index in memory.

A compatible restart answers from the stored index first and restores compiler
declarations in the background. A different compiler, server build or project
configuration rebuilds the cache automatically. Startup trusts unchanged file
timestamps and physical metadata, so a byte change that preserves all of them
is not detected. Probe results are keyed by raw C source; clear the probe
directory when a changed native environment makes a cached result stale. To
force a fresh index, close the server and delete `.titan-ls`. Deleting only
`index.sqlite3` keeps the probe results.

See [workspace storage](docs/sqlite-backend-storage.md) for the schema and
validation rules.

## Remote and multi-root workspaces

In Remote SSH, WSL and container workspaces, the extension and the native
server run on the remote host. The client maps the workspace's remote URI
scheme to that host's `file:` paths and maps returned locations back. A
workspace root opened through a directory symlink is resolved once, and
returned locations map back to the lexical workspace URI. In nested multi-root
workspaces, VS Code's most specific workspace folder owns each document's
requests, and each workspace folder gets its own server session.

Non-`file:` folder URIs are ignored, and documents below them are unowned.

## Package and install the VSIX

```sh
make package
make install-vsix
# The equivalent VS Code CLI command:
code --install-extension .build/vsix/titan-linux-x64.vsix --force
```

The package is named and tagged for its native target, for example
`.build/vsix/titan-linux-x64.vsix`. Build it separately on each platform: the
repository does not cross-compile, and the Makefile rejects a `VSIX_TARGET`
that would only relabel the host-built executable. Linux packages inherit the
build host's glibc baseline. `make inspect-server` reports the newest
required GLIBC symbol version, and fails when it exceeds
`TITAN_MAX_GLIBC_VERSION` if that is set.

The VSIX contains the native server and the private compiler module trees
under `dist/titan`. It also has the SDK headers, the Lua sources, this
project's license and the Titan, native, Lua-module and bundled JavaScript
notices. It contains no Titan provider archive or `lib/titan` tree. Smoke
tests on the extracted package verify semantic analysis without a C compiler,
and SDK-backed C imports from an unrelated working directory.

## Standalone server

```sh
make install-server INSTALL_PREFIX="$HOME/.local"
```

This installs the executable, plus this project's license and the Titan and
native notices under `share/doc/titan-language-server`. It does not install
the compiler modules. Without `TITAN_LS_LUA_PATH` and `TITAN_LS_LUA_CPATH`, a
standalone server searches only `./?.lua` and `./?.so` (`./?.dll` on Windows).
`TITAN_ROOT` names the installation whose SDK headers and Lua sources the
compiler reads; otherwise it uses the parent of the executable's directory.
For setup, see [Codex setup](docs/codex.md).

The server reserves stdout for `Content-Length`-framed JSON-RPC and writes all
logs to stderr. Without the extension, its log level comes from
`TITAN_LANGUAGE_SERVER_LOG_LEVEL` and defaults to `info`. A standalone client
gets the same indexing progress and pull diagnostics described under
[indexing and diagnostics](#indexing-and-diagnostics), so an agent harness can
wait for `$/progress` before its first semantic request instead of polling.

### Pointing an agent harness at several slices

The default mode is the [router](#multiple-roots-in-one-server-session); it
starts one worker per root. `--worker --root PATH` runs one root directly and
is internal: the router uses it, and other clients should not. `--print-paths`
reports the compiler search paths without starting a server.

An agent harness that launches one server for a project benefits from folder
change notifications: omp's `lsp` tool adds a sibling checkout with
`workspace/didChangeWorkspaceFolders` before it opens a document there. Such a
configuration must list the directories whose roots may select their own SDK:

```json
{
  "servers": {
    "titan": {
      "command": "/home/you/.local/bin/titan-language-server",
      "args": [],
      "fileTypes": [".titan"],
      "rootMarkers": ["titan-config.lua", ".git"],
      "initOptions": {
        "trustedRoots": ["/home/you/work"]
      }
    }
  }
}
```

omp inherits the process environment, so the compiler search paths and
`TITAN_ROOT` come from the environment as described above. Each slice then
selects its own installed prefix with `compiler_root` in its
`titan-config.local.lua`; a root without that setting uses the inherited
`TITAN_ROOT`. Query `titan/workspaceStatus` to see which SDK and worker each
root is using.

## Windows

Windows x64 support is experimental. It uses a native CLANG64/UCRT Titan SDK,
a DLL application and a controlled shared Lua DLL. The extension looks for
`titan-language-server.exe` and `.dll` compiler modules. See
[Windows builds](docs/native-build.md#experimental-windows-build) for setup,
validation gates and limitations.

Windows source paths must be fully qualified drive paths (`C:/project`,
including a mapped share such as `W:/project`) or UNC paths
(`//server/share/project`). Drive-relative, current-drive-rooted and device
namespace paths are rejected. UNC server names must be bounded ASCII host
names. Drive letters are normalized, but whole paths are not case-folded.

File notifications on shared folders are best effort. The supported watcher
location is a guest-local NTFS folder.

## Project scope

Titan issue [mascarenhas/titan#91](https://github.com/mascarenhas/titan/issues/91)
defines the first version's scope, and
[the bootstrap plan](https://github.com/mascarenhas/vscode-titan/blob/main/.agents/plans/bootstrap.md)
records its milestones. Contributor and agent rules are in
[AGENTS.md](AGENTS.md).
