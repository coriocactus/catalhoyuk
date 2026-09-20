#!/usr/bin/env bash
set -eEu

repo_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
# Keep Unix socket paths below the macOS/Linux length limits.
scratch=$(mktemp -d /tmp/catalhoyuk-config.XXXXXX)
trap 'rm -rf -- "$scratch"' EXIT
test_count=0
vim_binary=$(type -P vim)
tmux_binary=$(type -P tmux)
stow_binary=$(type -P stow)
zsh_binary=$(type -P zsh)
jj_binary=$(type -P jj)
prek_binary=$(type -P prek)

fail() {
    local details=
    [ ! -f "$output" ] || details=$(< "$output")
    printf 'FAIL: %s\n%s\n' "$*" "$details" >&2
    exit 1
}
absent() { [ ! -e "$1" ] && [ ! -L "$1" ] || fail "expected absent: $1"; }

setup() {
    case_dir="$scratch/$test_count"
    output="$case_dir/output"
    export HOME="$case_dir/home with spaces" XDG_CONFIG_HOME="$case_dir/config 'quoted'"
    export XDG_STATE_HOME="$case_dir/state" TMPDIR="$case_dir/tmp"
    export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$case_dir/gitconfig" JJ_CONFIG="$case_dir/jjconfig"
    unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS
    unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL EMAIL JJ_USER JJ_EMAIL JJ_WORKSPACE_ROOT
    unset TMUX HOMEBREW_PREFIX SKIP PREK_SKIP
    unset PREK_STATUS PREK_MESSAGE_STATUS PREK_FIX_FILE PREK_FIX_STAGE PREK_REWRITE_STAGE PREK_NO_TRAILER
    export PREK_HOME="$case_dir/prek-cache"
    export SHELL=/bin/sh TERM=xterm-256color TMUX_TMPDIR="$case_dir/tmux-tmp"
    export CALLS="$case_dir/calls" INSTALL_LOG="$case_dir/install-log" BREW_PREFIX="$case_dir/brew prefix"
    mkdir -p "$HOME" "$TMPDIR" "$case_dir/bin" "$BREW_PREFIX/bin" "$TMUX_TMPDIR"
    printf '[user]\nname = Test\nemail = test@example.invalid\n' > "$GIT_CONFIG_GLOBAL"
    cp "$repo_root/stow/home/.jjconfig.toml" "$JJ_CONFIG"
    printf '\n[user]\nname = "Test"\nemail = "test@example.invalid"\n' >> "$JJ_CONFIG"
    export PATH="$case_dir/bin:$HOME/.local/bin:$PATH"
    "$BASH" "$repo_root/bin/stow" > "$output" 2>&1
    cd "$case_dir"
    printf 'plain text\n' > plain.txt
}

run_test() {
    local title=$1
    shift
    test_count=$((test_count + 1))
    ( setup; trap 'fail "unexpected failure at line $LINENO"' ERR; "$@" )
    printf 'ok %s - %s\n' "$test_count" "$title"
}

vim_driver() {
    # Input is Vimscript assertions; finish by exposing v:errors to the harness.
    printf '%s\n' "$@" \
        'if !empty(v:errors) | call writefile(v:errors, $VIM_ERRORS) | cquit | endif' \
        'qa!' > "$case_dir/driver.vim"
}
run_vim() {
    export VIM_ERRORS="$case_dir/vim-errors"
    if ! "$vim_binary" -n -i NONE -es -V1 -u "$HOME/.vimrc" -S "$case_dir/driver.vim" -- "$1" > "$output" 2>&1; then
        [ ! -f "$VIM_ERRORS" ] || cp "$VIM_ERRORS" "$output"
        fail 'configured Vim failed'
    fi
}
block_network() {
    printf '%s\n' '#!/bin/sh' 'printf "%s\n" "$0" >> "$CALLS"' 'exit 99' > "$case_dir/bin/curl"
    printf '%s\n' '#!/bin/sh' 'for arg in "$@"; do' \
        '  case "$arg" in clone|fetch|pull|ls-remote) printf "git network\n" >> "$CALLS"; exit 99 ;; esac' \
        'done' 'exit 0' > "$case_dir/bin/git"
    chmod +x "$case_dir/bin/curl" "$case_dir/bin/git"
}
plug_fixture() {
    # Only the plugin manager API is stubbed; the installed vimrc is real.
    printf '%s\n' \
        'function! plug#begin() abort' \
        '  let g:plugs = {}' \
        '  let g:declared_plugins = 0' \
        '  command! -nargs=+ Plug let g:declared_plugins += 1' \
        '  command! -nargs=* PlugInstall call writefile([<q-args>], $INSTALL_LOG, "a")' \
        'endfunction' \
        'function! plug#end() abort' \
        'endfunction' > "$1"
}

vim_offline() {
    block_network
    if [ "$1" = manager ]; then
        mkdir -p "$HOME/.vim/autoload"
        plug_fixture "$HOME/.vim/autoload/plug.vim"
    fi
    vim_driver \
        'execute "source " . fnameescape($HOME . "/.vimrc")' \
        'execute "source " . fnameescape($HOME . "/.vimrc")' \
        'doautocmd VimEnter' \
        'setfiletype typescript' \
        'call assert_equal("", &omnifunc)' \
        'call assert_equal("", maparg("K", "n"))' \
        'call assert_equal(2, exists(":BootstrapPlugins"))'
    run_vim "$case_dir/plain.txt"
    absent "$CALLS"
    absent "$INSTALL_LOG"
}

vim_title() {
    local name=$1
    export TMUX=fixture
    printf '%s\n' '#!/bin/sh' 'printf "%s\0" "$@" >> "$CALLS"' > "$case_dir/bin/tmux"
    chmod +x "$case_dir/bin/tmux"
    : > "$name"
    vim_driver \
        'execute "source " . fnameescape($HOME . "/.vimrc")' \
        'execute "source " . fnameescape($HOME . "/.vimrc")' \
        'call writefile([], $CALLS, "b")' \
        'doautocmd tmux_title FocusGained'
    run_vim "$case_dir/$name"
    absent "$case_dir/MARKER"
    printf '%s\0' rename-window -- "$name" rename-window -- sh > "$case_dir/expected"
    cmp "$case_dir/expected" "$CALLS" || fail 'tmux title arguments changed or autocmds accumulated'
}

vim_outside_tmux() {
    printf '%s\n' '#!/bin/sh' 'touch "$CALLS"' > "$case_dir/bin/tmux"
    chmod +x "$case_dir/bin/tmux"
    vim_driver 'doautocmd tmux_title FocusGained'
    run_vim "$case_dir/plain.txt"
    absent "$CALLS"
}

vim_bootstrap() {
    export PLUG_FIXTURE="$case_dir/plug.vim"
    plug_fixture "$PLUG_FIXTURE"
    if [ "$1" = failure ]; then
        printf '%s\n' '#!/bin/sh' 'printf "partial download" > "$6"' 'exit 22' > "$case_dir/bin/curl"
        vim_driver \
            'try' \
            '  BootstrapPlugins' \
            '  call assert_report("failed download was accepted")' \
            'catch /vim-plug download failed/' \
            'endtry' \
            'call assert_equal([], glob($HOME . "/.vim/autoload/plug.vim*", 0, 1))'
    else
        printf '%s\n' '#!/bin/sh' 'printf "download\n" >> "$CALLS"' 'cp "$PLUG_FIXTURE" "$6"' > "$case_dir/bin/curl"
        vim_driver \
            'BootstrapPlugins' \
            'call assert_equal(9, g:declared_plugins)' \
            'call assert_equal(readfile($PLUG_FIXTURE), readfile($HOME . "/.vim/autoload/plug.vim"))' \
            'BootstrapPlugins' \
            'call assert_equal(["download"], readfile($CALLS))' \
            'call assert_equal(["--sync", "--sync"], readfile($INSTALL_LOG))'
    fi
    chmod +x "$case_dir/bin/curl"
    run_vim "$case_dir/plain.txt"
}

new_jj() {
    "$jj_binary" --no-pager git init --colocate "$case_dir/repo" > "$output" 2>&1
    cd "$case_dir/repo"
    cp "$repo_root/tests/fixtures/prek" "$case_dir/bin/prek"
    chmod +x "$case_dir/bin/prek"
}
jj_paths() {
    new_jj
    local file
    local names=('file with spaces.py' "quote's.py" 'glob*.py' 'glob-other.py' '--option.py' $'line\nbreak.py')
    for file in "${names[@]}"; do printf 'changed\n' > "$file"; done
    jj --no-pager new > "$output" 2>&1
    printf 'not selected\n' > only-in-working-copy.py
    mkdir nested
    cd nested
    jj --no-pager prek ruff --verbose > "$output" 2>&1
    [ "$(< "$CALLS.cwd")" = "$(cd .. && pwd -P)" ] || fail 'hooks ran outside the workspace root'
    local args=() arg found expected
    while IFS= read -r -d '' arg; do args+=("$arg"); done < "$CALLS"
    [ "${#args[@]}" -eq 10 ] || fail 'wrong number of hook arguments'
    [ "${args[0]} ${args[1]} ${args[2]} ${args[3]}" = 'run ruff --verbose --files' ] || fail 'hook options were not forwarded'
    for expected in "${names[@]}"; do
        found=0
        for arg in "${args[@]:4}"; do [ "$arg" != "./$expected" ] || found=$((found + 1)); done
        [ "$found" -eq 1 ] || fail "filename did not arrive intact: $expected"
    done
    # -R must use the selected workspace, not the caller's current directory.
    cd "$case_dir"
    jj --no-pager -R "$case_dir/repo" prek --verbose > "$output" 2>&1
    [ "$(< "$CALLS.cwd")" = "$(cd repo && pwd -P)" ] || fail '-R selected the wrong workspace'
    absent "$CALLS.message-args"
}
jj_empty() {
    new_jj
    if [ "$1" = deleted ]; then
        printf 'old\n' > removed.py
        jj --no-pager new -m next > "$output" 2>&1
        rm removed.py
        jj --no-pager new > "$output" 2>&1
    elif [ "$1" = missing ]; then
        printf 'old\n' > removed.py
        jj --no-pager new > "$output" 2>&1
        rm removed.py
    else
        printf 'not selected\n' > only-in-working-copy.py
    fi
    jj --no-pager prek --verbose > "$output" 2>&1
    absent "$CALLS"
    absent "$CALLS.message-args"
    grep -F 'No changed files' "$output" >/dev/null || fail 'empty selection was not reported'
    grep -F 'Checks only; commit-msg hooks will not run.' "$output" >/dev/null || fail 'empty check-only run was not identified'
}
jj_failure() {
    new_jj
    printf 'changed\n' > changed.py
    jj --no-pager commit -m 'fix: changed file' > "$output" 2>&1
    if [ "$1" = diff ]; then
        printf '%s\n' '#!/bin/sh' 'printf "./partial.py\0"' 'exit 42' > "$case_dir/bin/jj"
        chmod +x "$case_dir/bin/jj"
        if JJ_WORKSPACE_ROOT="$PWD" jj-prek --verbose > "$output" 2>&1; then fail 'failed diff was accepted'; fi
        absent "$CALLS"
    else
        local rc=0
        PREK_STATUS=42 jj --no-pager prek > "$output" 2>&1 || rc=$?
        [ "$rc" -eq 42 ] || fail "hook failure status changed: $rc"
        if grep -F 'Review fixes' "$output" >/dev/null; then fail 'unchanged files prompted a squash'; fi
    fi
    absent "$CALLS.message-args"
    jj_no_temps
}

jj_no_temps() {
    [ -z "$(find "$TMPDIR" .git -name 'jj-prek.*' -print)" ] || fail 'jj prek temporary files leaked'
}
jj_fixes() {
    new_jj
    printf 'unformatted\n' > target.py
    jj --no-pager commit -m 'fix: format target' > "$output" 2>&1
    local parent rc=0 pre_status=0 message_status=0 expected=1
    if [ "$1" = pre-commit ]; then pre_status=$2; else message_status=$2; fi
    if [ "$2" -ne 0 ]; then expected=$2; fi
    parent=$(jj --no-pager log --no-graph -r @- -T commit_id)
    PREK_FIX_FILE=target.py PREK_FIX_STAGE="$1" PREK_STATUS="$pre_status" PREK_MESSAGE_STATUS="$message_status" \
        jj --no-pager prek > "$output" 2>&1 || rc=$?
    [ "$rc" -eq "$expected" ] || fail "wrong status for hook fixes: $rc (expected $expected)"
    grep -F 'Review fixes, jj squash, then rerun jj prek.' "$output" >/dev/null || fail 'hook fixes lacked recovery guidance'
    if [ "$1" = pre-commit ]; then absent "$CALLS.message-args"; fi
    [ "$(< target.py)" = fixed ] || fail 'hooks did not modify the working copy'
    [ "$(jj --no-pager log --no-graph -r @- -T commit_id)" = "$parent" ] || fail 'hooks rewrote @-'
    [ "$(jj --no-pager diff -r @ --template path)" = target.py ] || fail 'fixes are not visible in @ for manual squash'
    jj_no_temps
    # The explicit squash-and-rerun workflow must then succeed.
    jj --no-pager squash > "$output" 2>&1
    jj --no-pager prek >> "$output" 2>&1
    jj --no-pager log --no-graph -r @- -T description | grep -q 'Signed-off-by: fixture commit-msg' || fail 'rerun did not sign off'
    jj_no_temps
}

jj_full_run() {
    new_jj
    printf 'changed\n' > target.py
    local description=$'feat: check target\n\nKeep this body.\n\nCo-authored-by: Other <other@example.invalid>'
    jj --no-pager commit -m "$description" > "$output" 2>&1
    jj --no-pager bookmark create checked -r @- >> "$output" 2>&1
    local parent
    parent=$(jj --no-pager log --no-graph -r @- -T commit_id)
    cd "$case_dir"
    jj --no-pager -R "$case_dir/repo" prek > "$output" 2>&1
    cd "$case_dir/repo"
    if grep -F 'Checks only' "$output" >/dev/null; then fail 'full run was labelled check-only'; fi
    printf '%s\n' pre-commit commit-msg > "$case_dir/expected"
    cmp "$case_dir/expected" "$CALLS.stages" || fail 'stages did not run in order'
    printf '%s\0' run --stage pre-commit --files ./target.py > "$case_dir/expected"
    cmp "$case_dir/expected" "$CALLS" || fail 'wrong pre-commit arguments'
    printf '%s\0' run --stage commit-msg --all-files --commit-msg-filename "$(< "$CALLS.message-path")" > "$case_dir/expected"
    cmp "$case_dir/expected" "$CALLS.message-args" || fail 'wrong commit-msg arguments'
    [ "$(< "$CALLS.message-before")" = "$description" ] || fail 'description changed before hooks'
    [ "$(jj --no-pager log --no-graph -r @- -T description)" = "$description"$'\n\nSigned-off-by: fixture commit-msg' ] || fail 'hook message was not applied intact'
    [ -z "$(jj --no-pager diff --from "$parent" --to @- --template path)" ] || fail 'sign-off changed file contents'
    [ "$(jj --no-pager log --no-graph -r @ -T empty)" = true ] || fail 'sign-off left changes in @'
    [ "$(jj --no-pager log --no-graph -r checked -T commit_id)" = "$(jj --no-pager log --no-graph -r @- -T commit_id)" ] || fail 'bookmark did not follow sign-off'
    jj_no_temps
    parent=$(jj --no-pager log --no-graph -r @- -T commit_id)
    jj --no-pager prek > "$output" 2>&1
    [ "$(jj --no-pager log --no-graph -r @- -T commit_id)" = "$parent" ] || fail 'unchanged message needlessly rewrote @-'
    jj_no_temps
}

jj_guard() {
    new_jj
    printf 'changed\n' > target.py
    jj --no-pager commit -m 'fix: check target' > "$output" 2>&1
    case "$1" in
        dirty) printf 'unscanned\n' > target.py ;;
        missing) rm target.py ;;
        sparse) jj --no-pager sparse set --clear >> "$output" 2>&1 ;;
        merge)
            jj --no-pager bookmark create checked -r @- >> "$output" 2>&1
            jj --no-pager new @-- -m sibling >> "$output" 2>&1
            jj --no-pager new @ checked >> "$output" 2>&1 ;;
        conflict)
            jj --no-pager new @- -m left >> "$output" 2>&1
            printf 'left\n' > target.py
            jj --no-pager bookmark create left >> "$output" 2>&1
            jj --no-pager new @- -m right >> "$output" 2>&1
            printf 'right\n' > target.py
            jj --no-pager new @ left -m merge >> "$output" 2>&1
            jj --no-pager new >> "$output" 2>&1 ;;
        undescribed) jj --no-pager describe -r @- -m '' >> "$output" 2>&1 ;;
        SKIP|PREK_SKIP) export "$1=files" ;;
        noncolocated)
            jj --no-pager git init --no-colocate "$case_dir/other" >> "$output" 2>&1
            cd "$case_dir/other" ;;
    esac
    if jj --no-pager prek > "$output" 2>&1; then fail "accepted $1 for full run"; fi
    absent "$CALLS"
    absent "$CALLS.message-args"
    [ -z "$(find "$TMPDIR" . -name 'jj-prek.*' -print)" ] || fail 'guard leaked temporary files'
}

jj_message_failure() {
    new_jj
    printf 'changed\n' > target.py
    jj --no-pager commit -m 'fix: check target' > "$output" 2>&1
    local parent rc=0
    parent=$(jj --no-pager log --no-graph -r @- -T commit_id)
    PREK_MESSAGE_STATUS=43 jj --no-pager prek > "$output" 2>&1 || rc=$?
    [ "$rc" -eq 43 ] || fail 'commit-msg failure status changed'
    if grep -F 'Review fixes' "$output" >/dev/null; then fail 'unchanged files prompted a squash'; fi
    [ -f "$CALLS.message-args" ] || fail 'commit-msg did not run'
    [ "$(jj --no-pager log --no-graph -r @- -T commit_id)" = "$parent" ] || fail 'failed message hook rewrote @-'
    jj_no_temps
}

jj_parent_changed() {
    new_jj
    printf 'changed\n' > target.py
    jj --no-pager commit -m 'fix: check target' > "$output" 2>&1
    if PREK_REWRITE_STAGE="$1" jj --no-pager prek > "$output" 2>&1; then fail 'concurrent rewrite was accepted'; fi
    [ "$(jj --no-pager log --no-graph -r @- -T description)" = 'fix: changed during hooks' ] || fail 'concurrent description was overwritten'
    jj_no_temps
}

jj_check_only() {
    new_jj
    printf 'changed\n' > target.py
    jj --no-pager commit -m 'fix: check target' > "$output" 2>&1
    local parent
    parent=$(jj --no-pager log --no-graph -r @- -T commit_id)
    # Even a clean workspace must not sign off partial, skipped, or dry runs.
    SKIP=files jj --no-pager prek "$1" > "$output" 2>&1
    grep -F 'Checks only; commit-msg hooks will not run.' "$output" >/dev/null || fail 'check-only run was not identified'
    [ -f "$CALLS" ] || fail 'check-only run did not invoke prek'
    absent "$CALLS.message-args"
    [ "$(jj --no-pager log --no-graph -r @- -T commit_id)" = "$parent" ] || fail 'check-only run rewrote @-'
    jj_no_temps
}

jj_real_prek() {
    new_jj
    rm "$case_dir/bin/prek"
    ln -s "$prek_binary" "$case_dir/bin/prek"
    printf '%s\n' 'repos:' '- repo: local' '  hooks:' \
        '  - id: files' '    name: files' '    language: system' \
        "    entry: bash \"$repo_root/tests/fixtures/prek\" run --stage pre-commit" \
        '    stages: [pre-commit]' '    types: [python]' '    always_run: true' \
        '  - id: message' '    name: message' '    language: system' \
        "    entry: bash \"$repo_root/tests/fixtures/prek\" run --stage commit-msg --commit-msg-filename" \
        '    stages: [commit-msg]' > .pre-commit-config.yaml
    printf 'base\n' > target.py
    jj --no-pager commit -m 'chore: configure hooks' > "$output" 2>&1
    case "$1" in
        changed|unchanged-message) printf 'changed\n' > target.py ;;
        deleted) rm target.py ;;
        empty) ;;
    esac
    jj --no-pager commit -m 'fix: check target' >> "$output" 2>&1
    if [ "$1" = unchanged-message ]; then export PREK_NO_TRAILER=1; fi
    local parent
    parent=$(jj --no-pager log --no-graph -r @- -T commit_id)
    jj --no-pager prek > "$output" 2>&1
    printf '%s\n' pre-commit commit-msg > "$case_dir/expected"
    cmp "$case_dir/expected" "$CALLS.stages" || fail 'real prek skipped a stage or always_run hook'
    if [ "$1" = unchanged-message ]; then
        [ "$(jj --no-pager log --no-graph -r @- -T commit_id)" = "$parent" ] || fail 'unmodified description caused a rewrite'
    else
        jj --no-pager log --no-graph -r @- -T description | grep -q 'Signed-off-by: fixture commit-msg' || fail 'real prek did not apply trailer'
    fi
    [ "$(jj --no-pager log --no-graph -r @ -T empty)" = true ] || fail 'real prek changed @'
    jj_no_temps
}

fake_brew() {
    printf '%s\n' '#!/bin/sh' 'printf "%s\n" "$BREW_PREFIX"' > "$case_dir/bin/brew"
    chmod +x "$case_dir/bin/brew"
    cp "$case_dir/bin/brew" "$BREW_PREFIX/bin/brew"
    ln -s "$zsh_binary" "$BREW_PREFIX/bin/zsh"
}
tmux_profile() (
    local colour=$1 mode=$2 socket="$case_dir/socket" expected
    trap '"$tmux_binary" -S "$socket" kill-server >/dev/null 2>&1 || :' EXIT
    fake_brew
    expected="$BREW_PREFIX/bin/zsh"
    case "$mode" in
        default-xdg) unset XDG_CONFIG_HOME ;;
        no-zsh) rm "$BREW_PREFIX/bin/zsh"; expected=/bin/sh ;;
        failed-brew) printf '%s\n' '#!/bin/sh' 'exit 1' > "$case_dir/bin/brew"; expected=/bin/sh ;;
        no-path|standard-prefix)
            if [ "$mode" = no-path ]; then
                export HOMEBREW_PREFIX="$BREW_PREFIX"
            else
                expected=/bin/sh
                local candidate
                for candidate in /opt/homebrew /home/linuxbrew/.linuxbrew /usr/local; do
                    if [ -x "$candidate/bin/brew" ]; then
                        [ ! -x "$candidate/bin/zsh" ] || expected="$candidate/bin/zsh"
                        break
                    fi
                done
            fi
            rm "$case_dir/bin/brew"
            ln -s "$tmux_binary" "$case_dir/bin/tmux"
            ln -s "$stow_binary" "$case_dir/bin/stow"
            export PATH="$case_dir/bin:/usr/bin:/bin" ;;
    esac
    "$BASH" "$repo_root/bin/stow" --tmux "$colour" > "$output" 2>&1
    if [ "$mode" = startup ]; then
        "$tmux_binary" -S "$socket" -f "$HOME/.tmux.conf" new-session -d -s config-test 'sleep 120' >> "$output" 2>&1
    else
        "$tmux_binary" -S "$socket" -f /dev/null new-session -d -s config-test 'sleep 120' >> "$output" 2>&1
        "$tmux_binary" -S "$socket" set-option -g default-shell /bin/sh
        "$tmux_binary" -S "$socket" source-file "$HOME/.tmux.conf" >> "$output" 2>&1
    fi
    [ "$("$tmux_binary" -S "$socket" show-options -gv default-shell)" = "$expected" ] || fail 'wrong tmux shell'
    [ "$("$tmux_binary" -S "$socket" show-options -gv status-bg)" = "$colour" ] || fail 'wrong tmux colour'
    [ "$("$tmux_binary" -S "$socket" show-options -gv history-limit)" = 50000 ] || fail 'common tmux settings were not loaded'
)

zsh_tools() {
    fake_brew
    mkdir -p "$BREW_PREFIX/share/zsh/site-functions"
    # These tools are only visible after zshrc establishes its paths.
    printf '%s\n' '#!/bin/sh' 'printf "%s\n" "typeset -g FZF_LOADED=1"' > "$BREW_PREFIX/bin/fzf"
    local tool
    for tool in mise just; do
        printf '%s\n' '#!/bin/sh' 'exit 0' > "$BREW_PREFIX/bin/$tool"
    done
    # A leftover fnm installation must never be initialized.
    printf '%s\n' '#!/bin/sh' 'printf "fnm invoked\n" >> "$CALLS"' 'exit 99' > "$BREW_PREFIX/bin/fnm"
    chmod +x "$BREW_PREFIX/bin/"{fzf,fnm,mise,just}
}

zsh_runtime_manager() {
    zsh_tools
    export MISE_CALLS="$case_dir/mise-calls" RUNTIME_BIN="$case_dir/mise node/bin"
    mkdir -p "$RUNTIME_BIN"
    printf '%s\n' '#!/bin/sh' 'exit 0' > "$RUNTIME_BIN/node"
    cp "$RUNTIME_BIN/node" "$BREW_PREFIX/bin/node"
    chmod +x "$RUNTIME_BIN/node" "$BREW_PREFIX/bin/node"
    printf '%s\n' '#!/bin/sh' \
        'printf "%s\n" "$*" >> "$MISE_CALLS"' \
        'case "$*" in' \
        '  "activate zsh") printf '\''path=("$RUNTIME_BIN" $path)\n'\'' ;;' \
        '  "completion zsh") printf "typeset -g MISE_COMPLETION_LOADED=1\n" ;;' \
        '  *) exit 99 ;;' \
        'esac' > "$BREW_PREFIX/bin/mise"
    printf '%s\n' \
        'source "$HOME/.zshrc"' \
        '[[ ${commands[node]} == "$RUNTIME_BIN/node" ]] || exit 11' \
        '[[ ${MISE_COMPLETION_LOADED:-} == 1 ]] || exit 12' \
        '(( ! $+functions[fnm-purge] )) || exit 13' \
        'source "$HOME/.zshrc"' \
        '[[ ${commands[node]} == "$RUNTIME_BIN/node" ]] || exit 14' \
        > "$case_dir/runtime.zsh"
    "$zsh_binary" -f -i "$case_dir/runtime.zsh" > "$output" 2>&1
    absent "$CALLS"
    printf '%s\n' 'activate zsh' 'completion zsh' 'activate zsh' 'completion zsh' > "$case_dir/expected"
    cmp "$case_dir/expected" "$MISE_CALLS" || fail 'mise activation or completion was not initialized correctly'
}

zsh_reload() {
    zsh_tools
    printf '%s\n' '#!/bin/sh' 'if [ "${COMPLETE:-}" = zsh ]; then exit 0; fi' \
        'touch "$CALLS"; exit 1' > "$BREW_PREFIX/bin/jj"
    chmod +x "$BREW_PREFIX/bin/jj"
    printf '%s\n' \
        'function existing_hook() {}' \
        'precmd_functions=(existing_hook existing_hook)' \
        'chpwd_functions=(existing_hook existing_hook)' \
        'source "$HOME/.zshrc"' \
        'first_path=$PATH' \
        'first_fpath=(${fpath[@]})' \
        'source "$HOME/.zshrc"' \
        '[[ $PATH == $first_path && ${(j.:.)fpath} == ${(j.:.)first_fpath} ]] || exit 11' \
        '[[ ${FZF_LOADED:-} == 1 ]] || exit 12' \
        'expected="existing_hook update_git_branch update_jj_bookmark"' \
        '[[ ${(j: :)precmd_functions} == $expected && ${(j: :)chpwd_functions} == $expected ]] || exit 13' \
        '[[ $fpath[1] == "$BREW_PREFIX/share/zsh/site-functions" ]] || exit 14' \
        '(( $+functions[repo4] && $+commands[jj-prek] )) || exit 15' \
        'for hook in $precmd_functions $chpwd_functions; do "$hook"; done' \
        '[[ $XDG_CONFIG_HOME == *"config '\''quoted'\''" ]] || exit 16' \
        > "$case_dir/reload.zsh"
    "$zsh_binary" -f -i "$case_dir/reload.zsh" > "$output" 2>&1
    absent "$CALLS"
}

zsh_vcs_variables() {
    zsh_tools
    export GIT_REPO="$case_dir/git" GIT_WORKTREE="$case_dir/worktree" JJ_REPO="$case_dir/jj"
    git init --quiet -b branch-one "$GIT_REPO"
    git -C "$GIT_REPO" commit --quiet --allow-empty -m initial
    git -C "$GIT_REPO" worktree add --quiet -b worktree-branch "$GIT_WORKTREE"
    jj --no-pager git init --no-colocate "$JJ_REPO" > "$output" 2>&1
    ( cd "$JJ_REPO"; jj --no-pager bookmark create book-one; jj --no-pager new ) >> "$output" 2>&1
    mkdir "$GIT_REPO/nested" "$JJ_REPO/nested"
    printf '%s\n' \
        'fail() { print -ru2 -- "$*"; exit 1; }' \
        'run_precmd() { local hook; for hook in $precmd_functions; do "$hook"; done; }' \
        'cd "$GIT_REPO/nested"' \
        'source "$HOME/.zshrc"' \
        '[[ $BRANCH == branch-one && -z $BOOKMARK ]] || fail "initial Git variables"' \
        'source "$HOME/.zshrc"' \
        'source "$HOME/.zshrc"' \
        '[[ ${(j: :)precmd_functions} == "update_git_branch update_jj_bookmark" ]] || fail "duplicate precmd hooks"' \
        '[[ ${(j: :)chpwd_functions} == "update_git_branch update_jj_bookmark" ]] || fail "duplicate chpwd hooks"' \
        'git switch --quiet -c branch-two' \
        'run_precmd' \
        '[[ $BRANCH == branch-two ]] || fail "Git branch did not refresh before prompt"' \
        'cd "$GIT_WORKTREE"' \
        '[[ $BRANCH == worktree-branch && -z $BOOKMARK ]] || fail "Git worktree variables"' \
        'cd "$JJ_REPO/nested"' \
        '[[ -z $BRANCH && $BOOKMARK == book-one ]] || fail "JJ bookmark did not refresh on cd"' \
        'jj --no-pager bookmark rename book-one book-two' \
        'run_precmd' \
        '[[ $BOOKMARK == book-two ]] || fail "JJ bookmark did not refresh before prompt"' \
        'source "$HOME/.zshrc"' \
        '[[ $BOOKMARK == book-two ]] || fail "JJ bookmark lost on reload"' \
        'jj --no-pager bookmark forget book-two' \
        'run_precmd' \
        '[[ -z $BOOKMARK ]] || fail "deleted bookmark remained cached"' \
        'jj --no-pager bookmark create book-three' \
        'run_precmd' \
        '[[ $BOOKMARK == book-three ]] || fail "new bookmark was not found"' \
        'old_path=$PATH' \
        'PATH=/nonexistent' \
        'update_jj_bookmark' \
        '[[ -z $BOOKMARK ]] || fail "missing JJ left a stale bookmark"' \
        'PATH=$old_path' \
        'cd "$TMPDIR"' \
        '[[ -z $BRANCH && -z $BOOKMARK ]] || fail "repository variables did not clear on exit"' \
        > "$case_dir/vcs.zsh"
    "$zsh_binary" -f -i "$case_dir/vcs.zsh" >> "$output" 2>&1
}

for state in fresh manager; do run_test "Vim starts and reloads offline ($state)" vim_offline "$state"; done
for name in 'file with spaces.txt' "quote's\".txt" 'note; touch MARKER; echo done' \
    'glob*[?].txt' '--option.txt' $'line\nbreak.txt'; do
    run_test "Vim tmux titles preserve literal filename: $name" vim_title "$name"
done
run_test 'Vim does not invoke tmux outside a tmux session' vim_outside_tmux
for outcome in failure success; do run_test "explicit Vim bootstrap: $outcome" vim_bootstrap "$outcome"; done
run_test 'jj prek selects @- filenames, not @, and preserves options and subdirectories' jj_paths
for state in empty deleted missing; do run_test "jj prek skips $state selections" jj_empty "$state"; done
for kind in diff hook; do run_test "jj prek propagates $kind failure and cleans up" jj_failure "$kind"; done
run_test 'jj prek runs both stages, preserves the description, and follows bookmarks' jj_full_run
for state in dirty missing sparse merge conflict undescribed SKIP PREK_SKIP noncolocated; do
    run_test "jj prek refuses $state full runs" jj_guard "$state"
done
for stage in pre-commit commit-msg; do
    run_test "jj prek refuses successful $stage hooks that change files; squash and rerun succeeds" jj_fixes "$stage" 0
    run_test "jj prek refuses concurrent parent rewrites during $stage" jj_parent_changed "$stage"
done
run_test 'jj prek reports failing pre-commit fixes and preserves the exit code' jj_fixes pre-commit 42
run_test 'jj prek reports failing commit-msg fixes and preserves the exit code' jj_fixes commit-msg 43
run_test 'jj prek propagates message-hook failure without rewriting @-' jj_message_failure
for option in ruff --verbose --dry-run; do run_test "jj prek $option is check-only" jj_check_only "$option"; done
for state in changed deleted empty unchanged-message; do run_test "jj prek with real prek: $state" jj_real_prek "$state"; done
for colour in green red blue; do run_test "tmux $colour loads common settings and Homebrew Zsh" tmux_profile "$colour" brew; done
for mode in default-xdg no-zsh failed-brew no-path standard-prefix startup; do run_test "tmux Homebrew discovery: $mode" tmux_profile blue "$mode"; done
run_test 'Zsh uses mise ahead of Homebrew runtimes and never initializes leftover fnm' zsh_runtime_manager
run_test 'Zsh reload is idempotent, preserves hooks, and discovers tools before initialization' zsh_reload
run_test 'BRANCH and BOOKMARK track real repositories, prompts, directory changes, and reloads' zsh_vcs_variables
printf '\nAll %s configuration tests passed.\n' "$test_count"
