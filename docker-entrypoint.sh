#!/bin/sh
set -eu

mkdir -p "${SCREEN_PLUS_STATE_DIR:-/data}"

if [ -n "${HOME:-}" ]; then
  mkdir -p "$HOME"
fi

if [ -n "${ZDOTDIR:-}" ]; then
  mkdir -p "$ZDOTDIR"
  if [ ! -f "$ZDOTDIR/.zshrc" ]; then
    cp /opt/screen-plus/zshrc "$ZDOTDIR/.zshrc"
  fi
  touch "$ZDOTDIR/.zsh_history"
fi

exec "$@"
