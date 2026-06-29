#!/bin/sh
set -eu

export LANG="${LANG:-${SCREEN_PLUS_LOCALE:-en_US.UTF-8}}"
export LC_CTYPE="${LC_CTYPE:-${LANG}}"
unset LC_ALL

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
