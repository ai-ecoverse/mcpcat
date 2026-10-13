#!/bin/sh
set -eu

BIN_NAME="mcpcat"
REPO="ai-ecoverse/mcpcat"
MIN_NODE=24
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/mcpcat"

usage() {
  printf 'Usage: sh -s -- [--version VERSION] [--dir INSTALL_DIR] [--help]\n'
  printf '\nInstall %s (Node %s+ required; downloaded if missing).\n' "$BIN_NAME" "$MIN_NODE"
  printf '\nOptions:\n'
  printf '  --version VERSION   Version to install (default: latest)\n'
  printf '  --dir INSTALL_DIR   Launcher directory (default: %s/.local/bin)\n' "\$HOME"
  printf '  --help              Show this help\n'
}

VERSION="${VERSION:-}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
BASE_URL="${SLICC_INSTALL_BASE_URL:-}"
NODE_DIST_BASE="${SLICC_NODE_DIST_BASE:-https://nodejs.org/dist}"

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --help) usage; exit 0 ;;
    *) printf '%s: unknown option: %s\n' "$BIN_NAME" "$1" >&2; exit 1 ;;
  esac
done

detect_os() {
  case "$(uname -s)" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    *) printf '%s: unsupported OS: %s\n' "$BIN_NAME" "$(uname -s)" >&2
       printf 'Install via npm instead: npm install -g @ai-ecoverse/mcpcat\n' >&2
       exit 1 ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64' ;;
    arm64|aarch64) printf 'arm64' ;;
    *) printf '%s: unsupported architecture: %s\n' "$BIN_NAME" "$(uname -m)" >&2; exit 1 ;;
  esac
}

is_musl() {
  for f in /lib/ld-musl-*; do
    if [ -e "$f" ]; then return 0; fi
  done
  if command -v ldd >/dev/null 2>&1; then
    if ldd --version 2>&1 | grep -qi musl; then return 0; fi
  fi
  return 1
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    printf '%s: curl or wget required\n' "$BIN_NAME" >&2
    exit 1
  fi
}

fetch_text() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$1"
  else
    printf '%s: curl or wget required\n' "$BIN_NAME" >&2
    exit 1
  fi
}

checksum_verify() {
  _file="$1"
  _expected="$2"
  if command -v sha256sum >/dev/null 2>&1; then
    _actual="$(sha256sum "$_file" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    _actual="$(shasum -a 256 "$_file" | cut -d' ' -f1)"
  else
    printf '%s: sha256sum or shasum required\n' "$BIN_NAME" >&2
    exit 1
  fi
  if [ "$_actual" != "$_expected" ]; then
    printf '%s: checksum mismatch for %s\n' "$BIN_NAME" "$_file" >&2
    printf '  expected: %s\n' "$_expected" >&2
    printf '  actual:   %s\n' "$_actual" >&2
    exit 1
  fi
}

node_version_ok() {
  _node="$1"
  _ver="$("$_node" --version 2>/dev/null)" || return 1
  _major="$(printf '%s' "$_ver" | sed 's/^v//' | cut -d. -f1)"
  [ "$_major" -ge "$MIN_NODE" ] 2>/dev/null
}

find_node() {
  if command -v node >/dev/null 2>&1 && node_version_ok node; then
    command -v node
    return 0
  fi
  _managed="$DATA_DIR/node/bin/node"
  if [ -x "$_managed" ] && node_version_ok "$_managed"; then
    printf '%s' "$_managed"
    return 0
  fi
  return 1
}

ensure_node() {
  if _found="$(find_node)"; then
    printf '%s' "$_found"
    return 0
  fi

  OS="$(detect_os)"
  ARCH="$(detect_arch)"

  if [ "$OS" = "linux" ] && is_musl; then
    printf '%s: musl detected; no official Node binary available.\n' "$BIN_NAME" >&2
    printf 'Install Node with your package manager, e.g. apk add nodejs, then re-run.\n' >&2
    exit 1
  fi

  printf 'No suitable Node found; downloading official LTS...\n' >&2
  LTS_VERSION="$(fetch_text "${NODE_DIST_BASE}/index.json" | \
    sed -n 's/.*"version":"\([^"]*\)".*"lts":[^f][^a][^l][^s][^e].*/\1/p' | head -1)"

  if [ -z "$LTS_VERSION" ]; then
    printf '%s: could not determine latest LTS version\n' "$BIN_NAME" >&2
    exit 1
  fi

  NODE_ARCHIVE="node-${LTS_VERSION}-${OS}-${ARCH}.tar.xz"
  NODE_URL="${NODE_DIST_BASE}/${LTS_VERSION}/${NODE_ARCHIVE}"
  SUMS_URL="${NODE_DIST_BASE}/${LTS_VERSION}/SHASUMS256.txt"

  TMPD="$(mktemp -d)"

  fetch "$SUMS_URL" "$TMPD/SHASUMS256.txt"
  fetch "$NODE_URL" "$TMPD/$NODE_ARCHIVE"

  EXPECTED="$(grep "  ${NODE_ARCHIVE}$" "$TMPD/SHASUMS256.txt" | cut -d' ' -f1)"
  if [ -z "$EXPECTED" ]; then
    EXPECTED="$(grep " ${NODE_ARCHIVE}$" "$TMPD/SHASUMS256.txt" | cut -d' ' -f1)"
  fi
  if [ -z "$EXPECTED" ]; then
    printf '%s: no checksum for %s in SHASUMS256.txt\n' "$BIN_NAME" "$NODE_ARCHIVE" >&2
    rm -rf "$TMPD"
    exit 1
  fi
  checksum_verify "$TMPD/$NODE_ARCHIVE" "$EXPECTED"

  NODE_DEST="$DATA_DIR/node"
  mkdir -p "$DATA_DIR"
  EXTRACT_TMP="$DATA_DIR/.node-install-$$"
  rm -rf "$EXTRACT_TMP"
  mkdir -p "$EXTRACT_TMP"

  if command -v xz >/dev/null 2>&1; then
    xz -dc "$TMPD/$NODE_ARCHIVE" | tar xf - -C "$EXTRACT_TMP" --strip-components=1
  elif command -v tar >/dev/null 2>&1; then
    tar xf "$TMPD/$NODE_ARCHIVE" -C "$EXTRACT_TMP" --strip-components=1
  else
    printf '%s: tar with xz support required\n' "$BIN_NAME" >&2
    rm -rf "$TMPD" "$EXTRACT_TMP"
    exit 1
  fi
  rm -rf "$TMPD"

  rm -rf "$NODE_DEST"
  mv "$EXTRACT_TMP" "$NODE_DEST"

  printf 'Installed Node %s to %s\n' "$LTS_VERSION" "$NODE_DEST" >&2
  printf '%s' "$NODE_DEST/bin/node"
}

OS="$(detect_os)"

if [ -z "$BASE_URL" ]; then
  if [ -z "$VERSION" ]; then
    BASE_URL="https://github.com/${REPO}/releases/latest/download"
  else
    BASE_URL="https://github.com/${REPO}/releases/download/v${VERSION}"
  fi
fi

TMPD_INSTALL="$(mktemp -d)"
trap 'rm -rf "$TMPD_INSTALL"' EXIT

fetch "${BASE_URL}/SHA256SUMS" "$TMPD_INSTALL/SHA256SUMS"

TGZ_PATTERN="mcpcat-.*\.tgz"
TGZ_NAME="$(grep "$TGZ_PATTERN" "$TMPD_INSTALL/SHA256SUMS" | head -1 | sed 's/.*  //')"
if [ -z "$TGZ_NAME" ]; then
  printf '%s: no .tgz found in SHA256SUMS\n' "$BIN_NAME" >&2
  exit 1
fi

EXPECTED="$(grep "  ${TGZ_NAME}$" "$TMPD_INSTALL/SHA256SUMS" | cut -d' ' -f1)"
if [ -z "$EXPECTED" ]; then
  printf '%s: no checksum for %s\n' "$BIN_NAME" "$TGZ_NAME" >&2
  exit 1
fi

fetch "${BASE_URL}/${TGZ_NAME}" "$TMPD_INSTALL/${TGZ_NAME}"
checksum_verify "$TMPD_INSTALL/${TGZ_NAME}" "$EXPECTED"

BUNDLE_VERSION="$(printf '%s' "$TGZ_NAME" | sed 's/^mcpcat-//; s/\.tgz$//')"
BUNDLE_DIR="$DATA_DIR/$BUNDLE_VERSION"
mkdir -p "$DATA_DIR"
EXTRACT_TMP="$DATA_DIR/.bundle-install-$$"
rm -rf "$EXTRACT_TMP"
mkdir -p "$EXTRACT_TMP"
tar xzf "$TMPD_INSTALL/${TGZ_NAME}" -C "$EXTRACT_TMP" --strip-components=1

rm -rf "$BUNDLE_DIR"
mv "$EXTRACT_TMP" "$BUNDLE_DIR"

CURRENT_LINK="$DATA_DIR/current"
rm -f "$CURRENT_LINK"
ln -s "$BUNDLE_VERSION" "$CURRENT_LINK"

NODE_BIN="$(ensure_node)"
NODE_ABS="$(cd "$(dirname "$NODE_BIN")" && pwd)/$(basename "$NODE_BIN")"
ENTRY="$BUNDLE_DIR/dist/host/mcpcat.mjs"

mkdir -p "$INSTALL_DIR"
LAUNCHER="$INSTALL_DIR/$BIN_NAME"
LAUNCHER_TMP="${LAUNCHER}.tmp.$$"
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE_ABS" "$ENTRY" > "$LAUNCHER_TMP"
chmod 755 "$LAUNCHER_TMP"
mv "$LAUNCHER_TMP" "$LAUNCHER"

INSTALLED_VERSION="$("$LAUNCHER" --version 2>/dev/null || printf 'unknown')"
printf '%s %s installed to %s\n' "$BIN_NAME" "$INSTALLED_VERSION" "$LAUNCHER"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) printf 'Add %s to your PATH: export PATH="%s:%s"\n' "$INSTALL_DIR" "$INSTALL_DIR" "\$PATH" ;;
esac
