#!/usr/bin/env bash
# Pre-compiles pivot's subdomain config into claude/dev/dist/create-app-subdomain.cjs.
#
#   claude/dev/build-subdomain-config.sh
#
# Runs the compile inside an isolated hard-linked copy of the pivot module tree
# under /tmp, because componentsjs' scan walks ancestor node_modules — from
# inside ~/Dropbox/Web/solid it reaches the file:-linked sol-components tree and
# dies on a comunica version clash. Hard links, so the 245 MB copy is instant
# and read-only in effect; falls back to a real copy across filesystems.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PIVOT="${DK_PIVOT_DIR:-$HOME/Dropbox/Web/solid/data-kitchen/pivot}"
BUILD=/tmp/ap-pivot-build
OUT="$HERE/dist/create-app-subdomain.cjs"
# The entry config must sit OUTSIDE the module tree — componentsjs resolves a
# config living inside node_modules against that package instead of the app,
# and its css:/pivot: imports then fail to register.
CONFIG="$HERE/ap-subdomain.json"

[ -f "$CONFIG" ] || { echo "no entry config at $CONFIG" >&2; exit 1; }

rm -rf "$BUILD"
mkdir -p "$BUILD/pivot" "$BUILD/ap-config"
cp "$PIVOT/package.json" "$HERE/compile-config.cjs" "$BUILD/pivot/"
cp "$CONFIG" "$BUILD/ap-config/"
cp -al "$PIVOT/node_modules" "$BUILD/pivot/node_modules" 2>/dev/null \
  || cp -r "$PIVOT/node_modules" "$BUILD/pivot/node_modules"

mkdir -p "$HERE/dist"
( cd "$BUILD/pivot" && node compile-config.cjs . "$BUILD/ap-config/$(basename "$CONFIG")" ) > "$OUT.new"
mv "$OUT.new" "$OUT"
rm -rf "$BUILD"
echo "wrote $OUT ($(wc -c < "$OUT") bytes)"
