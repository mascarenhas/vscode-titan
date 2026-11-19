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
repo=$(cd "$(dirname "$0")/.." && pwd -P)
fixture="$repo/test/fixtures/browser-analysis"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
staged="$work/fixture"
layout=lib/titan-browser/0.6
mkdir -p "$staged/sdk/$layout" "$staged/providers" "$work/members"

tar -xOf "$pack" manifest.json > "$work/manifest.json"
for file in titan.a analysis-target absent-modules; do
  tar -xOf "$pack" "$layout/$file" | cmp - "$sdk/$layout/$file"
done
node --input-type=module - "$work/manifest.json" "$rock" "$pack" "$sdk" "$layout" "$staged" <<'NODE'
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const [manifest, rock, pack, sdk, layout, output] = process.argv.slice(2);
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
  source_semantics: semantics
};
writeFileSync(join(output, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
NODE

export TITAN_ROOT="$sdk" TITAN_PROBE_CACHE_DISABLE=1
export PATH="$sdk/bin:$PATH"
export LUA_PATH_5_5="$sdk/share/lua/5.5/?.lua;$sdk/share/lua/5.5/?/init.lua"
export LUA_CPATH_5_5="$sdk/lib/lua/5.5/?.so"
TITAN_BUILD_PROFILE=$(node -p 'require(process.argv[1]).build_profile' "$staged/provenance.json")
export TITAN_BUILD_PROFILE
members=(browser.o browser.part1.o browser.part2.o browser.part3.o gc.o)
(
  cd "$work/members"
  "$ar" x "$sdk/$layout/titan.a" "${members[@]}"
  "$ar" rcsD "$staged/sdk/$layout/titan.a" "${members[@]}"
)
cp "$sdk/$layout/absent-modules" "$staged/sdk/$layout/absent-modules"
cp "$sdk/share/titan/LICENSE" "$staged/LICENSE"
cp "$sdk/share/titan/LICENSES/lua-LICENSE" "$staged/lua-LICENSE"
"$sdk/bin/titanc" --target browser -c --tree "$fixture/source" --output "$work/provider" \
  --cflag="-ffile-prefix-map=$repo=." --cflag="-ffile-prefix-map=$work=." browser_external
"$ar" rcsD "$staged/providers/browser_external.a" "$work/provider/browser_external.o"
mkdir "$work/encode"
"$sdk/bin/lua" -E "$repo/scripts/browser-analysis-fixture.lua" encode "$sdk" "$staged" "$work/encode"
(
  cd "$staged"
  sha256sum LICENSE lua-LICENSE provenance.json providers/browser_external.a \
    "sdk/$layout/absent-modules" "sdk/$layout/analysis-target" "sdk/$layout/titan.a"
  cd "$fixture"
  sha256sum source/browser_external.titan
) > "$staged/SHA256SUMS"
cp -R "$staged/." "$fixture/"
