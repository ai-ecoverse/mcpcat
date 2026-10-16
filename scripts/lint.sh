#!/bin/sh
set -eu
npx --no-install @biomejs/biome check .
npm run --silent typecheck
npx --no-install slicc-lint-comments
npx --no-install slicc-no-unit-tests
npx --no-install slicc-agents-md
