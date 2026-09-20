#!/usr/bin/env zsh
emulate -LR zsh
setopt ERR_EXIT NO_UNSET PIPE_FAIL

repo_root=${0:A:h:h}
scratch=$(mktemp -d "${TMPDIR:-/tmp}/repo4-tests.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
source "$repo_root/stow/xdg/repo4/repo4.zsh"
test_count=0

fail() {
    local details=
    [[ ! -f $output ]] || details=$(< "$output")
    print -ru2 -- "FAIL: $*"
    [[ -z $details ]] || print -ru2 -- "$details"
    exit 1
}
contains() { grep -F -- "$1" "$output" >/dev/null || fail "missing output: $1"; }
check() { run_repo4 "$@" || fail "repo4 $* failed"; }
reject() { if run_repo4 "$@"; then fail "repo4 $* unexpectedly succeeded"; fi; contains 'repo4:'; }
run_repo4() ( cd "$working"; repo4 "$@" ) > "$output" 2>&1
j() ( cd "$working"; command jj --no-pager "$@" )
g() { command git -C "$working" "$@"; }
author() { j --ignore-working-copy log -r @ --no-graph -T 'author.name() ++ "\n" ++ author.email()'; }
commit_id() { j --ignore-working-copy log -r @ --no-graph -T commit_id; }

setup() {
    case_dir="$scratch/$test_count"
    output="$case_dir/output"
    working=$case_dir
    local variable
    for variable in GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL EMAIL \
        JJ_USER JJ_EMAIL GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE \
        GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS REPO4_CHECK_ONLY; do unset "$variable"; done
    export HOME="$case_dir/home with spaces" XDG_CONFIG_HOME="$case_dir/config with spaces"
    export XDG_STATE_HOME="$case_dir/state" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$case_dir/global.gitconfig"
    export JJ_CONFIG="$case_dir/jj.toml" GIT_TERMINAL_PROMPT=0
    source_dir="$case_dir/checkout with spaces/stow/xdg/repo4"
    mkdir -p "$HOME" "$source_dir"
    cp "$repo_root/stow/xdg/repo4/repo4.zsh" "$repo_root/stow/xdg/repo4/identities.example" "$source_dir/"
    source "$source_dir/repo4.zsh"
    printf '[user]\nuseConfigOnly = true\n' > "$GIT_CONFIG_GLOBAL"
    printf '[user]\nname = "Initial User"\nemail = "initial@example.invalid"\n' > "$JJ_CONFIG"
    profiles="$XDG_CONFIG_HOME/repo4/identities.conf"
}

run_test() {
    local title=$1
    shift
    test_count=$((test_count + 1))
    ( setup; cd "$case_dir"; "$@" )
    print -r -- "ok $test_count - $title"
}

init_profiles() {
    check init
    git config --file "$profiles" profile.work.name 'Work Person'
    git config --file "$profiles" profile.work.email 'work@example.invalid'
}
new_git() {
    working="$case_dir/repository"
    git init --quiet "$working"
}
new_jj() {
    working="$case_dir/repository"
    jj --no-pager git init "$1" "$working" > "$output" 2>&1
}
no_git_identity() {
    if g config --local --get-regexp '^user\.(name|email)$' >/dev/null; then fail 'Git identity changed during preflight'; fi
}
assert_identity() {
    local git_dir=$1 name=$2 email=$3
    [[ $(git --git-dir="$git_dir" config --local --get user.name) == $name ]] || fail 'wrong Git name'
    [[ $(git --git-dir="$git_dir" config --local --get user.email) == $email ]] || fail 'wrong Git email'
}

initialization() {
    check init
    [[ -f $profiles && ! -L $profiles ]] || fail 'live profiles must be a regular file'
    [[ $(LC_ALL=C ls -l "$profiles") == -rw-------* ]] || fail 'private file is not mode 600'
    [[ $(git config --file "$profiles" --get profile.self.name) == coriocactus ]] || fail 'self profile missing'
    [[ -z $(git config --file "$profiles" --get profile.work.name) ]] || fail 'work profile is not blank'
    local template_before=$(cksum "$source_dir/identities.example")
    git config --file "$profiles" profile.work.name 'Private Work Name'
    local before=$(cksum "$profiles"; ls -di "$profiles")
    check init
    [[ $(cksum "$profiles"; ls -di "$profiles") == $before ]] || fail 'init overwrote an existing file'
    [[ $(cksum "$source_dir/identities.example") == $template_before ]] || fail 'editing live profiles changed the template'
    [[ ! -e $XDG_CONFIG_HOME/repo4/identities.example && ! -L $XDG_CONFIG_HOME/repo4/identities.example ]] || fail 'template was installed into XDG config'
}

default_config_home() {
    unset XDG_CONFIG_HOME
    profiles="$HOME/.config/repo4/identities.conf"
    check init
    [[ -f $profiles ]] || fail 'HOME fallback failed'
    ( unset HOME; reject init )
    ( export XDG_CONFIG_HOME=relative; reject init )
}

missing_template() {
    rm "$source_dir/identities.example"
    reject init
    [[ ! -e $profiles ]] || fail 'init created a file without a template'
}

private_symlink() {
    mkdir -p "${profiles:h}"
    ln -s "$source_dir/identities.example" "$profiles"
    reject init
    new_git
    reject self
    no_git_identity
}

git_identity() {
    init_profiles
    new_git
    g -c user.name='Original Author' -c user.email=original@example.invalid commit --quiet --allow-empty -m original
    g config user.signingkey keep-this-key
    local before=$(g rev-parse HEAD)
    check self
    assert_identity "$(g rev-parse --absolute-git-dir)" coriocactus 69796618+coriocactus@users.noreply.github.com
    mkdir -p "$working/nested/directory"
    working="$working/nested/directory"
    check work
    assert_identity "$(g rev-parse --absolute-git-dir)" 'Work Person' work@example.invalid
    [[ $(g rev-parse HEAD) == $before ]] || fail 'Git HEAD was amended'
    [[ $(g config user.signingkey) == keep-this-key ]] || fail 'signing settings changed'
    local config=$(g rev-parse --git-path config)
    [[ $config == /* ]] || config="$working/$config"
    before=$(cksum "$config"; ls -di "$config")
    check work
    [[ $(cksum "$config"; ls -di "$config") == $before ]] || fail 'repeat selection rewrote Git config'
    [[ -z $(git config --global --get user.name) ]] || fail 'global identity was modified'
}

jj_identity() {
    init_profiles
    new_jj "$1"
    j describe -m parent > "$output" 2>&1
    local parent=$(commit_id)
    j new -m draft > "$output" 2>&1
    local before=$(commit_id)
    local timestamp=$(j --ignore-working-copy log -r @ --no-graph -T 'author.timestamp()')
    mkdir -p "$working/nested/directory"
    working="$working/nested/directory"
    check work
    assert_identity "$(j --ignore-working-copy git root)" 'Work Person' work@example.invalid
    [[ $(j config get user.name) == 'Work Person' && $(j config get user.email) == work@example.invalid ]] || fail 'JJ settings differ'
    [[ $(author) == $'Work Person\nwork@example.invalid' ]] || fail 'JJ author was not repaired'
    [[ $(commit_id) != $before ]] || fail 'author change did not rewrite @'
    [[ $(j --ignore-working-copy log -r @- --no-graph -T commit_id) == $parent ]] || fail 'parent history changed'
    [[ $(j --ignore-working-copy log -r @ --no-graph -T 'author.timestamp()') == $timestamp ]] || fail 'author timestamp changed'
    local jj_config=$(j --ignore-working-copy config path --repo)
    local git_dir=$(j --ignore-working-copy git root)
    before=$(commit_id; cksum "$jj_config" "$git_dir/config"; ls -di "$jj_config" "$git_dir/config")
    check work
    [[ $(commit_id; cksum "$jj_config" "$git_dir/config"; ls -di "$jj_config" "$git_dir/config") == $before ]] || fail 'repeat selection was not a no-op'
}

invalid_profile() {
    init_profiles
    new_git
    case "$1" in
        blank-name) git config --file "$profiles" profile.work.name '' ;;
        blank-email) git config --file "$profiles" profile.work.email '' ;;
        duplicate) git config --file "$profiles" --add profile.work.name 'Another Person' ;;
        newline) git config --file "$profiles" profile.work.name $'Work\nPerson' ;;
        invalid-email) git config --file "$profiles" profile.work.email 'not an email' ;;
        malformed) print -r -- '[broken' > "$profiles" ;;
        missing) rm "$profiles" ;;
    esac
    reject work
    no_git_identity
}

quoted_identity() {
    init_profiles
    new_jj --no-colocate
    local name=$1
    git config --file "$profiles" profile.work.name "$name"
    check work
    [[ $(j config get user.name) == $name ]] || fail 'TOML quoting changed the name'
    [[ $(author) == "$name"$'\nwork@example.invalid' ]] || fail 'quoted author is incorrect'
    local before=$(commit_id)
    check work
    [[ $(commit_id) == $before ]] || fail 'quoted identity is not idempotent'
}

anonymous_clone() {
    init_profiles
    new_git
    g -c user.name=Original -c user.email=original@example.invalid commit --quiet --allow-empty -m original
    local origin=$working
    : > "$JJ_CONFIG"
    jj git clone "$origin" "$case_dir/clone" > "$output" 2>&1
    working="$case_dir/clone"
    [[ -z $(author) ]] || fail 'fixture clone unexpectedly has an author'
    local parent=$(j --ignore-working-copy log -r @- --no-graph -T commit_id)
    check work
    [[ $(author) == $'Work Person\nwork@example.invalid' ]] || fail 'anonymous clone author not repaired'
    [[ $(j --ignore-working-copy log -r @- --no-graph -T commit_id) == $parent ]] || fail 'cloned history changed'
}

global_identity_guard() {
    cp "$repo_root/stow/home/.gitconfig" "$GIT_CONFIG_GLOBAL"
    new_git
    if g commit --quiet --allow-empty -m blocked > "$output" 2>&1; then fail 'Git guessed a global identity'; fi
    [[ $(g config --bool user.useConfigOnly) == true ]] || fail 'useConfigOnly is not enabled'
    [[ -z $(git config --global --get user.name) && -z $(git config --global --get user.email) ]] || fail 'global identity still configured'
}

bad_arguments() {
    init_profiles
    reject
    reject unknown
    reject work extra
    reject work
    contains 'not inside'
}

environment_override() {
    init_profiles
    new_git
    local variable=$1
    ( export "$variable=override"; reject work )
    no_git_identity
}

git_overrides() {
    init_profiles
    new_git
    if [[ $1 == worktree ]]; then
        g config extensions.worktreeConfig true
        g config --worktree user.email other@example.invalid
    else
        g config "$1" other@example.invalid
    fi
    reject work
    contains overrides
    no_git_identity
}

jj_workspace_override() {
    init_profiles
    new_jj --colocate
    j --ignore-working-copy config set --workspace user.email workspace@example.invalid > "$output" 2>&1
    local before=$(commit_id)
    reject work
    contains 'JJ workspace'
    no_git_identity
    [[ $(commit_id) == $before ]] || fail 'workspace override rewrote @'
}

unsafe_author_rewrite() {
    init_profiles
    new_jj --colocate
    if [[ $1 == immutable ]]; then
        j --ignore-working-copy config set --repo 'revset-aliases."immutable_heads()"' '@' > "$output" 2>&1
    else
        j describe -m parent > "$output" 2>&1
        local parent=$(commit_id)
        j new -m child > "$output" 2>&1
        j edit "$parent" > "$output" 2>&1
    fi
    local before=$(commit_id)
    reject work
    contains 'mutable leaf'
    no_git_identity
    [[ $(commit_id) == $before ]] || fail 'unsafe author was rewritten'
    [[ $(j config get user.name) == 'Initial User' ]] || fail 'JJ config changed before safety check'
}

nested_git() {
    init_profiles
    new_jj --colocate
    local parent=$working before=$(commit_id)
    git init --quiet "$parent/nested"
    working="$parent/nested"
    check work
    assert_identity "$(g rev-parse --absolute-git-dir)" 'Work Person' work@example.invalid
    working=$parent
    no_git_identity
    [[ $(commit_id) == $before ]] || fail 'nested Git configured its parent JJ repository'
}

nested_jj() {
    init_profiles
    new_git
    local parent=$working
    jj git init --no-colocate "$parent/nested" > "$output" 2>&1
    working="$parent/nested"
    check work
    assert_identity "$(j --ignore-working-copy git root)" 'Work Person' work@example.invalid
    working=$parent
    no_git_identity
}

git_worktree() {
    init_profiles
    new_git
    g -c user.name=Initial -c user.email=initial@example.invalid commit --quiet --allow-empty -m initial
    g worktree add --quiet -b feature "$case_dir/worktree"
    local parent=$working
    working="$case_dir/worktree"
    check work
    assert_identity "$(g rev-parse --absolute-git-dir)" 'Work Person' work@example.invalid
    working=$parent
    assert_identity "$(g rev-parse --absolute-git-dir)" 'Work Person' work@example.invalid
}

jj_workspace() {
    init_profiles
    new_jj --no-colocate
    local parent=$working before=$(commit_id)
    j workspace add "$case_dir/workspace" > "$output" 2>&1
    working="$case_dir/workspace"
    check work
    [[ $(author) == $'Work Person\nwork@example.invalid' ]] || fail 'additional workspace author not repaired'
    working=$parent
    [[ $(j config get user.name) == 'Work Person' ]] || fail 'identity was not repository-scoped'
    [[ $(commit_id) == $before ]] || fail 'another workspace author was rewritten'
}

matching_immutable_author() {
    init_profiles
    jj config set --file "$JJ_CONFIG" user.name '"Work Person"'
    jj config set --file "$JJ_CONFIG" user.email '"work@example.invalid"'
    new_jj --colocate
    j --ignore-working-copy config set --repo 'revset-aliases."immutable_heads()"' '@' > "$output" 2>&1
    local before=$(commit_id)
    check work
    [[ $(commit_id) == $before ]] || fail 'matching immutable author was rewritten'
    assert_identity "$(j --ignore-working-copy git root)" 'Work Person' work@example.invalid
}

missing_jj() {
    init_profiles
    new_jj --colocate
    mkdir "$case_dir/bin"
    ln -s "$commands[git]" "$case_dir/bin/git"
    local old_path=$PATH
    PATH="$case_dir/bin"
    if run_repo4 work; then PATH=$old_path; fail 'JJ repository was treated as Git-only'; fi
    PATH=$old_path
    contains 'jj is unavailable'
    no_git_identity
}

jj_write_failure() {
    init_profiles
    new_jj --colocate
    local before=$(commit_id) old_path=$PATH
    export REPO4_REAL_JJ=$commands[jj]
    mkdir "$case_dir/bin"
    printf '%s\n' '#!/bin/sh' \
        'case " $* " in *" config set "*) echo "simulated write failure" >&2; exit 1 ;; esac' \
        'exec "$REPO4_REAL_JJ" "$@"' > "$case_dir/bin/jj"
    chmod +x "$case_dir/bin/jj"
    PATH="$case_dir/bin:$PATH"
    reject work
    contains 'settings may be partial'
    [[ $(commit_id) == $before ]] || fail 'partial config failure rewrote @'
    PATH=$old_path
    check work
    [[ $(author) == $'Work Person\nwork@example.invalid' ]] || fail 'rerun did not recover from partial writes'
}

write_failure() {
    init_profiles
    new_jj --colocate
    local before=$(commit_id) git_dir=$(j --ignore-working-copy git root)
    : > "$git_dir/config.lock"
    reject work
    contains 'write failed'
    [[ $(commit_id) == $before ]] || fail 'write failure rewrote @'
}

source_resolution() {
    if [[ $1 == relative ]]; then
        ( cd "${source_dir:h}"; source repo4/repo4.zsh; cd /; repo4 init ) > "$output" 2>&1
    else
        mkdir -p "$XDG_CONFIG_HOME/repo4" "$case_dir/links"
        ln -s '../checkout with spaces/stow/xdg/repo4/repo4.zsh' "$case_dir/links/helper.zsh"
        ln -s "$case_dir/links/helper.zsh" "$XDG_CONFIG_HOME/repo4/repo4.zsh"
        ( cd "$XDG_CONFIG_HOME"; source repo4/repo4.zsh; cd /; repo4 init ) > "$output" 2>&1
    fi
    [[ -f $profiles && ! -L $profiles ]] || fail 'template lookup depends on the current directory'
    [[ -z $(git config --file "$profiles" --get profile.work.name) ]] || fail 'wrong template copied'
}

retargeted_helper() {
    mkdir -p "$XDG_CONFIG_HOME/repo4"
    ln -s "$source_dir/repo4.zsh" "$XDG_CONFIG_HOME/repo4/repo4.zsh"
    source "$XDG_CONFIG_HOME/repo4/repo4.zsh"
    mv "${source_dir:h}" "$case_dir/relocated checkout"
    rm "$XDG_CONFIG_HOME/repo4/repo4.zsh"
    ln -s "$case_dir/relocated checkout/repo4/repo4.zsh" "$XDG_CONFIG_HOME/repo4/repo4.zsh"
    check init
    [[ -f $profiles ]] || fail 'template lookup did not follow the retargeted helper'
}

stow_integration() {
    bash "$repo_root/bin/stow" > "$output" 2>&1
    [[ $XDG_CONFIG_HOME/repo4/repo4.zsh -ef $repo_root/stow/xdg/repo4/repo4.zsh ]] || fail 'helper not stowed'
    [[ ! -e $profiles ]] || fail 'stow without --repo4 created a live profile'
    [[ ! -e $XDG_CONFIG_HOME/repo4/identities.example && ! -L $XDG_CONFIG_HOME/repo4/identities.example ]] || fail 'template was stowed'
    bash "$repo_root/bin/stow" --repo4 > "$output" 2>&1
    [[ -f $profiles && ! -L $profiles ]] || fail '--repo4 did not create a private copy'
    [[ $(LC_ALL=C ls -l "$profiles") == -rw-------* ]] || fail '--repo4 did not use mode 600'
    source "$XDG_CONFIG_HOME/repo4/repo4.zsh"
    check init
    git config --file "$profiles" profile.work.name 'Private Work Name'
    local before=$(cksum "$profiles"; ls -di "$profiles")
    bash "$repo_root/bin/stow" --repo4 > "$output" 2>&1
    [[ $(cksum "$profiles"; ls -di "$profiles") == $before ]] || fail 'stow modified private profiles'
}

stow_init_dry_run() {
    bash "$repo_root/bin/stow" --repo4 --ssh --tmux blue --dry-run > "$output" 2>&1
    contains '[dry-run] repo4 init'
    [[ ! -e $XDG_CONFIG_HOME && ! -e $XDG_STATE_HOME && ! -e $HOME/.vimrc ]] || fail 'dry run created files'
    bash "$repo_root/bin/stow" --repo4 --ssh --tmux blue > "$output" 2>&1
    [[ -f $profiles && -L $HOME/.vimrc-ssh ]] || fail '--repo4 did not compose with --ssh'
    [[ $HOME/.tmux.conf -ef $repo_root/stow/tmux-blue/.tmux.conf ]] || fail '--repo4 ignored tmux selection'
    local before=$(cksum "$profiles"; ls -di "$profiles")
    bash "$repo_root/bin/stow" --repo4 --dry-run > "$output" 2>&1
    [[ $(cksum "$profiles"; ls -di "$profiles") == $before ]] || fail 'dry run changed existing profiles'
}

stow_init_conflict() {
    mkdir -p "${profiles:h}"
    if [[ $1 == directory ]]; then mkdir "$profiles"; else ln -s "$source_dir/identities.example" "$profiles"; fi
    local before=$(ls -di "$profiles") flag
    for flag in '' --dry-run; do
        if bash "$repo_root/bin/stow" --repo4 ${flag:+'--dry-run'} > "$output" 2>&1; then fail 'stow accepted a private-file conflict'; fi
        contains 'regular, private file'
        [[ ! -e $HOME/.vimrc && ! -e $XDG_CONFIG_HOME/repo4/repo4.zsh && ! -e $XDG_STATE_HOME ]] || fail 'init conflict was not preflighted'
        [[ $(ls -di "$profiles") == $before ]] || fail 'init conflict was overwritten'
    done
}

stow_missing_template() {
    local checkout=${source_dir:h:h:h}
    mkdir -p "$checkout/bin" "$checkout/stow/home" "$checkout/stow/agents" "$checkout/stow/tmux-green"
    cp "$repo_root/bin/stow" "$checkout/bin/stow"
    rm "$source_dir/identities.example"
    if bash "$checkout/bin/stow" --repo4 > "$output" 2>&1; then fail 'stow accepted a missing init template'; fi
    contains 'template missing'
    [[ ! -e $XDG_CONFIG_HOME && ! -e $HOME/.pi ]] || fail 'missing template was not preflighted'
}

stow_missing_zsh() {
    local bash_binary=$commands[bash]
    mkdir "$case_dir/bin"
    ln -s "$commands[dirname]" "$case_dir/bin/dirname"
    ln -s "$commands[stow]" "$case_dir/bin/stow"
    if PATH="$case_dir/bin" "$bash_binary" "$repo_root/bin/stow" --repo4 > "$output" 2>&1; then fail 'stow accepted missing zsh'; fi
    contains '--repo4 requires zsh'
    [[ ! -e $HOME/.vimrc && ! -e $XDG_CONFIG_HOME && ! -e $XDG_STATE_HOME ]] || fail 'missing zsh was not preflighted'
}

run_test 'private initialization, permissions, and non-overwriting copies' initialization
run_test 'default XDG path and invalid bases' default_config_home
run_test 'missing template does not create profiles' missing_template
run_test 'live profiles cannot be symlinks' private_symlink
run_test 'Git selection, subdirectories, unchanged HEAD, and idempotence' git_identity
for mode in --colocate --no-colocate; do
    run_test "JJ $mode identity and leaf-author repair are idempotent" jj_identity "$mode"
done
for kind in blank-name blank-email duplicate newline invalid-email malformed missing; do
    run_test "$kind profile fails before repository changes" invalid_profile "$kind"
done
for name in '123 O\Team "Work"' 123 true; do
    run_test "name '$name' remains a string with correct Git and TOML escaping" quoted_identity "$name"
done
run_test 'fresh clone without global JJ identity needs only repo4' anonymous_clone
run_test 'tracked Git config has no identity fallback' global_identity_guard
run_test 'invalid arguments and non-repository invocation' bad_arguments
for variable in GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_EMAIL JJ_USER JJ_EMAIL GIT_DIR GIT_CONFIG_COUNT; do
    run_test "$variable override is refused" environment_override "$variable"
done
for kind in author.name committer.email worktree; do
    run_test "Git $kind override is refused" git_overrides "$kind"
done
run_test 'JJ workspace overrides are refused' jj_workspace_override
for kind in immutable descendants; do
    run_test "$kind prevents automatic author rewriting" unsafe_author_rewrite "$kind"
done
run_test 'nested Git does not configure the outer JJ repository' nested_git
run_test 'non-colocated JJ does not configure the outer Git repository' nested_jj
run_test 'Git worktrees receive repository-local settings' git_worktree
run_test 'JJ workspace selection configures the repository, repairs only current @' jj_workspace
run_test 'matching immutable authors are not rewritten' matching_immutable_author
run_test 'missing JJ fails before any Git settings change' missing_jj
run_test 'JJ write failure reports partial settings; rerunning recovers' jj_write_failure
run_test 'write failure is reported without author rewriting' write_failure
for kind in relative symlink; do
    run_test "$kind source resolves its template after changing directory" source_resolution "$kind"
done
run_test 'template lookup follows helper retargeting without re-sourcing' retargeted_helper
run_test 'stow links only the helper; --repo4 initializes without overwriting' stow_integration
run_test '--repo4 composes with other flags; dry runs never initialize' stow_init_dry_run
for kind in directory symlink; do
    run_test "private-file $kind conflict is checked before stowing" stow_init_conflict "$kind"
done
run_test '--repo4 checks template availability before stowing' stow_missing_template
run_test '--repo4 checks zsh availability before stowing' stow_missing_zsh
printf '\nAll %s repo4 tests passed (zsh %s).\n' "$test_count" "$ZSH_VERSION"
