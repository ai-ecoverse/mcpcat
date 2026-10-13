#!/bin/sh
set -eu

BIN_NAME="mcpcat"
REPO="ai-ecoverse/mcpcat"

usage() {
  printf 'Usage: sh -s -- [--version VERSION] [--dir INSTALL_DIR] [--help]\n'
  printf '\nInstall %s standalone binary.\n' "$BIN_NAME"
  printf '\nOptions:\n'
  printf '  --version VERSION   Version to install (default: latest)\n'
  printf '  --dir INSTALL_DIR   Installation directory (default: %s/.local/bin)\n' "\$HOME"
  printf '  --help              Show this help\n'
}

VERSION="${VERSION:-}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
BASE_URL="${SLICC_INSTALL_BASE_URL:-}"

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
    x86_64|amd64) printf 'amd64' ;;
    arm64|aarch64) printf 'arm64' ;;
    *) printf '%s: unsupported architecture: %s\n' "$BIN_NAME" "$(uname -m)" >&2; exit 1 ;;
  esac
}

detect_musl() {
  if [ "$(detect_os)" != "linux" ]; then
    return 1
  fi
  for f in /lib/ld-musl-*; do
    if [ -e "$f" ]; then
      return 0
    fi
  done
  if command -v ldd >/dev/null 2>&1; then
    if ldd --version 2>&1 | grep -qi musl; then
      return 0
    fi
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

OS="$(detect_os)"
ARCH="$(detect_arch)"

ASSET="${BIN_NAME}-${OS}-${ARCH}"
if [ "$OS" = "linux" ] && detect_musl; then
  ASSET="${BIN_NAME}-${OS}-${ARCH}-musl"
fi

if [ -z "$BASE_URL" ]; then
  if [ -z "$VERSION" ]; then
    BASE_URL="https://github.com/${REPO}/releases/latest/download"
  else
    BASE_URL="https://github.com/${REPO}/releases/download/v${VERSION}"
  fi
fi

TMPDIR_INSTALL="${INSTALL_DIR}/.mcpcat-install-$$"
mkdir -p "$INSTALL_DIR"
mkdir -p "$TMPDIR_INSTALL"
trap 'rm -rf "$TMPDIR_INSTALL"' EXIT

fetch "${BASE_URL}/SHA256SUMS" "$TMPDIR_INSTALL/SHA256SUMS"

EXPECTED="$(grep "  ${ASSET}\$" "$TMPDIR_INSTALL/SHA256SUMS" | cut -d' ' -f1)"
if [ -z "$EXPECTED" ]; then
  EXPECTED="$(grep " ${ASSET}\$" "$TMPDIR_INSTALL/SHA256SUMS" | cut -d' ' -f1)"
fi
if [ -z "$EXPECTED" ]; then
  printf '%s: no checksum found for %s in SHA256SUMS\n' "$BIN_NAME" "$ASSET" >&2
  exit 1
fi

fetch "${BASE_URL}/${ASSET}" "$TMPDIR_INSTALL/${ASSET}"
checksum_verify "$TMPDIR_INSTALL/${ASSET}" "$EXPECTED"

chmod 755 "$TMPDIR_INSTALL/${ASSET}"
mv "$TMPDIR_INSTALL/${ASSET}" "${INSTALL_DIR}/${BIN_NAME}"

INSTALLED_VERSION="$("${INSTALL_DIR}/${BIN_NAME}" --version 2>/dev/null || printf 'unknown')"
printf '%s %s installed to %s\n' "$BIN_NAME" "$INSTALLED_VERSION" "${INSTALL_DIR}/${BIN_NAME}"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) printf 'Add %s to your PATH: export PATH="%s:%s"\n' "$INSTALL_DIR" "$INSTALL_DIR" "\$PATH" ;;
esac
