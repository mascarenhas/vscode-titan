#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 4 ]]; then
  echo 'usage: bash scripts/regenerate-browser-analysis-fixture.sh SDK SOURCE_ROCK SEMANTIC_PACK LLVM_AR' >&2
  exit 2
fi
sdk=$(realpath "$1")
rock=$(realpath "$2")
pack=$(realpath "$3")
ar=$(realpath "$4")
objcopy="$(dirname "$ar")/llvm-objcopy"
emsdk=$(realpath "${EMSDK:?activate Emscripten 6.0.13 before regenerating}")
test "$ar" = "$emsdk/upstream/bin/llvm-ar"
repo=$(cd "$(dirname "$0")/.." && pwd -P)
fixture="$repo/test/fixtures/browser-analysis"
scratch=/tmp/titan-browser-fixture
mkdir -m 700 "$scratch" || { echo "$scratch already exists; refusing to reuse it" >&2; exit 1; }
trap 'rm -rf -- "$scratch"' EXIT
work="$scratch/work"
staged="$work/fixture"
layout=lib/titan-browser/0.6
mkdir -p "$staged/sdk/$layout" "$staged/providers" "$work/members"
mkdir -p "$scratch/src/fixture"

tar -xOf "$pack" manifest.json > "$work/manifest.json"
for file in titan.a analysis-target absent-modules; do
  tar -xOf "$pack" "$layout/$file" | cmp - "$sdk/$layout/$file"
done
node --input-type=module - "$work/manifest.json" "$rock" "$pack" "$sdk" "$layout" "$staged" "$scratch" <<'NODE'
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const [manifest, rock, pack, sdk, layout, output, scratch] = process.argv.slice(2);
const source = JSON.parse(readFileSync(manifest, "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (basename(rock) !== source.source_rock.name ||
    digest(readFileSync(rock)) !== source.source_rock.sha256) {
  throw new Error("source rock disagrees with the semantic pack");
}
const semantics = ["absent-modules", "analysis-target", "titan.a"].map((name) => {
  const path = `${layout}/${name}`;
  const records = source.files.filter((file) => file.path === path);
  const bytes = readFileSync(join(sdk, path));
  if (records.length !== 1 || records[0].size !== bytes.length || records[0].sha256 !== digest(bytes)) {
    throw new Error(`semantic pack manifest disagrees with ${path}`);
  }
  return records[0];
});
const provenance = {
  titan_commit: source.titan_commit,
  emscripten_version: source.emscripten_version,
  build_profile: source.build_profile,
  source_rock: source.source_rock,
  semantic_pack: { name: basename(pack), sha256: digest(readFileSync(pack)) },
  source_semantics: semantics,
  regeneration: {
    neutral_root: scratch,
    stdlib: "lua src/titan/titanc -j1 --target browser --source-first -c --tree src/titan --output work/stdlib --c-parts 4 titan.browser titan.gc",
    external: "lua src/titan/titanc -j1 --target browser -c --tree src/fixture --output work/provider browser_external",
    strip: "Emscripten's llvm-objcopy --strip-debug",
    archive: "Emscripten's llvm-ar rcsD",
    reproducibility: "Exact public metadata, Wasm fingerprints and linker-visible symbols. Independent recompiles may change source certificates and their adjacent pre-link data relocations; checked-in hashes cover exact fixture bytes."
  }
};
writeFileSync(join(output, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
NODE

cp -a "$sdk" "$scratch/prefix"
mkdir "$scratch/emsdk"
cp -a "$emsdk/.emscripten" "$emsdk/upstream" "$emsdk/node" "$scratch/emsdk/"
unzip -q "$rock" -d "$scratch/src"
cp "$fixture/source/browser_external.titan" "$scratch/src/fixture/"
unset TITAN_PATH_0_6 TITAN_PATH TITAN_SOURCE_PATH TITAN_TARGET TITAN_PREFIX
unset TITAN_EXTRA_CPPFLAGS TITAN_EXTRA_CFLAGS TITAN_EXTRA_LDFLAGS TITAN_NO_LINE_DIRECTIVES
unset CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH EM_CACHE EMCC_CFLAGS
unset LUA_PATH LUA_CPATH LUA_INIT LUA_INIT_5_5
mkdir "$work/tmp"
export TMPDIR="$work/tmp"
export EMSDK="$scratch/emsdk" EM_CONFIG="$scratch/emsdk/.emscripten"
export PATH="$scratch/prefix/bin:$EMSDK/upstream/emscripten:$PATH"
export TITAN_ROOT="$scratch/prefix" TITAN_PROBE_CACHE_DISABLE=1
export LUA_PATH_5_5="$TITAN_ROOT/share/lua/5.5/?.lua;$TITAN_ROOT/share/lua/5.5/?/init.lua"
export LUA_CPATH_5_5="$TITAN_ROOT/lib/lua/5.5/?.so"
TITAN_BUILD_PROFILE=$(node -p 'require(process.argv[1]).build_profile' "$staged/provenance.json")
export TITAN_BUILD_PROFILE
(
  cd "$scratch"
  lua src/titan/titanc -j1 --target browser --source-first -c --tree src/titan \
    --output work/stdlib --c-parts 4 titan.browser titan.gc
  lua src/titan/titanc -j1 --target browser -c --tree src/fixture \
    --output work/provider browser_external
)
members=(browser.o browser.part1.o browser.part2.o browser.part3.o gc.o)
mkdir "$work/reference"
(
  cd "$work/reference"
  "$ar" x "$sdk/$layout/titan.a" "${members[@]}"
  for file in "${members[@]}"; do "$objcopy" --strip-debug "$file"; done
  "$ar" rcsD "$work/reference.a" "${members[@]}"
)
(
  cd "$work/members"
  for file in "${members[@]}"; do
    "$objcopy" --strip-debug "$work/stdlib/titan/$file" "$file"
  done
  "$ar" rcsD "$staged/sdk/$layout/titan.a" "${members[@]}"
)
"$objcopy" --strip-debug "$work/provider/browser_external.o" "$work/browser_external.o"
"$ar" rcsD "$staged/providers/browser_external.a" "$work/browser_external.o"
cp "$sdk/$layout/absent-modules" "$staged/sdk/$layout/absent-modules"
cp "$sdk/share/titan/LICENSE" "$staged/LICENSE"
cp "$sdk/share/titan/LICENSES/lua-LICENSE" "$staged/lua-LICENSE"
"$TITAN_ROOT/bin/lua" -E "$repo/scripts/browser-analysis-fixture.lua" \
  encode "$TITAN_ROOT" "$staged" "$work/reference.a"
(
  cd "$staged"
  sha256sum LICENSE lua-LICENSE provenance.json providers/browser_external.a \
    "sdk/$layout/absent-modules" "sdk/$layout/analysis-target" "sdk/$layout/titan.a"
  cd "$fixture"
  sha256sum source/browser_external.titan
) > "$staged/SHA256SUMS"
cp -R "$staged/." "$fixture/"
