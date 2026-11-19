# Browser analysis protocol fixture

The `sdk` directory contains only the three browser analysis inputs. Its Wasm
archive contains `titan.gc` and all four object parts of `titan.browser`,
rebuilt from the pinned source rock under `/tmp/titan-browser-fixture`. The
regenerator strips DWARF with the pinned Emscripten `llvm-objcopy` and verifies
exact public `.titan.meta` bytes, each Wasm fingerprint and the aggregate
linker-visible symbol inventory against the full pack. The separate
`browser_external` archive exercises project binary lookup.

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
regenerator refuses an existing scratch prefix. The fixture's semantics are
reproducible; independent recompiles can change archive bytes because source
certificates record filesystem and toolchain observations. The changing
certificate can also move a pre-link GC transfer manifest pointer slot. The
canonical descriptor is byte-reproducible for the same archive bytes. Across
regenerations only the descriptor's provider digest changes. CI checks the
checked-in assets against the checked-in `SHA256SUMS`.

Only disposable protocol-test prefixes may use this subset. The VSIX takes
the full companion instead.
