# Keep the source path absolute; resolve its symlinks when locating the template.
typeset -g _REPO4_SOURCE=${${(%):-%x}:a}

_repo4_error() { print -ru2 -- "repo4: $*"; return 1; }

_repo4_value() {
    local raw
    raw=$(command git config --file "$1" --no-includes --null --get-all "$2") || {
        _repo4_error "missing or invalid $2 in $1"; return 1
    }
    local -a values=("${(@0)raw}")
    # Git terminates every value with NUL; a single value has one trailing empty field.
    if (( ${#values} != 2 )) || [[ -z ${values[1]//[[:space:]]/} || ${values[1]} == *[[:cntrl:]]* ]]; then
        _repo4_error "$2 must have one nonempty value in $1"; return 1
    fi
    print -r -- "$values[1]"
}

_repo4_toml() {
    local value=${1//\\/\\\\}
    value=${value//\"/\\\"}
    printf '"%s"' "$value"
}

# REPO4_CHECK_ONLY=1 validates initialization without creating files.
_repo4_init() (
    emulate -L zsh
    local directory=$1 file="$1/identities.conf" temporary
    if [[ -e $file || -L $file ]]; then
        [[ -f $file && ! -L $file ]] || { _repo4_error "expected a regular, private file: $file"; return 1; }
        [[ ${REPO4_CHECK_ONLY:-0} == 1 ]] || print -r -- "repo4: keeping $file"
        return 0
    fi
    local template="${_REPO4_SOURCE:A:h}/identities.example"
    [[ -f $template && -r $template ]] || { _repo4_error "template missing or unreadable: $template"; return 1; }
    [[ ${REPO4_CHECK_ONLY:-0} != 1 ]] || return 0
    umask 077
    command mkdir -p -- "$directory" || return 1
    temporary=$(command mktemp "$directory/.identities.XXXXXX") || return 1
    trap 'command rm -f -- "$temporary"' EXIT
    command cp -- "$template" "$temporary" || return 1
    command chmod 600 "$temporary" || return 1
    # Linking a complete temporary file gives atomic creation without overwriting a race winner.
    command ln -- "$temporary" "$file" || return 1
    print -r -- "repo4: created $file; fill in the work profile"
)

repo4() {
    emulate -L zsh
    if (( $# != 1 )) || [[ $1 != (init|self|work) ]]; then
        _repo4_error 'usage: repo4 <init|self|work>'
        return 2
    fi
    local profile=$1 directory="${XDG_CONFIG_HOME:-${HOME:-}/.config}/repo4"
    [[ ${XDG_CONFIG_HOME:-${HOME:-}} == /* ]] || { _repo4_error 'HOME or XDG_CONFIG_HOME must be absolute'; return 1; }
    if [[ $profile == init ]]; then _repo4_init "$directory"; return; fi
    (( $+commands[git] )) || { _repo4_error 'git is required'; return 1; }

    local variable
    for variable in GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL EMAIL \
        JJ_USER JJ_EMAIL GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE \
        GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS; do
        if (( ${+parameters[$variable]} )); then
            _repo4_error "unset $variable before selecting a repository identity"; return 1
        fi
    done
    local file="$directory/identities.conf" name email
    [[ -f $file && ! -L $file ]] || { _repo4_error "private profile file missing or symlinked: $file (run repo4 init)"; return 1; }
    name=$(_repo4_value "$file" "profile.$profile.name") || return 1
    email=$(_repo4_value "$file" "profile.$profile.email") || return 1
    if [[ $name == *[\<\>]* || $email != ?*@?* || $email == *[[:space:]\<\>]* ]]; then
        _repo4_error "invalid name or email in profile $profile"; return 1
    fi

    # Stop at the nearest marker: a nested Git repo must not configure its parent JJ repo.
    local root=${PWD:A} git_dir is_jj=0
    while [[ ! -e $root/.jj && ! -e $root/.git && $root != / ]]; do root=${root:h}; done
    if [[ -e $root/.jj ]]; then
        (( $+commands[jj] )) || { _repo4_error 'this is a JJ repository, but jj is unavailable'; return 1; }
        is_jj=1
        git_dir=$(command jj --ignore-working-copy -R "$root" git root) || return 1
    elif [[ -e $root/.git ]]; then
        git_dir=$(command git -C "$root" rev-parse --absolute-git-dir) || return 1
    else
        _repo4_error 'not inside a Git or JJ working tree'; return 1
    fi
    local -a git_cmd=(git --git-dir="$git_dir") jj_cmd=(jj --no-pager --ignore-working-copy -R "$root")
    local overrides rc=0 key
    command "${git_cmd[@]}" config --list >/dev/null || return 1
    overrides=$(command "${git_cmd[@]}" config --get-regexp '^(author|committer)\.(name|email)$') || rc=$?
    (( rc <= 1 )) || return 1
    [[ -z $overrides ]] || { _repo4_error 'remove Git author/committer identity overrides first'; return 1; }
    if [[ $(command "${git_cmd[@]}" config --bool --get extensions.worktreeConfig) == true ]]; then
        rc=0
        overrides=$(command "${git_cmd[@]}" config --worktree --get-regexp '^user\.(name|email)$') || rc=$?
        (( rc <= 1 )) || return 1
        [[ -z $overrides ]] || { _repo4_error 'remove Git worktree identity overrides first'; return 1; }
    fi

    local current_author= expected_author="$name"$'\n'"$email" commit_id= rewrite=0
    local -a keys=(user.name user.email) values=("$name" "$email") git_before=() jj_before=()
    local i
    for i in 1 2; do
        rc=0
        git_before[i]=$(command "${git_cmd[@]}" config --local --null --get-all "$keys[i]") || rc=$?
        (( rc <= 1 )) || return 1
    done
    if (( is_jj )); then
        overrides=$(command "${jj_cmd[@]}" config list --include-defaults -T 'if(source == "workspace", name ++ "\n")') || return 1
        for key in "${(@f)overrides}"; do
            [[ $key != (user.name|user.email) ]] || { _repo4_error 'remove JJ workspace identity overrides first'; return 1; }
        done
        for i in 1 2; do
            jj_before[i]=$(command "${jj_cmd[@]}" config list --include-defaults -T "if(source == \"repo\" && name == \"$keys[i]\", value.as_string())") || return 1
        done
        current_author=$(command "${jj_cmd[@]}" log --no-graph -r @ -T 'author.name() ++ "\n" ++ author.email()') || return 1
        if [[ $current_author != $expected_author ]]; then
            # Evaluate immutability using the identity that will be active after the writes.
            commit_id=$(command "${jj_cmd[@]}" \
                --config "user.name=$(_repo4_toml "$name")" --config "user.email=$(_repo4_toml "$email")" \
                log --no-graph -r '@ & mutable() & heads(all())' -T 'commit_id') || return 1
            [[ -n $commit_id ]] || { _repo4_error 'author repair requires a mutable leaf @; no settings changed'; return 1; }
            rewrite=1
        fi
    fi

    # All predictable failures are checked. Cross-tool writes are not a transaction.
    for i in 1 2; do
        if [[ $git_before[i] != "$values[i]"$'\0' ]]; then
            command "${git_cmd[@]}" config --local --replace-all "$keys[i]" "$values[i]" || {
                _repo4_error 'Git config write failed; settings may be partial. Fix the error and rerun.'; return 1
            }
        fi
        if (( is_jj )) && [[ $jj_before[i] != $values[i] ]]; then
            command "${jj_cmd[@]}" config set --repo "$keys[i]" "$(_repo4_toml "$values[i]")" || {
                _repo4_error 'JJ config write failed; settings may be partial. Fix the error and rerun.'; return 1
            }
        fi
    done
    for i in 1 2; do
        [[ $(command "${git_cmd[@]}" config --get "$keys[i]") == $values[i] ]] || {
            _repo4_error "Git $keys[i] is still overridden; inspect git config --show-origin"; return 1
        }
        if (( is_jj )); then
            [[ $(command "${jj_cmd[@]}" config get "$keys[i]") == $values[i] ]] || {
                _repo4_error "JJ $keys[i] is still overridden; inspect jj config list"; return 1
            }
        fi
    done
    if (( rewrite )); then
        [[ $(command "${jj_cmd[@]}" log --no-graph -r '@ & mutable() & heads(all())' -T 'commit_id') == $commit_id ]] || {
            _repo4_error 'JJ @ is no longer the same mutable leaf; identity configured, author not repaired. Rerun.'; return 1
        }
        command jj --no-pager -R "$root" metaedit --update-author @ || {
            _repo4_error 'identity configured, but author repair failed'; return 1
        }
    fi
    local tools=Git
    (( ! is_jj )) || tools='Git + JJ'
    print -r -- "repo4: $profile → $name <$email> ($tools)"
}
