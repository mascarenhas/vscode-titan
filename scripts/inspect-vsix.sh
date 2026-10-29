#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 PATH-TO-VSIX TARGET-PLATFORM" >&2
  exit 2
fi

vsix=$1
target=$2
repository_root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
titan_prefix=$(node "$repository_root/scripts/titan-sdk.mjs" --print-prefix)
bundled_openssl=0
if [[ -L "$titan_prefix/include/openssl" ||
      ( -e "$titan_prefix/include/openssl" && ! -d "$titan_prefix/include/openssl" ) ]]; then
  echo "selected Titan SDK OpenSSL headers must be a regular directory" >&2
  exit 1
fi
if [[ -d "$titan_prefix/include/openssl" ]]; then
  bundled_openssl=1
fi
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
  extension/dist/notices/titan/LICENSES/libuv-LICENSE-extra \
  extension/dist/notices/titan/LICENSES/libuv-tree-LICENSE \
  extension/dist/notices/titan/LICENSES/libuv-inet-LICENSE \
  extension/dist/notices/titan/LICENSES/openssl-LICENSE \
  extension/dist/notices/lua/argparse/LICENSE \
  extension/dist/notices/lua/inspect/LICENSE \
  extension/dist/notices/lua/lpeglabel/LICENSE \
  extension/dist/notices/lua/luafilesystem/LICENSE.html \
  extension/dist/notices/javascript/semver/LICENSE \
  extension/dist/notices/javascript/vscode-languageclient/License.txt \
  extension/dist/titan/share/lua/5.5/c-parser/cdriver.lua \
  extension/dist/titan/share/lua/5.5/inspect.lua \
  extension/dist/titan/share/lua/5.5/relabel.lua \
  extension/dist/titan/share/lua/5.5/titan-compiler/driver.lua \
  extension/dist/titan/share/lua/5.5/titan-compiler/maybe3.lua \
  extension/dist/titan/share/lua/5.5/titan-compiler/path.lua \
  extension/dist/titan/share/lua/5.5/titan-compiler/documentation.lua \
  extension/dist/titan/share/lua/5.5/titan-compiler/completion.lua \
  extension/dist/titan/share/lua/5.5/titan-compiler/checker/completion.lua \
  extension/dist/titan/share/lua/5.5/titan-compiler/version.lua \
  extension/dist/titan/lib/lua/5.5/lfs.so \
  extension/dist/titan/lib/lua/5.5/lpeglabel.so \
  extension/dist/titan/lib/lua/5.5/luv.so \
  extension/dist/titan/include/titan.h \
  extension/dist/titan/include/titan/ffi.h \
  extension/dist/titan/include/minicoro.h \
  extension/dist/titan/include/llhttp.h \
  extension/dist/titan/include/sqlite3.h \
  extension/dist/titan/include/uv.h \
  extension/dist/titan/include/lua.h \
  extension/dist/titan/src/lua-5.5.1/lobject.h \
  extension/dist/titan/src/lua-5.5.1/luaconf.h; do
  if ! grep -Fxq "$required" <<<"$contents"; then
    echo "VSIX is missing $required" >&2
    exit 1
  fi
done

if [[ "$bundled_openssl" == 1 ]]; then
  for header in ssl.h crypto.h opensslv.h; do
    required="extension/dist/titan/include/openssl/$header"
    if ! grep -Fxq "$required" <<<"$contents"; then
      echo "VSIX is missing $required" >&2
      exit 1
    fi
  done
fi

if grep -Eq '^extension/(\.agents|\.build|\.titan(-validation)?|node_modules|plugins|src|test)/' \
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
    extension/dist/titan/lib/lua/5.5/lpeglabel.so \
    extension/dist/titan/lib/lua/5.5/luv.so |
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

node "$repository_root/scripts/stage-lua-modules.mjs" --check-payload \
  "$titan_prefix" "$extract_root/extension/dist/titan"

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
inspect_native_module \
  "$extract_root/extension/dist/titan/lib/lua/5.5/luv.so"

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
  export TITAN_ROOT="$hostile_titan_root"
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
  # The extracted compiler payload is a complete installation root, exactly as
  # the extension names it at launch; SDK-backed C imports read its headers and
  # Lua sources instead of deriving them from a Lua path.
  export TITAN_ROOT="$extract_root/extension/dist/titan"
  export CC="$sdk_compiler"
  export TITAN_PROBE_CACHE_DISABLE=1
  if [[ "$bundled_openssl" == 0 ]]; then
    openssl_pkg_config=${OPENSSL_PKG_CONFIG:-pkg-config}
    if ! VSCODE_TITAN_OPENSSL_CPPFLAGS=$("$openssl_pkg_config" --cflags openssl); then
      echo "system OpenSSL SDK smoke requires pkg-config OpenSSL compiler flags" >&2
      exit 1
    fi
    export VSCODE_TITAN_OPENSSL_CPPFLAGS
  else
    unset VSCODE_TITAN_OPENSSL_CPPFLAGS
  fi
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
