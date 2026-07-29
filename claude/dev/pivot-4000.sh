#!/usr/bin/env bash
# A subdomain-authed pivot/CSS on :4000 over a fresh root — the local pod
# activitypod-js is developed against when a public pod is unavailable.
#
#   claude/dev/pivot-4000.sh [root] [port]
#
# Subdomain identifiers, not path ones: pods land at http://<name>.localhost:4000/,
# which owns its host and can therefore answer WebFinger for a handle. dk's own
# pre-compiled config bakes path identifiers and allow-all, so this uses its own
# compiled config (build-subdomain-config.sh) with webacl enforcement.
#
# The root is deliberately NOT ~/solid: that tree is served by the no-auth
# server on :3000, and two servers with opposite assumptions about auth writing
# one tree corrupts both.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PIVOT="${DK_PIVOT_DIR:-$HOME/Dropbox/Web/solid/data-kitchen/pivot}"
ROOT="${1:-$HERE/pod-root}"
PORT="${2:-4000}"
APP="$HERE/dist/create-app-subdomain.cjs"

[ -f "$APP" ] || { echo "no compiled config — run claude/dev/build-subdomain-config.sh first" >&2; exit 1; }
[ -d "$PIVOT/node_modules/@solid/community-server" ] || { echo "no CSS under $PIVOT (set DK_PIVOT_DIR)" >&2; exit 1; }
mkdir -p "$ROOT"

# The compiled config requires CSS by bare specifier, and this project does not
# depend on it — resolve those from the pivot tree it was compiled against.
export NODE_PATH="$PIVOT/node_modules"
exec node "$HERE/run-subdomain-server.cjs" "$ROOT" "$PORT"
