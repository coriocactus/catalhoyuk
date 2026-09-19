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

# find a repo marker in the current directory or an ancestor
function _has_repo_marker() {
  local dir=${PWD:A}
  while true; do
    [[ -e "$dir/$1" ]] && return 0
    [[ "$dir" == / ]] && return 1
    dir=${dir:h}
  done
}

# git branches via $BRANCH
autoload -Uz vcs_info
zstyle ':vcs_info:git:*' formats '%b'
function update_git_branch() {
  if _has_repo_marker .git; then
    vcs_info
    BRANCH=${vcs_info_msg_0_:-}
  else
    BRANCH=""
  fi
}
precmd_functions+=(update_git_branch)
chpwd_functions+=(update_git_branch)

# jj closest local bookmark via $BOOKMARK
function update_jj_bookmark() {
  if _has_repo_marker .jj; then
    BOOKMARK=$(jj --ignore-working-copy log -r 'closest_bookmark(@)' -T 'bookmarks.map(|b| if(b.remote(), "", b.name() ++ "\n")).join("")' --no-graph 2>/dev/null | sed -n '1p')
  else
    BOOKMARK=""
  fi
}
precmd_functions+=(update_jj_bookmark)
chpwd_functions+=(update_jj_bookmark)

# path
user_paths=(
  $HOME/.local/bin(N-/)
  $HOME/.bun/bin(N-/)
  $HOME/.ghcup/bin(N-/)
  $HOME/.cargo/bin(N-/)
  $HOME/.amp/bin(N-/)
)

if (( $+commands[brew] )); then
  brew_prefix=$(brew --prefix)
elif [[ $OSTYPE == darwin* ]]; then
  brew_prefix=/opt/homebrew
else
  brew_prefix=/home/linuxbrew/.linuxbrew
fi

path=(
  $brew_prefix/bin(N-/)
  $brew_prefix/sbin(N-/)
  $brew_prefix/opt/rustup/bin(N-/)
  $brew_prefix/opt/libpq/bin(N-/)
  $user_paths
  $path
)

typeset -U path

# editor and colors
export VISUAL="$(which vim)"
export EDITOR="$VISUAL"
export CLICOLOR=1
alias ls='ls --color=auto'

# apps
export PLAYWRIGHT_MCP_BROWSER=chromium
export OPENCODE_ENABLE_EXA=1
export XDG_CONFIG_HOME="$HOME/.config"
[ -f "$HOME/.ripgreprc" ] && export RIPGREP_CONFIG_PATH="$HOME/.ripgreprc"
[ -s "$HOME/.bun/_bun" ] && source "$HOME/.bun/_bun"

# purge dead shells
fnm-purge() {
  for d in ~/.local/state/fnm_multishells/*(N); do
    local pid="${${d:t}%%_*}"
    if kill -0 "$pid" 2>/dev/null; then
      ps -p "$pid" -o comm= 2>/dev/null | grep -qE 'zsh|bash|sh' || rm -rf "$d"
    else
      rm -rf "$d"
    fi
  done
}

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
if command -v fnm >/dev/null 2>&1; then eval "$(fnm env --use-on-cd --version-file-strategy=recursive --shell zsh)"; fi
if command -v eza >/dev/null 2>&1; then alias ls="eza --icons --group-directories-first --sort oldest"; fi
if command -v mise >/dev/null 2>&1; then eval "$(mise activate zsh)"; fi
