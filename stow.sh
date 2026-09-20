#!/usr/bin/env bash

# Ordered destination/source pairs. Sources are relative to this checkout.
stow_mappings() {
    local profile=$1 with_ssh=$2
    local home=(
        ".vimrc"                     "config/vimrc"
        ".zshrc"                     "config/zshrc"
        ".gitconfig"                 "config/git.config"
        ".jjconfig.toml"             "config/jj.config"
        ".ripgreprc"                 "config/ripgreprc"
        ".agents"                    "agents/.agents"
        ".pi/agent/settings.json"    "agents/.pi/agent/settings.json"
        ".pi/agent/keybindings.json" "agents/.pi/agent/keybindings.json"
        ".pi/agent/extensions"       "agents/.pi/agent/extensions"
        ".tmux.conf"                 "config/tmux-$profile.conf"
    )
    local xdg_config_home=(
        "ghostty/config"   "config/ghostty.config"
        "hunk/config.toml" "config/hunk.config"
        "repo4/repo4.zsh"  "repo4/repo4.zsh"
    )
    if [ "$with_ssh" = 1 ]; then
        home+=(".vimrc-ssh" "config/vimrc-ssh")
    fi

    # Guards keep empty groups compatible with Bash 3.2 under set -u.
    if [ "${#home[@]}" -gt 0 ]; then
        stow_register "$HOME" "${home[@]}" || return 1
    fi
    if [ "${#xdg_config_home[@]}" -gt 0 ]; then
        stow_register "${XDG_CONFIG_HOME:-$HOME/.config}" "${xdg_config_home[@]}" || return 1
    fi
    return 0
}

_stow_error() { printf 'error: %s\n' "$*" >&2; return 1; }

_stow_path() {
    case "$1" in
        *$'\t'*|*$'\n'*|*$'\r'*) _stow_error "unsupported control character in path" ;;
        /*) return 0 ;;
        *) _stow_error "path must be absolute: $1" ;;
    esac
}

_stow_parent() {
    local parent=${1%/*}
    parent=${parent:-/}
    while [ ! -d "$parent" ]; do
        if [ -e "$parent" ] || [ -L "$parent" ]; then
            _stow_error "parent is not a directory: $parent"; return 1
        fi
        parent=${parent%/*}
        parent=${parent:-/}
    done
}

# State records the literal symlink target, so ownership survives missing sources.
_stow_previous() {
    local state=$1 destination=$2 line key value previous=
    if [ -L "$state" ] || { [ -e "$state" ] && [ ! -f "$state" ]; }; then
        _stow_error "state must be a regular file: $state"; return 1
    fi
    if [ -e "$state" ]; then
        [ -r "$state" ] || { _stow_error "cannot read state: $state"; return 1; }
        while IFS= read -r line || [ -n "$line" ]; do
            case "$line" in
                *$'\t'*) key=${line%%$'\t'*}; value=${line#*$'\t'} ;;
                *) _stow_error "invalid state record: $state"; return 1 ;;
            esac
            _stow_path "$key" || return 1
            case "$value" in
                ''|*$'\t'*|*$'\r'*) _stow_error "invalid state target: $state"; return 1 ;;
            esac
            if [ "$key" = "$destination" ]; then
                [ -z "$previous" ] || { _stow_error "duplicate state entry: $key"; return 1; }
                previous=$value
            fi
        done < "$state"
    fi
    printf '%s' "$previous"
}

_stow_record() (
    local state=$1 destination=$2 target=$3 temporary line
    umask 077
    mkdir -p -- "${state%/*}" || return 1
    temporary=$(mktemp "$state.XXXXXX") || return 1
    trap 'rm -f -- "$temporary"' EXIT
    if [ -f "$state" ]; then
        while IFS= read -r line || [ -n "$line" ]; do
            if [ "${line%%$'\t'*}" != "$destination" ]; then
                printf '%s\n' "$line" || return 1
            fi
        done < "$state" > "$temporary" || return 1
    fi
    printf '%s\t%s\n' "$destination" "$target" >> "$temporary" || return 1
    mv -- "$temporary" "$state"
)

# Sourceable API. Both paths are absolute; no mapping or repository knowledge here.
# STOW_CHECK_ONLY=1 validates; STOW_DRY_RUN=1 previews. Neither writes state.
stow_link() {
    [ "$#" = 2 ] || { _stow_error 'usage: stow_link SOURCE DESTINATION'; return 2; }
    local source=$1 destination=$2 state previous current= action=link label parent
    _stow_path "${XDG_STATE_HOME:-${HOME:-}}" || return 1
    state=${XDG_STATE_HOME:-${HOME:-}/.local/state}/catalhoyuk/stow.tsv
    _stow_path "$source" && _stow_path "$destination" && _stow_path "$state" || return 1
    case "$destination" in
        */) _stow_error "destination must not end with /: $destination"; return 1 ;;
    esac
    case "$state" in
        "$destination"|"$destination"/*) _stow_error "destination overlaps state: $destination"; return 1 ;;
    esac
    [ -e "$source" ] || { _stow_error "missing source: $source"; return 1; }
    _stow_parent "$destination" && _stow_parent "$state" || return 1
    previous=$(_stow_previous "$state" "$destination") || return 1

    if [ -L "$destination" ]; then
        current=$(readlink "$destination") || return 1
        if [ "$destination" -ef "$source" ]; then
            action=adopt
            [ "$current" != "$previous" ] || action=skip
        elif [ -n "$previous" ] && [ "$current" = "$previous" ]; then
            action=switch
        else
            _stow_error "refusing unowned or modified symlink: $destination"; return 1
        fi
    elif [ -e "$destination" ]; then
        _stow_error "refusing to overwrite: $destination"; return 1
    fi
    [ "${STOW_CHECK_ONLY:-0}" != 1 ] || return 0
    label=$action
    [ "${STOW_DRY_RUN:-0}" != 1 ] || label="dry-run $action"
    printf '[%s] %s -> %s\n' "$label" "$destination" "$source"
    [ "${STOW_DRY_RUN:-0}" != 1 ] || return 0

    if [ "$action" = link ] || [ "$action" = switch ]; then
        parent=${destination%/*}
        mkdir -p -- "${parent:-/}" || return 1
        if [ "$action" = switch ]; then rm -- "$destination" || return 1; fi
        ln -s -- "$source" "$destination" || return 1
        current=$source
    fi
    [ "$current" != "$previous" ] || return 0
    _stow_record "$state" "$destination" "$current"
}

_stow_relative() {
    case "/$1/" in
        *[[:cntrl:]]*) _stow_error 'unsupported control character in path' ;;
        *'//'*|*'/./'*|*'/../'*) _stow_error "expected a relative path without empty, . or .. components: $1" ;;
    esac
}

# Queue BASE DESTINATION SOURCE ...; never touches the filesystem.
# root, sources[], and destinations[] belong to stow_main.
stow_register() {
    if [ "$#" -eq 0 ] || [ "$((($# - 1) % 2))" -ne 0 ]; then
        _stow_error 'usage: stow_register BASE [DESTINATION SOURCE ...]'; return 2
    fi
    local base=$1 source destination i
    shift
    _stow_path "$base" && _stow_path "${root:-}" || return 1
    while [ "$#" -gt 0 ]; do
        _stow_relative "$1" && _stow_relative "$2" || return 1
        destination="${base%/}/$1"
        source="${root%/}/$2"
        for ((i=0; i<${#destinations[@]}; i++)); do
            case "$destination/" in
                "${destinations[i]}/"*) _stow_error "overlapping destination: $destination"; return 1 ;;
            esac
            case "${destinations[i]}/" in
                "$destination/"*) _stow_error "overlapping destination: $destination"; return 1 ;;
            esac
        done
        sources[${#sources[@]}]=$source
        destinations[${#destinations[@]}]=$destination
        shift 2
    done
}

stow_main() {
    local root profile=green with_ssh=0 with_repo4=0 dry_run=0 explicit_profile=0 i
    local sources=() destinations=() STOW_CHECK_ONLY=0 STOW_DRY_RUN=0
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --ssh) with_ssh=1; shift ;;
            --repo4) with_repo4=1; shift ;;
            --dry-run) dry_run=1; shift ;;
            --tmux)
                if [ "$#" -lt 2 ] || [ "$explicit_profile" = 1 ] || ! [[ "$2" =~ ^[a-zA-Z0-9_-]+$ ]]; then
                    _stow_error '--tmux requires one profile name'; return 2
                fi
                profile=$2; explicit_profile=1; shift 2 ;;
            -h|--help)
                printf '%s\n' 'Usage: ./stow.sh [--ssh] [--tmux PROFILE] [--repo4] [--dry-run]' \
                    'Mappings: stow_mappings in stow.sh. Tmux defaults to green; --ssh is opt-in.' \
                    '--repo4 also runs repo4 init to create private identity profiles if absent.'
                return 0 ;;
            *) _stow_error "unknown argument: $1"; return 2 ;;
        esac
    done
    _stow_path "${HOME:-}" && _stow_path "${XDG_CONFIG_HOME:-$HOME/.config}" && \
        _stow_path "${XDG_STATE_HOME:-$HOME/.local/state}" || return 2
    root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P) || return 1
    stow_mappings "$profile" "$with_ssh" || return 1
    for ((i=0; i<${#sources[@]}; i++)); do
        STOW_CHECK_ONLY=1 stow_link "${sources[i]}" "${destinations[i]}" || return 1
    done
    if [ "$with_repo4" = 1 ]; then
        command -v zsh >/dev/null 2>&1 || { _stow_error '--repo4 requires zsh'; return 1; }
        local repo4_init=(zsh -f -c 'source "$1" && repo4 init' repo4 "$root/repo4/repo4.zsh")
        REPO4_CHECK_ONLY=1 "${repo4_init[@]}" || return 1
    fi
    for ((i=0; i<${#sources[@]}; i++)); do
        STOW_DRY_RUN=$dry_run stow_link "${sources[i]}" "${destinations[i]}" || return 1
    done
    if [ "$with_repo4" = 1 ]; then
        if [ "$dry_run" = 1 ]; then
            printf '%s\n' '[dry-run] repo4 init'
        else
            REPO4_CHECK_ONLY=0 "${repo4_init[@]}" || return 1
        fi
    fi
    return 0
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then stow_main "$@"; fi
