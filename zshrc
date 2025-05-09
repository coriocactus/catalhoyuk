# ~/.zshrc

[[ -o interactive ]] || return
umask 022

bindkey -e
setopt APPEND_HISTORY
HISTSIZE=10000
SAVEHIST=10000
HIST_IGNORE_SPACE=true
HIST_IGNORE_ALL_DUPS=true
HISTFILE=$HOME/.zsh_history

export VISUAL="$(which vim)"
export EDITOR="$VISUAL"
export CLICOLOR=1

PS1='%B%F{white}%n@%m%b:%f%F{2}%~%f%F{white}$ %f'

if [[ $(uname) == "Darwin" ]]; then
  path+=(
    /opt/homebrew/bin(N-/)
    /opt/homebrew/sbin(N-/)
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
  $path
)

alias ls='ls --color=auto'

autoload -Uz compinit && compinit

autoload -Uz vcs_info
zstyle ':vcs_info:git:*' formats '%b'
function update_git_branch() { vcs_info ; BRANCH=${vcs_info_msg_0_:-} }
precmd_functions+=(update_git_branch)
chpwd_functions+=(update_git_branch)
setopt prompt_subst

autoload -U history-search-end
zle -N history-beginning-search-backward-end history-search-end
zle -N history-beginning-search-forward-end history-search-end
bindkey "^P" history-beginning-search-backward-end
bindkey "^N" history-beginning-search-forward-end

[ -s $HOME"/.bun/_bun" ] && source $HOME"/.bun/_bun"
