#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 PATH-TO-SERVER" >&2
  exit 2
fi

server=$1
repository_root=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
titan_prefix=${TITAN_PREFIX:-$repository_root/.titan}
if [[ ! -d "$titan_prefix/include" ]]; then
  echo "selected Titan SDK include tree is missing: $titan_prefix/include" >&2
  exit 1
fi
bundled_openssl=0
if [[ -L "$titan_prefix/include/openssl" ||
      ( -e "$titan_prefix/include/openssl" && ! -d "$titan_prefix/include/openssl" ) ]]; then
  echo "selected Titan SDK OpenSSL headers must be a regular directory" >&2
  exit 1
fi
if [[ -d "$titan_prefix/include/openssl" ]]; then
  bundled_openssl=1
fi
if [[ ! -x "$server" ]]; then
  echo "server is missing or not executable: $server" >&2
  exit 1
fi

file "$server"

case "$(uname -s)" in
  Linux)
    dependencies=$(ldd "$server")
    printf '%s\n' "$dependencies"
    if grep -Fq 'not found' <<<"$dependencies"; then
      echo "server has an unresolved dynamic dependency" >&2
      exit 1
    fi
    runtime_dependencies=$dependencies
    if [[ "$bundled_openssl" == 0 ]]; then
      runtime_dependencies=$(grep -Ev '^[[:space:]]*lib(ssl|crypto)[.]so[.]3[[:space:]]' \
        <<<"$dependencies" || true)
    fi
    required_glibc=$(
      objdump -T "$server" |
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
      newest_glibc=$(
        printf '%s\n' "$required_glibc" "$TITAN_MAX_GLIBC_VERSION" |
          sort -Vu |
          tail -n 1
      )
      if [[ -n "$required_glibc" &&
            "$newest_glibc" != "$TITAN_MAX_GLIBC_VERSION" ]]; then
        echo "server requires GLIBC_$required_glibc, newer than the allowed GLIBC_$TITAN_MAX_GLIBC_VERSION baseline" >&2
        exit 1
      fi
    fi
    if grep -Eiq 'lib(lua|uv|ssl|crypto|lpeg|pcre)' <<<"$runtime_dependencies"; then
      echo "server has an unexpected dynamic language/runtime dependency" >&2
      exit 1
    fi
    if ! nm -D --defined-only "$server" |
        grep -E '[[:space:]]lua_gettop$' >/dev/null; then
      echo "server does not export the embedded Lua C API (lua_gettop is absent)" >&2
      exit 1
    fi
    ;;
  Darwin)
    dependencies=$(otool -L "$server")
    printf '%s\n' "$dependencies"
    runtime_dependencies=$dependencies
    if [[ "$bundled_openssl" == 0 ]]; then
      runtime_dependencies=$(grep -Ev '^[[:space:]]+([^[:space:]]*/)?lib(ssl|crypto)[.]3[.]dylib[[:space:]]+[(]' \
        <<<"$dependencies" || true)
    fi
    if grep -Eiq 'lib(lua|uv|ssl|crypto|lpeg|pcre)' <<<"$runtime_dependencies"; then
      echo "server has an unexpected dynamic language/runtime dependency" >&2
      exit 1
    fi
    if ! nm -gU "$server" |
        grep -E '[[:space:]]_lua_gettop$' >/dev/null; then
      echo "server does not export the embedded Lua C API (lua_gettop is absent)" >&2
      exit 1
    fi
    ;;
  *)
    echo "native dependency inspection is unsupported on $(uname -s)" >&2
    exit 1
    ;;
esac
