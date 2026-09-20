#!/bin/sh
# Called synchronously by tmux with its socket path, including during startup.
# Prefer the active Homebrew; standard prefixes also work before shell setup.
if command -v brew >/dev/null 2>&1; then
    prefix=$(brew --prefix 2>/dev/null) || exit 0
else
    prefix=
    for candidate in "${HOMEBREW_PREFIX:-}" /opt/homebrew /home/linuxbrew/.linuxbrew /usr/local; do
        if [ -n "$candidate" ] && [ -x "$candidate/bin/brew" ]; then
            prefix=$candidate
            break
        fi
    done
fi

# Missing Homebrew or Zsh is not an error: retain tmux's default shell.
[ -n "$prefix" ] && [ -x "$prefix/bin/zsh" ] || exit 0
tmux -S "$1" set-option -g default-shell "$prefix/bin/zsh"
