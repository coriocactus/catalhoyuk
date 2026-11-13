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

alias pi='PATH="$brew_prefix/opt/node/bin:$PATH" pi'

# ssh port forwarding: mirror a remote dev server's ports onto localhost.
#   fip <host> [port ...]  start a background watcher that forwards every port that, on
#                          <host>, one of my processes listens on (any port number), a
#                          Docker container publishes, or is named here (always on)
#   lip                    list what is forwarded and what each port is
#   dip <host>             stop the watcher and drop its forwards
# FIP_SKIP is a regex of process/container names to ignore, e.g. '^sshd$|^myapp-test-'.
fip() {
  (( $# )) && [[ -z ${@[2,-1]:#<1-65535>} ]] || { echo "Usage: fip <host> [always-port ...]"; return 1 }
  local host=$1; shift
  local -a static=($@) mux
  local state=${TMPDIR:-/tmp}/fip.$host skip=${FIP_SKIP:-'^sshd$'}
  # Forwards are added to one shared connection: the host's own ControlPath when
  # ~/.ssh/config sets one, otherwise a socket of our own.
  ssh -G $host 2>/dev/null | grep -q '^controlpath /' ||
    mux=(-o ControlMaster=auto -o ControlPath=$HOME/.ssh/cm-%C -o ControlPersist=10m)
  # Runs on the host once a second and prints one line of port=name pairs. Docker goes
  # first so its container name wins over the anonymous root-owned listener.
  local remote; remote=$(cat <<'REMOTE'
: fip-watch
command -v ss >/dev/null || { echo "fip: no ss on remote" >&2; exit 1; }
while :; do
  {
    docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | awk '{
      name = $1; $1 = ""; n = split($0, e, ",")
      for (i = 1; i <= n; i++) {
        if (e[i] !~ /->.*\/tcp/) continue
        split(e[i], lr, "->"); h = lr[1]; sub(/.*:/, "", h); c = lr[2]; sub(/\/tcp.*/, "", c)
        nh = split(h, hr, "-"); split(c, cr, "-"); lo = hr[1] + 0; hi = (nh > 1 ? hr[2] : hr[1]) + 0
        for (p = lo; p <= hi; p++) print p "=" name ":" (cr[1] + p - lo)
      } }'
    ss -Htlnp | awk '/users:/ { n = split($4, a, ":"); split($0, q, "\""); print a[n] "=" q[2] }'
  } | awk -F= '!seen[$1]++ { gsub(/[^A-Za-z0-9_.:=\/-]/, "_"); printf "%s ", $0 }'
  echo; sleep 1
done
REMOTE
)
  ssh $mux -O check $host 2>/dev/null || ssh $mux -fN $host || return   # auth prompts happen here
  pgrep -qf -- "-T $host : fip-watch" && { echo "fip: already watching $host (see: lip)"; return }
  {
    local p t line table last=-
    local -A fwd want
    {
      ssh $mux -T $host $remote </dev/null | while read -r line; do
        want=()
        for p in $static; do want[$p]=static; done
        # The host's output is untrusted: accept only unprivileged port numbers, and strip
        # names to safe characters because lip prints them to the terminal.
        for t in ${=line}; do
          [[ $t == <1024-65535>=* && ! ${t#*=} =~ $skip ]] &&
            want[${t%%=*}]=${${t#*=}//[^A-Za-z0-9_.:\/-]/_}
        done
        for p in ${(k)want}; do
          (( ${+fwd[$p]} )) && continue
          if ssh $mux -O forward -L ${p}:localhost:${p} $host 2>/dev/null; then fwd[$p]=1
          else want[$p]+="  (NOT FORWARDED: local port in use)"; fi
        done
        for p in ${(k)fwd}; do
          (( ${+want[$p]} )) && continue
          ssh $mux -O cancel -L ${p}:localhost:${p} $host 2>/dev/null; unset "fwd[$p]"
        done
        table=; for p in ${(kon)want}; do table+="${(l:5:)p}  $want[$p]"$'\n'; done
        [[ $table == $last ]] || { print -rn -- $table >| $state; last=$table }
      done
    } always {
      for p in ${(k)fwd}; do ssh $mux -O cancel -L ${p}:localhost:${p} $host 2>/dev/null; done
      rm -f $state
    }
  } &!
}

dip() {
  (( $# == 1 )) || { echo "Usage: dip <host>"; return 1 }
  pkill -f -- "-T $1 : fip-watch" && echo "Stopped watching $1" || echo "Not watching $1"
}

lip() {
  local f
  for f in ${TMPDIR:-/tmp}/fip.*(N); do echo "${${f:t}#fip.}:"; cat $f; done
}

if command -v jj >/dev/null 2>&1; then source <(COMPLETE=zsh jj); fi
if command -v eza >/dev/null 2>&1; then alias ls="eza --icons --group-directories-first --sort oldest"; fi
if command -v mise >/dev/null 2>&1; then eval "$(mise activate zsh)"; source <(mise completion zsh); fi
if command -v just >/dev/null 2>&1; then source <(JUST_COMPLETE=zsh just); fi

# Also make the variables available immediately after sourcing this file.
update_git_branch
update_jj_bookmark
