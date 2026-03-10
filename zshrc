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

# editor and colors
export VISUAL="$(which vim)"
export EDITOR="$VISUAL"
export CLICOLOR=1
alias ls='ls --color=auto'

# prompt
PS1='%B%F{15}%n@%m%b:%f%F{2}%~%f%F{15}$ %f'

# zsh completions
autoload -Uz compinit && compinit

# history search (fallback if fzf unavailable)
autoload -U history-search-end
zle -N history-beginning-search-backward-end history-search-end
zle -N history-beginning-search-forward-end history-search-end
bindkey "^p" history-beginning-search-backward-end
bindkey "^n" history-beginning-search-forward-end
bindkey "^[p" beginning-of-history
bindkey "^[n" end-of-history

# fzf history manager
if command -v fzf >/dev/null 2>&1; then
  source <(fzf --zsh)
  export FZF_CTRL_R_OPTS="--reverse --height=40%"
fi

# git branches via $BRANCH
autoload -Uz vcs_info
zstyle ':vcs_info:git:*' formats '%b'
function update_git_branch() { vcs_info ; BRANCH=${vcs_info_msg_0_:-} }
precmd_functions+=(update_git_branch)
chpwd_functions+=(update_git_branch)
setopt prompt_subst

# jj closest bookmark via $BOOKMARK
function update_jj_bookmark() { jj root &>/dev/null && BOOKMARK=$(jj log -r 'closest_bookmark(@)' -T 'bookmarks' --no-graph 2>/dev/null | tr -d ' ') || BOOKMARK="" }
precmd_functions+=(update_jj_bookmark)
chpwd_functions+=(update_jj_bookmark)
setopt prompt_subst

# path
user_paths=(
  $HOME/.local/bin(N-/)
  $HOME/.bun/bin(N-/)
  $HOME/.ghcup/bin(N-/)
  $HOME/.cargo/bin(N-/)
  $HOME/.amp/bin(N-/)
  $HOME/.opencode/bin(N-/)
)

if [[ $(uname) == "Darwin" ]]; then
  path=(
    /opt/homebrew/bin(N-/)
    /opt/homebrew/sbin(N-/)
    /opt/homebrew/opt/rustup/bin(N-/)
    /opt/homebrew/opt/libpq/bin(N-/)
    $user_paths
    $path
  )
else
  path=(
    /home/linuxbrew/.linuxbrew/bin(N-/)
    /home/linuxbrew/.linuxbrew/sbin(N-/)
    $user_paths
    $path
  )
fi

typeset -U path

# apps
export PLAYWRIGHT_MCP_BROWSER=chromium
export OPENCODE_ENABLE_EXA=1
export XDG_CONFIG_HOME="$HOME/.config"

if command -v wt >/dev/null 2>&1; then eval "$(command wt config shell init zsh)"; fi
if command -v fnm >/dev/null 2>&1; then eval "$(fnm env --use-on-cd --version-file-strategy=recursive --shell zsh)"; fi
if command -v eza >/dev/null 2>&1; then alias ls="eza --icons --group-directories-first --sort oldest"; fi
if command -v mise >/dev/null 2>&1; then eval "$(mise activate zsh)"; fi
