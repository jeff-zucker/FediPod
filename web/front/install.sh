#!/bin/sh
# FediPod installer.  Usage:  curl -fsSL https://fedipod.net/install | sh
# Installs into ~/FediPod (or $FEDIPOD_DIR); re-running updates the install.
#
# A signup page may append parameters (sh -s -- --gateway ... --secret ...);
# they are saved for the first `npm start`, whose setup opens pre-filled and
# attaches to the gateway when it completes.
set -eu

REPO="https://github.com/jeff-zucker/FediPod"
DIR="${FEDIPOD_DIR:-$HOME/FediPod}"

say() { printf '%s\n' "$*"; }
fail() { printf 'fedipod install: %s\n' "$*" >&2; exit 1; }

GATEWAY= SECRET= POD= ISSUER= HANDLE= KIND=person FRONTED=false
while [ $# -gt 0 ]; do
  case "$1" in
    --gateway) GATEWAY=$2; shift 2;;
    --secret)  SECRET=$2;  shift 2;;
    --pod)     POD=$2;     shift 2;;
    --issuer)  ISSUER=$2;  shift 2;;
    --handle)  HANDLE=$2;  shift 2;;
    --kind)    KIND=$2;    shift 2;;
    --fronted) FRONTED=true; shift;;
    *) fail "unknown option $1";;
  esac
done

command -v git >/dev/null 2>&1 || fail "git is required — install it from https://git-scm.com/ and re-run"
command -v node >/dev/null 2>&1 || fail "node 20 or newer is required — install it from https://nodejs.org/ and re-run"
command -v npm >/dev/null 2>&1 || fail "npm is required (it ships with node) — install node from https://nodejs.org/ and re-run"

major=$(node -v | sed 's/^v//' | cut -d. -f1)
[ "$major" -ge 20 ] 2>/dev/null || fail "node 20 or newer is required (found $(node -v))"

if [ -d "$DIR/.git" ]; then
  say "updating the existing install in $DIR"
  git -C "$DIR" pull --ff-only || fail "could not update $DIR — it has local changes; update it by hand"
elif [ -e "$DIR" ]; then
  fail "$DIR exists and is not a FediPod checkout — set FEDIPOD_DIR to another location and re-run"
else
  say "installing into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
npm install --omit=dev --no-audit --no-fund

if [ -n "$HANDLE" ]; then
  printf '{"handle":"%s","kind":"%s","pod":"%s","issuer":"%s","gateway":"%s","secret":"%s","fronted":%s}\n' \
    "$HANDLE" "$KIND" "$POD" "$ISSUER" "$GATEWAY" "$SECRET" "$FRONTED" > "$DIR/first-run.json"
  chmod 600 "$DIR/first-run.json"
fi

say ""
say "Installed. To start (first run opens setup in your browser):"
say ""
say "  cd $DIR && npm start"
