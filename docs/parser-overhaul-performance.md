# Parser-overhaul analysis regression measurements

These measurements describe the parser-overhaul checkpoint before the later
compiler-pin and incremental-build update in [native-build.md](native-build.md).
They have not been relabeled as measurements of the newer compiler.

The matched comparison uses Titan `3a06055f4d84e4ca3eb9f8a31fd32aa65d6e6bce` for both server images. The pre-refactor image already includes the syntax/AST migration and the corrected `c-header-v5` / `ffi-conversion-v6` persistence contract. Both images analyze the **same final source snapshots**: 65 saved files in vscode-titan and 135 files, including folder-module contributors, in Titan.

| Corpus | Server | Cold READY | Unchanged restart READY | Restart full restoration |
| --- | --- | ---: | ---: | ---: |
| vscode | pre | 44.538 s | 0.906 s | 1.623 s |
| vscode | final | 42.255 s | 0.903 s | 1.705 s |
| titan | pre | 252.808 s | 5.137 s | 7.960 s |
| titan | final | 243.814 s | 4.765 s | 7.356 s |

READY is measured from process launch. Full restoration includes the later background compiler-manifest restoration and the benchmark's concurrent semantic queries. These rows each have one sample. Three additional alternating starts per image/corpus restored its retained closed database before launching; their medians are separate below because copying the database can change OS file-cache behavior.

The vscode matched change is -5.1% for cold READY and -0.4% for unchanged restart READY. These are local measurements, not CI-runner or cross-machine guarantees; small cold differences from single samples do not establish a stable regression.
The titan matched change is -3.6% for cold READY and -7.3% for unchanged restart READY. These are local measurements, not CI-runner or cross-machine guarantees; small cold differences from single samples do not establish a stable regression.

## Additional restored-database starts

| Corpus | Server | READY median (three samples) | Full restoration median |
| --- | --- | ---: | ---: |
| vscode | pre | 1.469 s | 2.248 s |
| vscode | final | 1.387 s | 2.076 s |
| titan | pre | 5.457 s | 8.197 s |
| titan | final | 5.341 s | 7.848 s |

These cache-replay trials also passed strict work-reuse and feature-result checks. They are not pooled with the ordinary unchanged restart above.

## Controls and correctness

- Host: AMD Ryzen AI 9 HX 370, Linux 7.2.4, Node 24.13.0. The host has two CPU core classes; both matched images and their descendants were pinned to CPU 0. Original checkpoint runs below used Linux 7.2.3 and unrestricted affinity; the matched pairs and repeats were rerun after restart on Linux 7.2.4. No CPU residency was retained for those earlier samples.
- Cold means a fresh workspace SQLite database and private C probe prefix. OS page caches were not flushed. Every pair uses a fixed executable and trace logging, and benchmarks run sequentially after build/test work finished. `C_INCLUDE_PATH` was unset consistently for pairs and reported replay trials; the recorded private probe prefix and installed Lua paths were supplied explicitly.
- Every matched run completed without error diagnostics or an in-memory cache fallback. Hover, definition, references and folding results remained nonempty and stable before, during and after restoration. SQLite integrity checks returned `ok`.
- Warm assertions require zero source analysis, preprocessing, header parsing, FFI conversion/replay, content reads/hashes, cache misses and project re-encoding. The three additional restarts use the same runner/session checks and restored retained database; they do not edit source or headers.
- Only isolated copies were analyzed. The sibling Titan checkout was unchanged. The Titan corpus uses its tracked `titan-config.lua`; the complete installed SDK supplies SQLite headers. Compiler/SDK discovery for both corpora stayed on the project-owned `.titan` installation.

## Earlier checkpoints and the compiler migration

| Checkpoint | Cold READY | Warm READY |
| --- | ---: | ---: |
| `baseline-vscode-r2` | 46.105 s | 1.268 s |
| `baseline-titan` | 237.734 s | 7.654 s |
| `pre-refactor-vscode` | 43.763 s | 0.985 s |
| `pre-refactor-titan` | 260.536 s | 5.071 s |
| `final-vscode` | 44.670 s | 1.396 s |
| `final-titan` | 257.283 s | 5.949 s |

The old-pin baselines used compiler `51592fec443bc094f235c9914e39139f86bb0997`; all 64 installed compiler Lua files were compared with that commit. They analyzed the old syntax corpus (64 vscode-titan files and 135 Titan files). The unrestricted-affinity pre-refactor/final checkpoints also differ by the new 32-line test fixture module. These rows change compiler/corpus or CPU placement and must not be attributed solely to the refactor.

The old-to-new Titan checkpoint profile has 60 versus 67 C-header preprocessing passes; header CPU attribution grew from 138.712 s to 157.562 s, while source parsing fell from 1.182 s to 0.750 s. These observations describe that compiler/corpus change, not an isolated parser benchmark. The compiler repository was not modified to alter those costs.

One replay attempt inherited `C_INCLUDE_PATH` accidentally and failed strict reuse; it is retained under `matched-pre-vscode-warm-repeat-resumed-1` and excluded. All reported replay samples used the sanitized pair environment.

Initial migration attempts correctly failed when obsolete cache-kind filtering caused 167 (vscode-titan) / 207 (Titan) header reads on an unchanged restart. Their evidence remains under `migration-vscode-r2` and `migration-titan`; they are excluded from successful comparisons. The cache protocol regression now tests the installed compiler identifiers directly.

## Reproduction and evidence

Use `scripts/benchmark-workspace-cache.mjs --startup-only --keep-database` with a fixed executable and isolated source copy, and run it under `taskset -c 0` for this affinity-controlled comparison. The benchmark supports explicit `--root`, `--file`, `--module`, `--header`, `--marker`, `--symbol` and a new `--output` directory. Keep `TITAN_ROCKS_ROOT` on the actual installation; the harness owns each private probe prefix.

The compact [machine-readable record](parser-overhaul-performance.json) contains all warm samples, image hashes, summary hashes, memory/database sizes and evidence paths. Raw summaries, logs, retained databases, corpus manifests and the exact matched/repeat commands remain in `.build/parser-overhaul/`. The repeat harness is a temporary copy of the production benchmark with import paths resolved and its existing `runSession`/`validate` functions exported; production benchmark logic is unchanged.

The complete local gate passed 329 native tests in two shards, 60 JavaScript tests, five shard-runner behavior tests and 12 extension-host tests, plus protocol/cache/Codex and package/SDK/plugin/install inspections. Both native shards finished in about 27 seconds locally. Hosted CI cache miss/hit wall times require an actual GitHub run; cache control flow received independent review, but this report does not claim a hosted cache observation.
