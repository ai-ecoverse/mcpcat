#!/bin/sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

ASSET_DIR="${1:?usage: test-install.sh <asset-dir> [expected-version]}"
ASSET_DIR="$(cd "$ASSET_DIR" && pwd)"
EXPECTED_VERSION="${2:-}"

INSTALL_DIR="$(mktemp -d)"
DATA_DIR="$(mktemp -d)"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  rm -rf "$INSTALL_DIR" "$DATA_DIR"
}
trap cleanup EXIT

PORT_FILE="$(mktemp)"
python3 -c "
import http.server, socketserver, os
os.chdir('$ASSET_DIR')
h = http.server.SimpleHTTPRequestHandler
s = socketserver.TCPServer(('127.0.0.1', 0), h)
with open('$PORT_FILE', 'w') as f:
    f.write(str(s.server_address[1]))
s.serve_forever()
" 2>/dev/null &
SERVER_PID=$!

SERVER_PORT=""
i=0
while [ -z "$SERVER_PORT" ] && [ "$i" -lt 100 ]; do
  kill -0 "$SERVER_PID" 2>/dev/null || break
  SERVER_PORT=$(cat "$PORT_FILE")
  [ -n "$SERVER_PORT" ] || sleep 0.1
  i=$((i + 1))
done
rm -f "$PORT_FILE"

if [ -z "$SERVER_PORT" ]; then
  fail "could not start asset server"
fi

BASE="http://127.0.0.1:${SERVER_PORT}"
printf 'Asset server on %s\n' "$BASE"

printf 'Test 1: install with custom dir\n'
XDG_DATA_HOME="$DATA_DIR" SLICC_INSTALL_BASE_URL="$BASE" INSTALL_DIR="$INSTALL_DIR" sh "$ROOT/install.sh"
test -x "$INSTALL_DIR/mcpcat" || fail "launcher not installed"
VERSION="$("$INSTALL_DIR/mcpcat" --version)"
printf 'Installed version: %s\n' "$VERSION"
test -n "$VERSION" || fail "no version output"
if [ -n "$EXPECTED_VERSION" ]; then
  test "$VERSION" = "$EXPECTED_VERSION" || fail "version mismatch: got $VERSION, expected $EXPECTED_VERSION"
fi
case "${EXPECT_MANAGED_NODE:-}" in
  1) test -x "$DATA_DIR/mcpcat/node/bin/node" || fail "expected the installer to download node into $DATA_DIR/mcpcat/node" ;;
  0) test ! -e "$DATA_DIR/mcpcat/node" || fail "node was downloaded even though it was on PATH" ;;
esac

printf 'Test 2: idempotent reinstall\n'
XDG_DATA_HOME="$DATA_DIR" SLICC_INSTALL_BASE_URL="$BASE" INSTALL_DIR="$INSTALL_DIR" sh "$ROOT/install.sh"
VERSION2="$("$INSTALL_DIR/mcpcat" --version)"
test "$VERSION" = "$VERSION2" || fail "version changed after reinstall"

printf 'Test 3: checksum mismatch\n'
cp "$ASSET_DIR/SHA256SUMS" "$ASSET_DIR/SHA256SUMS.bak"
sed 's/^.\{8\}/aaaaaaaa/' "$ASSET_DIR/SHA256SUMS.bak" > "$ASSET_DIR/SHA256SUMS"
if XDG_DATA_HOME="$DATA_DIR" SLICC_INSTALL_BASE_URL="$BASE" INSTALL_DIR="$INSTALL_DIR" sh "$ROOT/install.sh" 2>/dev/null; then
  cp "$ASSET_DIR/SHA256SUMS.bak" "$ASSET_DIR/SHA256SUMS"
  fail "should have rejected tampered checksum"
fi
cp "$ASSET_DIR/SHA256SUMS.bak" "$ASSET_DIR/SHA256SUMS"
rm -f "$ASSET_DIR/SHA256SUMS.bak"

printf 'All installer tests passed.\n'
