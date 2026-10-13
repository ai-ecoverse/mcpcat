#!/bin/sh
set -eu
npx --no-install @biomejs/biome check .
npm run --silent typecheck
report=$(npx --no-install slicc-lint-comments 2>&1) || true
rest=$(printf '%s\n' "$report" | grep -vE '^ok: |docs/spec\.html:' || true)
if [ -n "$rest" ]; then
  printf '%s\n' "$rest" >&2
  exit 1
fi
npx --no-install slicc-no-unit-tests
npx --no-install slicc-agents-md
