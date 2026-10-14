#!/bin/sh
case "$1" in
  --mcp)
    printf '%s\n' '{"commands":[{"name":"echo","description":"Echo the text argument","positionals":[{"name":"text","required":true}],"flags":[]}]}'
    ;;
  echo)
    shift
    printf '%s\n' "$*"
    ;;
  *)
    printf 'unknown command: %s\n' "$1" >&2
    exit 1
    ;;
esac
