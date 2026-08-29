# Self-contained compiler Lua modules

## Scope and authority

GitHub issue [#43](https://github.com/mascarenhas/vscode-titan/issues/43)
owns this change. Titan
[mascarenhas/titan#120](https://github.com/mascarenhas/titan/pull/120) is the
completed prerequisite: initialized Titan modules linked into the standalone
server register their openers in `package.preload`. The merged Titan
[mascarenhas/titan#122](https://github.com/mascarenhas/titan/pull/122) added the
trusted API 4 embedded interface inventory that lets the compiler typecheck
those linked modules without rediscovering a `lib/titan` provider on disk.

The VSIX will carry the ordinary Lua dependencies used by the compiler. It
will not duplicate Titan standard-library providers that are already linked
statically into the language-server executable. In particular, the package
must contain neither `lib/titan` nor a Titan `.a` archive.

## Runtime contract

- At the beginning of `main`, before the compiler can be loaded, the language
  server replaces `package.path` with `TITAN_LS_LUA_PATH` when that variable
  is set and otherwise with `./?.lua`.
- It independently replaces `package.cpath` with `TITAN_LS_LUA_CPATH` when
  that variable is set and otherwise with `./?.so`.
- Ambient `LUA_PATH` and `LUA_CPATH` may influence Lua's initial state, but
  they are not the language server's compiler-discovery contract and are
  overwritten by the startup configuration above.
- Existing `titan.compiler.luaPath` and `titan.compiler.luaCPath` settings stay
  as compatibility overrides. An empty setting selects the VSIX-owned tree.

## Packaged layout

Stage one generated private Lua prefix below `dist/titan`:

```text
dist/titan/
  share/lua/5.5/**
  lib/lua/5.5/**
```

The stage is an exact recursive copy of the corresponding directories in the
ignored project-local `.titan` installation. Staging removes the previous
output first so deleted or renamed modules cannot survive into a later VSIX.
The extension supplies absolute paths with these templates:

```text
TITAN_LS_LUA_PATH=<extension>/dist/titan/share/lua/5.5/?.lua;<extension>/dist/titan/share/lua/5.5/?/init.lua
TITAN_LS_LUA_CPATH=<extension>/dist/titan/lib/lua/5.5/?.so
```

Configured overrides replace the corresponding template independently.
Paths are passed as environment values, not shell words, so spaces in an
extension installation path remain ordinary path characters.

## Implementation steps

1. Refresh the sibling Titan `master` and rebuild `.titan` so the executable
   contains the module-preload prerequisite.
2. Add the language-server startup path configuration and a native executable
   regression for defaults, independent overrides, and hostile ambient Lua
   paths.
3. Add extension path construction and launch the child with
   `TITAN_LS_LUA_PATH` / `TITAN_LS_LUA_CPATH` instead of writing `LUA_PATH` /
   `LUA_CPATH`.
4. Stage both Lua trees for development, Extension Host tests, and VSIX
   packaging. Narrowly allow the staged native Lua modules through
   `.vscodeignore` while retaining the general native-artifact exclusion.
5. Extend bundled-component notices for every newly distributed Lua package.
6. Require and compare the packaged tree inventory, reject Lua shared objects
   or additional native-library payload outside `dist/titan/lib/lua/5.5`, and
   inspect the packaged modules' native dependencies.
7. Extract the VSIX and run its server from an unrelated directory with
   ambient Lua/Titan paths poisoned. The existing protocol fixture imports a
   Titan standard module through the embedded interface inventory, while the
   generated bare-`titan` support preload and bundled compiler Lua/C modules
   cover the executable/package boundary.
8. Update the README, Codex instructions, bootstrap plan, configuration
   descriptions, and tests to describe the self-contained default and the
   explicit override path.

## Verification

- Titan server tests and the focused executable path test.
- JavaScript unit tests for path construction, spaces, per-field overrides,
  inherited-environment isolation, and manifest text.
- Extension Host launch assertions for packaged defaults and configured
  overrides.
- Exact staged/VSIX inventory comparison and native dependency inspection.
- Extracted-VSIX protocol/indexing run with poisoned ambient discovery.
- `make verify`, followed by an independent diff and test-coverage review.

## Progress

- 2026-08-29: refreshed sibling Titan `master` to
  `a516fbc7e9974b582fdd726fac88f997357b1eff` (PR #120 merged), created issue
  #43, and moved it to In progress with P1 priority and medium size.
- 2026-08-29: implemented and independently reviewed the Lua path contract,
  exact two-tree staging, notices, extension launch environment, API-4
  executable inventory, and live-image identity validation.
- 2026-08-29: passed all 219 native server tests, 56 Node tests, 12 Extension
  Host tests, the native protocol and Codex-adapter smokes, and the extracted
  VSIX smoke against the exact 181-file Lua inventory with ambient Lua/Titan
  discovery poisoned.
- 2026-08-29: merged the prerequisite Titan API-4 implementation as
  [mascarenhas/titan#122](https://github.com/mascarenhas/titan/pull/122) and
  pinned extension CI to merged `master` commit
  `7b74a0c827370c282de714637ba3883f1058d793`.
- 2026-08-29: the final `make verify` gate passed with a 217-file Linux VSIX,
  exact 181-file Lua inventory, and extracted hostile-environment indexing
  smoke. The artifact is 20,896,623 bytes with SHA-256
  `7a3971ed28e500cc69904ced493bb9a638f9bb6ad55c40aaeb4f98113acd48dc`.
- 2026-08-29: merged the macOS portability and directory-watcher retirement
  follow-up as [mascarenhas/titan#123](https://github.com/mascarenhas/titan/pull/123)
  at `2ba469b786716a218e912496cf68261311ab2bfe`; final
  [Linux](https://github.com/mascarenhas/titan/actions/runs/33249104688) and
  [macOS](https://github.com/mascarenhas/titan/actions/runs/33249111251) gates
  passed, and the sibling checkout is clean and current on `master`.
