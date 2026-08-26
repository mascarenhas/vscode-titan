#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 PATH-TO-VSIX TARGET-PLATFORM" >&2
  exit 2
fi

vsix=$1
target=$2
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
  extension/dist/notices/javascript/semver/LICENSE \
  extension/dist/notices/javascript/vscode-languageclient/License.txt; do
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

if grep -Eq '[.]map$' <<<"$contents"; then
  echo "VSIX contains a source map" >&2
  exit 1
fi

if grep -Eq '^extension/.*[.](a|so)([.][^/]*)?$' <<<"$contents"; then
  echo "VSIX contains an unexpected native library or archive" >&2
  exit 1
fi

extract_root=$(mktemp -d)
trap 'rm -rf -- "$extract_root"' EXIT
unzip -qq "$vsix" extension/bin/titan-language-server -d "$extract_root"
if [[ ! -x "$extract_root/extension/bin/titan-language-server" ]]; then
  echo "VSIX did not preserve the native server executable mode" >&2
  exit 1
fi

manifest=$(unzip -p "$vsix" extension.vsixmanifest)
if ! grep -Fq "TargetPlatform=\"$target\"" <<<"$manifest"; then
  echo "VSIX manifest does not declare TargetPlatform=$target" >&2
  exit 1
fi

echo "validated target-specific VSIX: $vsix ($target)"
