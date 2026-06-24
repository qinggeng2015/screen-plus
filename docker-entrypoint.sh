#!/bin/sh
set -eu

mkdir -p "${SCREEN_PLUS_STATE_DIR:-/data}"
exec "$@"
