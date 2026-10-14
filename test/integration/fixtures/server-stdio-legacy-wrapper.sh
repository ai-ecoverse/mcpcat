#!/bin/sh
exec node "$(dirname "$0")/server-stdio-legacy-pidtrack.mjs" "$@"
