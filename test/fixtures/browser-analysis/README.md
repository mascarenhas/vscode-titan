# Browser analysis protocol fixture

The `sdk` directory contains only the three browser analysis inputs. Its
archive preserves the unmodified Wasm object for `titan.gc` and all four
objects for `titan.browser` from the full SDK. The absent-module list is
unchanged. `analysis-target` uses the compiler's production encoder and the
actual archive and absent-list digests. The separate `browser_external`
archive is compiled from the source in this directory and exercises project
binary lookup, not the standard library.

`provenance.json` pins the exact Titan source commit, matching source rock
and full browser semantic pack, and the original asset hashes. `SHA256SUMS`
covers the bytes accepted by the test suite. `LICENSE` and `lua-LICENSE`
come from the producer SDK's notice inventory.

To regenerate, use a full, finished SDK that matches the verified rock and
companion pack, with Emscripten 6.0.13 active. From the repository root:

```sh
bash scripts/regenerate-browser-analysis-fixture.sh \
  "$SDK" "$SOURCE_ROCK" "$SEMANTIC_PACK" "$EMSDK/upstream/bin/llvm-ar"
TITAN_ROOT="$SDK" node --test scripts/browser-analysis-fixture.test.mjs
```

The second command needs the matching native compiler, not Emscripten. The
regenerator compares the decoded live profile with the source descriptor;
the codec's map traversal order can change the raw descriptor bytes without
changing its semantic contents. It then records the hashes of the emitted
bytes. Do not install this subset into a packaging SDK: only disposable
protocol-test prefixes may use it. The VSIX takes the full companion instead.
