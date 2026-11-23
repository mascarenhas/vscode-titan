#!/usr/bin/env bash
set -euo pipefail

# The CI release pin selects both the source rock and its exact browser companion.
identify() {
  local version release commit prefix source_dir identity role name entry id digest
  TITAN_RELEASE=${TITAN_RELEASE:-v0.6.1}
  [[ "$TITAN_RELEASE" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
  version=${TITAN_RELEASE#v}
  TITAN_ROCK="titan-$version-1.src.rock"
  TITAN_BROWSER_PACK="titan-$version-1-browser-semantics.tar.gz"

  # LuaRocks configuration stores the absolute installation path. Keep the
  # Windows build and all fixtures on a short local NTFS path, not runner D:.
  if [[ "$RUNNER_OS" == Windows ]]; then
    prefix=C:/titan-sdk
    source_dir=C:/titan-src
    GITHUB_ENV=$(cygpath -u "$GITHUB_ENV")
    GITHUB_OUTPUT=$(cygpath -u "$GITHUB_OUTPUT")
  else
    prefix="$(pwd -P)/.titan-validation"
    source_dir="$RUNNER_TEMP/titan-sdk-sources"
  fi
  printf '%s\n' "TITAN_RELEASE=$TITAN_RELEASE" "TITAN_ROCK=$TITAN_ROCK" \
    "TITAN_BROWSER_PACK=$TITAN_BROWSER_PACK" "TITAN_PREFIX=$prefix" \
    "TITAN_SDK_SOURCES=$source_dir" >> "$GITHUB_ENV"

  # A release can be re-cut under the same tag. Key the SDK on the resolved
  # commit, both asset digests, and the toolchain it actually uses.
  release=$(gh api "repos/mascarenhas/titan/releases/tags/$TITAN_RELEASE")
  commit=$(gh api "repos/mascarenhas/titan/commits/$TITAN_RELEASE" --jq '.sha')
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]]
  printf 'commit=%s\n' "$commit" >> "$GITHUB_OUTPUT"
  for role in rock pack; do
    if [[ "$role" == rock ]]; then name=$TITAN_ROCK; else name=$TITAN_BROWSER_PACK; fi
    entry=$(jq -er --arg n "$name" --arg t "$TITAN_RELEASE" '
      select(.tag_name == $t) | [.assets[] | select(.name == $n)] |
      select(length == 1) | first |
      select((.id | type) == "number" and (.id > 0) and
             (.digest | type) == "string" and (.digest | test("^sha256:[0-9a-f]{64}$"))) |
      [.id, (.digest | sub("^sha256:"; ""))] | @tsv
    ' <<< "$release")
    read -r id digest <<< "$entry"
    printf '%s_id=%s\n%s=%s\n' "$role" "$id" "$role" "$digest" >> "$GITHUB_OUTPUT"
  done

  identity=$({
    toolchain_inputs "$prefix" "$source_dir"
  } | tee "$RUNNER_TEMP/titan-toolchain" | checksum | cut -d' ' -f1)
  cat "$RUNNER_TEMP/titan-toolchain"
  printf 'toolchain=%s\n' "$identity" >> "$GITHUB_OUTPUT"
}

toolchain_inputs() {
  printf '%s\n' "$1" "$2" "$OPENSSL_MODE" "$TITAN_BUILD_PROFILE"
  make --version
  cmake --version
  case "$RUNNER_OS" in
    Linux)
      cc --version
      dpkg-query -W gcc libc6-dev libreadline-dev libssl-dev libuv1-dev
      ;;
    macOS)
      test "$(uname -m)" = arm64
      sw_vers
      cc --version
      xcrun --show-sdk-path
      brew list --versions readline
      ;;
    Windows)
      test "$MSYSTEM" = CLANG64
      test "$(uname -m)" = x86_64
      cygpath -m /clang64
      pacman -Q
      ;;
  esac
}

checksum() {
  if [[ "$RUNNER_OS" == macOS ]]; then shasum -a 256 "$@"; else sha256sum "$@"; fi
}

fetch_asset() {
  gh api -H 'Accept: application/octet-stream' \
    "repos/mascarenhas/titan/releases/assets/$1" > "$2"
}

install_compiler() {
  local rock="$TITAN_SDK_SOURCES/$TITAN_ROCK"
  mkdir -p "$TITAN_SDK_SOURCES"
  fetch_asset "$ROCK_ID" "$rock"
  printf '%s  %s\n' "$ROCK_SHA256" "$rock" | checksum -c
  if [[ "$RUNNER_OS" == Windows ]]; then
    unzip -q "$rock" -d "$TITAN_SDK_SOURCES"
    (
      cd "$TITAN_SDK_SOURCES/titan"
      unset LD
      export PREFIX="$TITAN_PREFIX" NATIVE_CFLAGS='-O0 -fno-lto'
      mingw32-make -f Makefile.win toolchain-check lua luarocks
    )
    export PATH="$(cygpath -u "$TITAN_PREFIX")/bin:$PATH"
    export LUAROCKS_CONFIG="$TITAN_PREFIX/etc/luarocks/config-5.5.lua"
    install_components "$TITAN_PREFIX/bin/luarocks.exe"
    # The rock's Windows platform recipe uses Makefile.win, not the Unix Makefile.
    (
      cd "$TITAN_SDK_SOURCES/titan"
      unset LD
      export PREFIX="$TITAN_PREFIX" NATIVE_CFLAGS='-O0 -fno-lto'
      mingw32-make -f Makefile.win compiler
    )
  else
    install_unix_bootstrap
    export PATH="$TITAN_PREFIX/bin:$PATH"
    install_components "$TITAN_PREFIX/bin/luarocks"
    "$TITAN_PREFIX/bin/luarocks" --tree="$TITAN_PREFIX" install "$rock"
  fi
}

install_unix_bootstrap() (
  cd "$TITAN_SDK_SOURCES"
  mkdir lua
  curl -fL --retry 3 -o lua.tar.gz \
    "https://github.com/mascarenhas/lua-5.5.1/archive/refs/tags/$LUA_RELEASE.tar.gz"
  tar -xzf lua.tar.gz --strip-components=1 -C lua
  local flags='-O2 -fno-lto' platform=linux-readline readline_prefix
  if [[ "$RUNNER_OS" == macOS ]]; then
    platform=macosx
    readline_prefix=$(brew --prefix readline)
    make -C lua -j"$TITAN_JOBS" "$platform" PREFIX="$TITAN_PREFIX" CC=cc \
      MYCFLAGS="$flags -I$readline_prefix/include" MYLDFLAGS="$flags -L$readline_prefix/lib"
  else
    make -C lua -j"$TITAN_JOBS" "$platform" PREFIX="$TITAN_PREFIX" CC=cc \
      MYCFLAGS="$flags" MYLDFLAGS="$flags"
  fi
  make -C lua install PREFIX="$TITAN_PREFIX"

  curl -fL --retry 3 -o luarocks.tar.gz \
    "https://luarocks.org/releases/luarocks-$LUAROCKS_VERSION.tar.gz"
  tar -xzf luarocks.tar.gz
  cd "luarocks-$LUAROCKS_VERSION"
  ./configure --prefix="$TITAN_PREFIX" --rocks-tree="$TITAN_PREFIX" \
    --with-lua="$TITAN_PREFIX" --force-config
  make LUA_DIR="$TITAN_PREFIX"
  make install LUA_DIR="$TITAN_PREFIX"
)

install_components() {
  local luarocks=$1 components name version
  # Install the VSIX's exact bundled dependency versions before resolving the
  # compiler rock's dependency ranges.
  components=$(node --input-type=module -e '
    import { compilerRocks } from "./scripts/compiler-rocks.mjs";
    for (const rock of compilerRocks()) console.log(`${rock.directory ?? rock.rockName} ${rock.version}`);
  ' | tr -d '\r')
  test -n "$components"
  while read -r name version; do
    "$luarocks" --lua-version=5.5 --tree="$TITAN_PREFIX" install "$name" "$version"
  done <<< "$components"
}

verify_sdk() {
  local compiler="$TITAN_PREFIX/bin/titanc" suffix=so
  if [[ "$RUNNER_OS" == Windows ]]; then
    compiler+=.exe
    suffix=dll
    test -s "$TITAN_PREFIX/lib/titan/0.6/titan.dll"
    test -s "$TITAN_PREFIX/bin/libssl-3-x64.dll"
    test -s "$TITAN_PREFIX/bin/libcrypto-3-x64.dll"
  else
    test -s "$TITAN_PREFIX/lib/titan/0.6/titan.a"
  fi
  test -x "$compiler"
  test -s "$TITAN_PREFIX/lib/titan/0.6/libtitan.a"
  test -s "$TITAN_PREFIX/lib/lua/5.5/titan.$suffix"
  test -s "$TITAN_PREFIX/include/titan/ffi.h"
  test -s "$TITAN_PREFIX/src/lua-5.5.1/lua.h"
  test -s "$TITAN_PREFIX/share/titan/LICENSE"
  test "$(tr -d '\r' < "$TITAN_PREFIX/etc/titan/build-profile")" = "$TITAN_BUILD_PROFILE"

  local actual
  actual=$("$compiler" --print-root | tr -d '\r')
  if [[ "$RUNNER_OS" == Windows ]]; then actual=$(cygpath -m "$actual"); fi
  test "$actual" = "$TITAN_PREFIX"
  "$compiler" --help
}

verify_pack() {
  # Re-fetch on a cache hit too: a warm SDK must contain these exact bytes,
  # not merely a compatible browser provider.
  local archive="$TITAN_SDK_SOURCES/$TITAN_BROWSER_PACK"
  mkdir -p "$TITAN_SDK_SOURCES"
  fetch_asset "$PACK_ID" "$archive"
  node scripts/browser-semantic-pack.mjs --install "$TITAN_PREFIX" "$archive" \
    "$PACK_SHA256" "$ROCK_SHA256" "$TITAN_COMMIT" production
  TITAN_ROOT="$TITAN_PREFIX" TITAN_TEST_BROWSER_COMPANION="$archive" \
    TITAN_TEST_BROWSER_COMPANION_SHA256="$PACK_SHA256" \
    TITAN_TEST_BROWSER_ROCK_SHA256="$ROCK_SHA256" \
    TITAN_TEST_BROWSER_COMMIT="$TITAN_COMMIT" TITAN_TEST_BROWSER_PROFILE=production \
    node --test scripts/browser-semantic-pack.test.mjs
}

case ${1:-} in
  identify) identify ;;
  install) install_compiler ;;
  inspect) verify_sdk ;;
  pack) verify_pack ;;
  *) echo 'usage: bash scripts/ci-titan-sdk.sh {identify|install|inspect|pack}' >&2; exit 2 ;;
esac
