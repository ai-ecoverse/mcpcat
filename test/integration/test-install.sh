#!/bin/sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

ASSET_DIR="${1:?usage: test-install.sh <asset-dir>}"
ASSET_DIR="$(cd "$ASSET_DIR" && pwd)"

INSTALL_DIR="$(mktemp -d)"
trap 'rm -rf "$INSTALL_DIR"' EXIT

serve_assets() {
  python3 -m http.server 0 --directory "$ASSET_DIR" 2>/dev/null &
  _pid=$!
  sleep 1
  _port=$(lsof -iTCP -sTCP:LISTEN -nP -a -p "$_pid" 2>/dev/null | grep -o ':\([0-9]*\) ' | head -1 | tr -d ': ')
  if [ -z "$_port" ]; then
    _port=$(ss -tlnp 2>/dev/null | grep "pid=$_pid" | grep -o ':\([0-9]*\) ' | head -1 | tr -d ': ')
  fi
  printf '%s %s' "$_pid" "$_port"
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

read -r SERVER_PID SERVER_PORT <<EOF
$(serve_assets)
EOF

if [ -z "$SERVER_PORT" ]; then
  fail "could not start asset server"
fi
trap 'kill "$SERVER_PID" 2>/dev/null; rm -rf "$INSTALL_DIR"' EXIT

BASE="http://127.0.0.1:${SERVER_PORT}"

printf 'Asset server on %s\n' "$BASE"

printf 'Test 1: install with custom dir\n'
SLICC_INSTALL_BASE_URL="$BASE" INSTALL_DIR="$INSTALL_DIR" sh "$ROOT/install.sh"
test -x "$INSTALL_DIR/mcpcat" || fail "binary not installed"
VERSION="$("$INSTALL_DIR/mcpcat" --version)"
printf 'Installed version: %s\n' "$VERSION"
test -n "$VERSION" || fail "no version output"

printf 'Test 2: idempotent reinstall\n'
SLICC_INSTALL_BASE_URL="$BASE" INSTALL_DIR="$INSTALL_DIR" sh "$ROOT/install.sh"
VERSION2="$("$INSTALL_DIR/mcpcat" --version)"
test "$VERSION" = "$VERSION2" || fail "version changed after reinstall"

printf 'Test 3: checksum mismatch\n'
cp "$ASSET_DIR/SHA256SUMS" "$ASSET_DIR/SHA256SUMS.bak"
sed 's/^.\{8\}/aaaaaaaa/' "$ASSET_DIR/SHA256SUMS.bak" > "$ASSET_DIR/SHA256SUMS"
if SLICC_INSTALL_BASE_URL="$BASE" INSTALL_DIR="$INSTALL_DIR" sh "$ROOT/install.sh" 2>/dev/null; then
  cp "$ASSET_DIR/SHA256SUMS.bak" "$ASSET_DIR/SHA256SUMS"
  fail "should have rejected tampered checksum"
fi
cp "$ASSET_DIR/SHA256SUMS.bak" "$ASSET_DIR/SHA256SUMS"
rm -f "$ASSET_DIR/SHA256SUMS.bak"

printf 'All installer tests passed.\n'
