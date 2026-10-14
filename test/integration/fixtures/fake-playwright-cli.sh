#!/bin/sh
exec node "$(dirname "$0")/fake-playwright-cli.mjs" "$@"
