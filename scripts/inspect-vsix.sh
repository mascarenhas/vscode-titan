#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 PATH-TO-VSIX TARGET-PLATFORM" >&2
  exit 2
fi

vsix=$1
target=$2
repository_root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
titan_prefix=${TITAN_PREFIX:-$repository_root/.titan}
if [[ ! -f "$vsix" ]]; then
  echo "VSIX is missing: $vsix" >&2
  exit 1
fi

unzip -tqq "$vsix"
contents=$(unzip -Z1 "$vsix")

for required in \
  extension/bin/titan-language-server \
  extension/dist/extension.js \
  extension/language-configuration.json \
  extension/syntaxes/titan.tmLanguage.json \
  extension/package.json \
  extension/readme.md \
  extension/LICENSE.txt \
  extension/dist/notices/README.md \
  extension/dist/notices/titan/LICENSE \
  extension/dist/notices/titan/THIRD_PARTY_NOTICES.md \
  extension/dist/notices/titan/LICENSES/libuv-LICENSE \
  extension/dist/notices/titan/LICENSES/openssl-LICENSE \
  extension/dist/notices/lua/argparse/LICENSE \
  extension/dist/notices/lua/inspect/LICENSE \
  extension/dist/notices/lua/lpeglabel/LICENSE \
  extension/dist/notices/lua/luafilesystem/LICENSE.html \
  extension/dist/notices/lua/luarocks/COPYING \
  extension/dist/notices/javascript/semver/LICENSE \
  extension/dist/notices/javascript/vscode-languageclient/License.txt \
  extension/dist/titan/share/lua/5.5/c-parser/cdriver.lua \
  extension/dist/titan/share/lua/5.5/inspect.lua \
  extension/dist/titan/share/lua/5.5/relabel.lua \
  extension/dist/titan/share/lua/5.5/titan-compiler/driver.lua \
  extension/dist/titan/share/lua/5.5/titan-compiler/version.lua \
  extension/dist/titan/lib/lua/5.5/lfs.so \
  extension/dist/titan/lib/lua/5.5/lpeglabel.so \
  extension/dist/titan/include/titan.h \
  extension/dist/titan/include/titan/ffi.h \
  extension/dist/titan/include/minicoro.h \
  extension/dist/titan/include/llhttp.h \
  extension/dist/titan/include/sqlite3.h \
  extension/dist/titan/include/openssl/ssl.h \
  extension/dist/titan/include/openssl/e_ostime.h \
  extension/dist/titan/include/uv.h \
  extension/dist/titan/include/lua.h \
  extension/dist/titan/src/lua-5.5.1/lobject.h \
  extension/dist/titan/src/lua-5.5.1/luaconf.h; do
  if ! grep -Fxq "$required" <<<"$contents"; then
    echo "VSIX is missing $required" >&2
    exit 1
  fi
done

if grep -Eq '^extension/(\.agents|\.build|\.titan|node_modules|plugins|src|test)/' \
    <<<"$contents"; then
  echo "VSIX contains a development-only directory" >&2
  exit 1
fi

if grep -Eq '(^|/)\.titan-ls(/|$)' <<<"$contents"; then
  echo "VSIX contains a workspace analysis cache" >&2
  exit 1
fi

if grep -Eq '[.]map$' <<<"$contents"; then
  echo "VSIX contains a source map" >&2
  exit 1
fi

if grep -Eq '^extension/.*([.]a|[.]so[.][^/]*)$' <<<"$contents"; then
  echo "VSIX contains an unexpected archive or versioned native library" >&2
  exit 1
fi

expected_native_modules=$(
  printf '%s\n' \
    extension/dist/titan/lib/lua/5.5/lfs.so \
    extension/dist/titan/lib/lua/5.5/lpeglabel.so |
    LC_ALL=C sort
)
actual_native_modules=$(
  grep -E '^extension/.*[.]so$' <<<"$contents" | LC_ALL=C sort || true
)
if [[ "$actual_native_modules" != "$expected_native_modules" ]]; then
  echo "VSIX native-module inventory does not match the reviewed Lua tree" >&2
  diff -u \
    <(printf '%s\n' "$expected_native_modules") \
    <(printf '%s\n' "$actual_native_modules") || true
  exit 1
fi

unexpected_titan_payload=$(
  grep -E '^extension/dist/titan(/|$)' <<<"$contents" |
    grep -Ev \
      '^extension/dist/titan/?$|^extension/dist/titan/(share|lib|src)/?$|^extension/dist/titan/(share|lib)/lua/?$|^extension/dist/titan/(share|lib)/lua/5[.]5(/.*)?$|^extension/dist/titan/include(/.*)?$|^extension/dist/titan/src/lua-5[.]5[.]1(/.*)?$' \
    || true
)
if [[ -n "$unexpected_titan_payload" ]]; then
  echo "VSIX contains content outside the reviewed compiler module and SDK trees:" >&2
  printf '%s\n' "$unexpected_titan_payload" >&2
  exit 1
fi

if grep -Eq '^extension/dist/titan/(lib/titan|share/titan)(/|$)' \
    <<<"$contents"; then
  echo "VSIX contains Titan provider or non-Lua share content" >&2
  exit 1
fi

extract_root=$(mktemp -d)
trap 'rm -rf -- "$extract_root"' EXIT
unzip -qq "$vsix" \
  extension/bin/titan-language-server \
  'extension/dist/titan/*' \
  -d "$extract_root"
if [[ ! -x "$extract_root/extension/bin/titan-language-server" ]]; then
  echo "VSIX did not preserve the native server executable mode" >&2
  exit 1
fi

compare_packaged_tree() {
  local relative_tree=$1
  local source_tree="$titan_prefix/$relative_tree"
  local packaged_tree="$extract_root/extension/dist/titan/$relative_tree"
  local source_inventory="$extract_root/source-inventory"
  local packaged_inventory="$extract_root/packaged-inventory"

  if [[ ! -d "$source_tree" ]]; then
    echo "source compiler module or SDK tree is missing: $source_tree" >&2
    exit 1
  fi
  if [[ ! -d "$packaged_tree" ]]; then
    echo "packaged compiler module or SDK tree is missing: $packaged_tree" >&2
    exit 1
  fi
  if find "$packaged_tree" ! -type d ! -type f -print -quit |
      grep -q .; then
    echo "packaged tree contains a non-regular entry: $relative_tree" >&2
    exit 1
  fi

  (
    cd "$source_tree"
    find . -type f -print | LC_ALL=C sort
  ) >"$source_inventory"
  (
    cd "$packaged_tree"
    find . -type f -print | LC_ALL=C sort
  ) >"$packaged_inventory"
  if ! diff -u "$source_inventory" "$packaged_inventory"; then
    echo "packaged inventory differs from $source_tree" >&2
    exit 1
  fi

  while IFS= read -r relative_file; do
    if ! cmp -s \
        "$source_tree/$relative_file" \
        "$packaged_tree/$relative_file"; then
      echo "packaged file differs from source: $relative_tree/$relative_file" >&2
      exit 1
    fi
  done <"$source_inventory"
}

compare_packaged_tree share/lua/5.5
compare_packaged_tree lib/lua/5.5
compare_packaged_tree include
compare_packaged_tree src

inspect_native_module() {
  local module=$1
  file "$module"
  case "$(uname -s)" in
    Linux)
      local dependencies
      dependencies=$(ldd "$module")
      printf '%s\n' "$dependencies"
      if grep -Eiq 'lib(lua|titan|uv|ssl|crypto|lpeg|pcre)' \
          <<<"$dependencies"; then
        echo "bundled Lua module has an unexpected runtime dependency: $module" >&2
        exit 1
      fi

      local required_glibc
      required_glibc=$(
        objdump -T "$module" |
          sed -n 's/.*(GLIBC_\([0-9][0-9.]*\)).*/\1/p' |
          sort -Vu |
          tail -n 1
      )
      if [[ -n "$required_glibc" ]]; then
        echo "maximum required GLIBC symbol version: $required_glibc"
      fi
      if [[ -n "${TITAN_MAX_GLIBC_VERSION:-}" ]]; then
        if [[ ! "$TITAN_MAX_GLIBC_VERSION" =~ ^[0-9]+([.][0-9]+)*$ ]]; then
          echo "invalid TITAN_MAX_GLIBC_VERSION: $TITAN_MAX_GLIBC_VERSION" >&2
          exit 2
        fi
        local newest_glibc
        newest_glibc=$(
          printf '%s\n' "$required_glibc" "$TITAN_MAX_GLIBC_VERSION" |
            sort -Vu |
            tail -n 1
        )
        if [[ -n "$required_glibc" &&
              "$newest_glibc" != "$TITAN_MAX_GLIBC_VERSION" ]]; then
          echo "$module requires GLIBC_$required_glibc, newer than the allowed GLIBC_$TITAN_MAX_GLIBC_VERSION baseline" >&2
          exit 1
        fi
      fi
      ;;
    Darwin)
      local dependencies
      dependencies=$(otool -L "$module")
      printf '%s\n' "$dependencies"
      if grep -Eiq 'lib(lua|titan|uv|ssl|crypto|lpeg|pcre)' \
          <<<"$dependencies"; then
        echo "bundled Lua module has an unexpected runtime dependency: $module" >&2
        exit 1
      fi
      ;;
    *)
      echo "native dependency inspection is unsupported on $(uname -s)" >&2
      exit 1
      ;;
  esac
}

inspect_native_module \
  "$extract_root/extension/dist/titan/lib/lua/5.5/lfs.so"
inspect_native_module \
  "$extract_root/extension/dist/titan/lib/lua/5.5/lpeglabel.so"

node_executable=$(command -v node)
sdk_compiler=${CC:-cc}
protocol_root="$extract_root/unrelated-working-directory"
cache_root="$extract_root/compiler-cache"
hostile_titan_root="$extract_root/ambient-titan-must-not-be-used"
mkdir -p \
  "$protocol_root" \
  "$cache_root" \
  "$hostile_titan_root/lib/titan/0.6" \
  "$hostile_titan_root/source"
(
  cd "$protocol_root"
  # Embedded interfaces must remain usable without a C toolchain or ambient
  # Titan SDK headers, including when their metadata contains portable C types.
  unset CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH
  unset TITAN_EXTRA_CPPFLAGS TITAN_EXTRA_CFLAGS
  export CC="$extract_root/c-compiler-must-not-be-used"
  export CCACHE_DISABLE=1
  export LUA_PATH=/ambient/must-not-be-used/?.lua
  export LUA_CPATH=/ambient/must-not-be-used/?.so
  export TITAN_ROCKS_ROOT="$hostile_titan_root"
  export TITAN_PATH="$hostile_titan_root/lib/titan/0.6"
  export TITAN_PATH_0_6="$hostile_titan_root/lib/titan/0.6"
  export TITAN_SOURCE_PATH="$hostile_titan_root/source/?.titan"
  export TITAN_LS_LUA_PATH="$extract_root/extension/dist/titan/share/lua/5.5/?.lua;$extract_root/extension/dist/titan/share/lua/5.5/?/init.lua"
  export TITAN_LS_LUA_CPATH="$extract_root/extension/dist/titan/lib/lua/5.5/?.so"
  export TITAN_PREFIX="$cache_root"
  "$node_executable" "$repository_root/scripts/test-server-protocol.mjs" \
    "$extract_root/extension/bin/titan-language-server" \
    --self-contained-smoke

  # C imports need a C compiler, with all Titan/Lua headers supplied by the
  # extracted package and no checkout-specific include configuration.
  # TITAN_ROCKS_ROOT is an explicit SDK override; allow the packaged native
  # module path to identify the installation for this check.
  unset TITAN_ROCKS_ROOT
  export CC="$sdk_compiler"
  export TITAN_PROBE_CACHE_DISABLE=1
  "$node_executable" "$repository_root/scripts/test-server-protocol.mjs" \
    "$extract_root/extension/bin/titan-language-server" \
    --sdk-smoke
)

manifest=$(unzip -p "$vsix" extension.vsixmanifest)
if ! grep -Fq "TargetPlatform=\"$target\"" <<<"$manifest"; then
  echo "VSIX manifest does not declare TargetPlatform=$target" >&2
  exit 1
fi

echo "validated target-specific VSIX: $vsix ($target)"
