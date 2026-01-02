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
HISTSIZE=10000
SAVEHIST=10000
HIST_IGNORE_SPACE=true
HIST_IGNORE_ALL_DUPS=true
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

# history search
autoload -U history-search-end
zle -N history-beginning-search-backward-end history-search-end
zle -N history-beginning-search-forward-end history-search-end
bindkey "^P" history-beginning-search-backward-end
bindkey "^N" history-beginning-search-forward-end

# git branches via $BRANCH
autoload -Uz vcs_info
zstyle ':vcs_info:git:*' formats '%b'
function update_git_branch() { vcs_info ; BRANCH=${vcs_info_msg_0_:-} }
precmd_functions+=(update_git_branch)
chpwd_functions+=(update_git_branch)
setopt prompt_subst

# path
if [[ $(uname) == "Darwin" ]]; then
  path+=(
    /opt/homebrew/bin(N-/)
    /opt/homebrew/sbin(N-/)
    /opt/homebrew/opt/rustup/bin(N-/)
  )
else
  path+=(
    /home/linuxbrew/.linuxbrew/bin(N-/)
    /home/linuxbrew/.linuxbrew/sbin(N-/)
  )
fi

path=(
  $HOME/.local/bin(N-/)
  $HOME/.ghcup/bin(N-/)
  $HOME/.cargo/bin(N-/)
  $HOME/.amp/bin(N-/)
  $path
)

if command -v wt >/dev/null 2>&1; then eval "$(command wt config shell init zsh)"; fi
