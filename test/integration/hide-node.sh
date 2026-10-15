#!/bin/sh
set -eu

i=0
while node_path="$(command -v node 2>/dev/null)" && [ -n "$node_path" ]; do
  i=$((i + 1))
  [ "$i" -le 10 ] || { printf 'FAIL: node still on PATH at %s\n' "$node_path" >&2; exit 1; }
  printf 'Removing %s\n' "$node_path"
  rm -f "$node_path" 2>/dev/null || sudo rm -f "$node_path"
  hash -r 2>/dev/null || true
done
printf 'node removed from PATH\n'
