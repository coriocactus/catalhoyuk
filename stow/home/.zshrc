# =============================================================================
# ▬▬▬.◙.▬▬▬
# ═▂▄▄▓▄▄▂
# ◢◤ █▀▀████▄▄▄◢◤
# █▄ █ █▄ ███▀▀▀▀▀▀╬
# ◥█████◤
# ══╩══╩═
# ╬═╬
# ╬═╬
# ╬═╬
# ╬═╬
# ╬═╬ { .zshrc }
# ╬═╬☻/
# ╬═╬/▌
# ╬═╬/  \
# =============================================================================

# only run if interactive
[[ -o interactive ]] || return

# new files are created with permissions 755/644
umask 022

# Establish tool paths before completions and optional integrations.
user_paths=(
  $HOME/.local/bin(N-/)
  $HOME/.bun/bin(N-/)
  $HOME/.ghcup/bin(N-/)
  $HOME/.cargo/bin(N-/)
  $HOME/.amp/bin(N-/)
)
brew_prefix=${HOMEBREW_PREFIX:-}
if (( $+commands[brew] )); then
  brew_prefix=$(command brew --prefix)
else
  for candidate in "${HOMEBREW_PREFIX:-}" /opt/homebrew /home/linuxbrew/.linuxbrew /usr/local; do
    if [[ -n $candidate && -x $candidate/bin/brew ]]; then
      brew_prefix=$candidate
      break
    fi
  done
fi
typeset -U path
path=($user_paths $path)
if [[ -n $brew_prefix ]]; then
  path=(
    $brew_prefix/bin(N-/)
    $brew_prefix/sbin(N-/)
    $brew_prefix/opt/rustup/bin(N-/)
    $brew_prefix/opt/libpq/bin(N-/)
    $path
  )
  fpath=($brew_prefix/share/zsh/site-functions(N-/) $fpath)
fi
typeset -Ua fpath precmd_functions chpwd_functions

# keybindings and history
bindkey -e
setopt APPEND_HISTORY
setopt HIST_IGNORE_SPACE
setopt HIST_IGNORE_ALL_DUPS
setopt HIST_SAVE_NO_DUPS
setopt HIST_FIND_NO_DUPS
setopt HIST_REDUCE_BLANKS
setopt INC_APPEND_HISTORY_TIME
HISTSIZE=2000000
SAVEHIST=1000000
HISTFILE=$HOME/.zsh_history

# disable start-up messages
[ -f ~/.hushlogin ] || touch ~/.hushlogin
unset MAILCHECK
unset MAIL

# prompt
prompt_path() {
  local display_path=${PWD/#${HOME}/\~}

  if (( ${#display_path} <= 45 )); then
    print -r -- "$display_path"
    return
  fi

  local -a dirs=("${(@s:/:)display_path}")
  local shortened=${dirs[1]}
  local i

  for (( i = 2; i < ${#dirs}; i++ )); do
    shortened+="/${dirs[i][1]}"
  done

  print -r -- "$shortened/${dirs[-1]}"
}
PS1='%B%F{15}${USER:-%n}@%m%b:%f%F{2}$(prompt_path)%f%F{15}$ %f'
setopt prompt_subst

# zsh completions
autoload -Uz compinit && compinit

# history search (fallback if fzf unavailable)
autoload -U history-search-end
zle -N history-beginning-search-backward-end history-search-end
zle -N history-beginning-search-forward-end history-search-end
bindkey "^p" history-beginning-search-backward-end  # ctrl + p
bindkey "^n" history-beginning-search-forward-end   # ctrl + n
bindkey "^[p" beginning-of-history                  # meta + p
bindkey "^[n" end-of-history                        # meta + n

# fzf history manager
if command -v fzf >/dev/null 2>&1; then
  source <(fzf --zsh)
  export FZF_CTRL_R_OPTS="--reverse --height=40%"
fi

# CLI variables, independent of the prompt's displayed text.
_has_repo_marker() {
  local dir=${PWD:A}
  while true; do
    [[ -e "$dir/$1" ]] && return 0
    [[ "$dir" == / ]] && return 1
    dir=${dir:h}
  done
}

autoload -Uz vcs_info add-zsh-hook
zstyle ':vcs_info:git:*' formats '%b'
update_git_branch() {
  if _has_repo_marker .git; then
    vcs_info
    BRANCH=${vcs_info_msg_0_:-}
  else
    BRANCH=""
  fi
}

update_jj_bookmark() {
  BOOKMARK=""
  if _has_repo_marker .jj && (( $+commands[jj] )); then
    BOOKMARK=$(jj --ignore-working-copy --no-pager log -r 'closest_bookmark(@)' -T 'bookmarks.map(|b| if(b.remote(), "", b.name() ++ "\n")).join("")' --no-graph 2>/dev/null) || BOOKMARK=""
    BOOKMARK=${BOOKMARK%%$'\n'*}
  fi
}

add-zsh-hook precmd update_git_branch
add-zsh-hook chpwd update_git_branch
add-zsh-hook precmd update_jj_bookmark
add-zsh-hook chpwd update_jj_bookmark

# editor and colors (after setting brew path so we use brew vim)
export VISUAL="$(which vim)"
export EDITOR="$VISUAL"
export CLICOLOR=1
alias ls='ls --color=auto'

# apps
export PLAYWRIGHT_MCP_BROWSER=chromium
export OPENCODE_ENABLE_EXA=1
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
[[ -r "$XDG_CONFIG_HOME/repo4/repo4.zsh" ]] && source "$XDG_CONFIG_HOME/repo4/repo4.zsh"
[ -f "$HOME/.ripgreprc" ] && export RIPGREP_CONFIG_PATH="$HOME/.ripgreprc"
[ -s "$HOME/.bun/_bun" ] && source "$HOME/.bun/_bun"

# ssh port forwarding functions
fip() {
  (( $# < 2 )) && echo "Usage: fip <host> <port1> [port2] ..." && return 1
  local host="$1"
  shift
  for port in "$@"; do
    ssh -f -N -L "${port}:localhost:${port}" "$host" && echo "Forwarding localhost:$port -> $host:$port"
  done
}

dip() {
  (( $# == 0 )) && echo "Usage: dip <port1> [port2] ..." && return 1
  for port in "$@"; do
    pkill -f "ssh.*-L ${port}:localhost:${port}" && echo "Stopped forwarding port $port" || echo "No forwarding on port $port"
  done
}

lip() {
  ps aux | grep "ssh.*-L" | grep -v grep | grep -oE '\-L [0-9]+:localhost:[0-9]+' | sed 's/-L //'
}

if command -v jj >/dev/null 2>&1; then source <(COMPLETE=zsh jj); fi
if command -v eza >/dev/null 2>&1; then alias ls="eza --icons --group-directories-first --sort oldest"; fi
if command -v mise >/dev/null 2>&1; then eval "$(mise activate zsh)"; source <(mise completion zsh); fi
if command -v just >/dev/null 2>&1; then source <(JUST_COMPLETE=zsh just); fi

# Also make the variables available immediately after sourcing this file.
update_git_branch
update_jj_bookmark
