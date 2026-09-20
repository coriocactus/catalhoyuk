#!/usr/bin/env bash
set -eEu

repo_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
test_root=$(mktemp -d "${TMPDIR:-/tmp}/catalhoyuk-stow.XXXXXX")
trap 'rm -rf -- "$test_root"' EXIT
test_root=$(cd -- "$test_root" && pwd -P)
test_count=0

fail() {
    local details=
    [ ! -f "$output" ] || details=$(< "$output")
    printf 'FAIL: %s\n' "$*" >&2
    [ -z "$details" ] || printf '%s\n' "$details" >&2
    exit 1
}

absent() { [ ! -e "$1" ] && [ ! -L "$1" ] || fail "expected absent: $1"; }
link() { [ -L "$1" ] && [ "$(readlink "$1")" = "$2" ] || fail "wrong link: $1 -> $2"; }
contains() { grep -F -- "$1" "$output" >/dev/null || fail "missing output: $1"; }
registry() { printf '%s/catalhoyuk/stow.tsv' "${XDG_STATE_HOME:-$HOME/.local/state}"; }

fixture_mappings() {
    local profile=$1 with_ssh=$2 i
    if [ "${#home[@]}" -gt 0 ]; then
        stow_register "$HOME" "${home[@]}" || return 1
    fi
    if [ "${#xdg_config_home[@]}" -gt 0 ]; then
        stow_register "${XDG_CONFIG_HOME:-$HOME/.config}" "${xdg_config_home[@]}" || return 1
    fi
    if [ "$with_ssh" = 1 ] && [ "${#ssh[@]}" -gt 0 ]; then
        stow_register "$HOME" "${ssh[@]}" || return 1
    fi
    if [ "${#tmux_profiles[@]}" -gt 0 ]; then
        for ((i=0; i<${#tmux_profiles[@]}; i+=2)); do
            if [ "${tmux_profiles[i]}" = "$profile" ]; then
                stow_register "$HOME" .mux "${tmux_profiles[i+1]}"
                return
            fi
        done
        _stow_error "unknown tmux profile: $profile"
        return 1
    fi
    return 0
}

run_stow() (
    trap - ERR
    source "$fixture/bin/stow"
    stow_mappings() { fixture_mappings "$@"; }
    stow_main "$@"
) > "$output" 2>&1
reject() {
    if run_stow "$@"; then fail "expected failure: $*"; fi
    contains 'error:'
}

untouched() {
    [ -z "$(find "$HOME" -mindepth 1 -print)" ] || fail 'home changed during preflight'
    absent "$(registry)"
}

setup() {
    case_dir="$test_root/$test_count"
    fixture="$case_dir/checkout with spaces"
    output="$case_dir/output"
    export HOME="$case_dir/home with spaces" XDG_CONFIG_HOME= XDG_STATE_HOME="$case_dir/state with spaces"
    mkdir -p "$HOME" "$fixture/bin" "$fixture/files" "$fixture/profiles" "$fixture/plugins"
    cp "$repo_root/bin/stow" "$fixture/bin/stow"
    local file
    for file in files/app.conf files/editor.conf files/remote.conf \
        profiles/green.conf profiles/red.conf profiles/blue.conf plugins/local; do
        printf '%s\n' "$file" > "$fixture/$file"
    done
    home=(
        ".app"     "files/app.conf"
        ".plugins" "plugins"
    )
    xdg_config_home=("editor/config" "files/editor.conf")
    ssh=(".remote" "files/remote.conf")
    tmux_profiles=(
        "green" "profiles/green.conf"
        "red"   "profiles/red.conf"
        "blue"  "profiles/blue.conf"
    )
}

run_test() {
    local title=$1
    shift
    test_count=$((test_count + 1))
    (
        setup
        trap 'fail "unexpected failure at line $LINENO"' ERR
        "$@"
    )
    printf 'ok %s - %s\n' "$test_count" "$title"
}

install() {
    run_stow
    link "$HOME/.app" "$fixture/files/app.conf"
    link "$HOME/.config/editor/config" "$fixture/files/editor.conf"
    link "$HOME/.plugins" "$fixture/plugins"
    link "$HOME/.mux" "$fixture/profiles/green.conf"
    absent "$HOME/.remote"
    [ -f "$(registry)" ] || fail 'no ownership state'
}

idempotent() {
    run_stow
    local before after
    before=$(find "$HOME" -type l -exec ls -di {} \; | sort; ls -di "$(registry)"; cksum "$(registry)")
    run_stow
    after=$(find "$HOME" -type l -exec ls -di {} \; | sort; ls -di "$(registry)"; cksum "$(registry)")
    [ "$before" = "$after" ] || fail 'repeat run changed links or state'
    if grep -v '^\[skip\]' "$output"; then fail 'repeat run was not a no-op'; fi
}

move_sources() {
    run_stow
    mv "$fixture/files" "$fixture/renamed files"
    home[1]="renamed files/app.conf"
    xdg_config_home[1]="renamed files/editor.conf"
    ssh[1]="renamed files/remote.conf"
    [ ! -e "$HOME/.app" ] || fail 'expected a dangling link before rerun'
    run_stow
    contains '[switch]'
    link "$HOME/.app" "$fixture/renamed files/app.conf"
    link "$HOME/.config/editor/config" "$fixture/renamed files/editor.conf"
    idempotent
}

move_directory() {
    run_stow
    mv "$fixture/plugins" "$fixture/new plugins"
    home[3]="new plugins"
    run_stow
    link "$HOME/.plugins" "$fixture/new plugins"
    [ -f "$HOME/.plugins/local" ] || fail 'directory content lost'
}

remap_existing_source() {
    run_stow
    cp "$fixture/files/app.conf" "$fixture/files/replacement.conf"
    home[1]="files/replacement.conf"
    run_stow
    link "$HOME/.app" "$fixture/files/replacement.conf"
    [ -f "$fixture/files/app.conf" ] || fail 'old source removed'
}

move_checkout() {
    run_stow
    mv "$fixture" "$case_dir/new checkout"
    fixture="$case_dir/new checkout"
    install
    idempotent
}

adopt_relative_link() {
    ln -s '../checkout with spaces/files/app.conf' "$HOME/.app"
    run_stow
    contains '[adopt]'
    link "$HOME/.app" '../checkout with spaces/files/app.conf'
    move_sources
}

edit_mapping() {
    run_stow
    home=(".new-destination" "files/editor.conf")
    xdg_config_home=() ssh=() tmux_profiles=()
    run_stow
    link "$HOME/.new-destination" "$fixture/files/editor.conf"
    link "$HOME/.app" "$fixture/files/app.conf"
    link "$HOME/.mux" "$fixture/profiles/green.conf"
}

profiles() {
    run_stow --ssh --tmux blue
    link "$HOME/.remote" "$fixture/files/remote.conf"
    link "$HOME/.mux" "$fixture/profiles/blue.conf"
    run_stow --tmux red
    link "$HOME/.mux" "$fixture/profiles/red.conf"
    link "$HOME/.remote" "$fixture/files/remote.conf"
    run_stow
    link "$HOME/.mux" "$fixture/profiles/green.conf"
    tmux_profiles+=("gold" "files/editor.conf")
    run_stow --tmux gold
    link "$HOME/.mux" "$fixture/files/editor.conf"
}

optional_move() {
    run_stow --ssh
    mv "$fixture/files/remote.conf" "$fixture/files/moved.conf"
    ssh[1]="files/moved.conf"
    run_stow
    link "$HOME/.remote" "$fixture/files/remote.conf"
    run_stow --ssh
    link "$HOME/.remote" "$fixture/files/moved.conf"
}

dry_run() {
    run_stow --dry-run --ssh --tmux blue
    contains '[dry-run link]'
    untouched
    absent "$XDG_STATE_HOME"
    run_stow
    local before
    before=$(cksum "$(registry)")
    mv "$fixture/files/app.conf" "$fixture/files/moved.conf"
    home[1]="files/moved.conf"
    run_stow --dry-run
    contains '[dry-run switch]'
    link "$HOME/.app" "$fixture/files/app.conf"
    [ "$before" = "$(cksum "$(registry)")" ] || fail 'dry run changed state'
}

dry_adopt() {
    ln -s "$fixture/files/app.conf" "$HOME/.app"
    run_stow --dry-run
    contains '[dry-run adopt]'
    absent "$(registry)"
    absent "$HOME/.mux"
}

conflict() {
    case "$1" in
        file) printf 'keep\n' > "$HOME/.mux" ;;
        directory) mkdir "$HOME/.mux" ;;
        link) ln -s "$fixture/files/app.conf" "$HOME/.mux" ;;
        dangling) ln -s "$case_dir/missing" "$HOME/.mux" ;;
        directory-link) ln -s "$fixture/plugins" "$HOME/.mux" ;;
    esac
    reject
    absent "$HOME/.app"
    absent "$(registry)"
    [ -e "$HOME/.mux" ] || [ -L "$HOME/.mux" ] || fail 'conflict removed'
    reject --dry-run
}

modified_owned_link() {
    run_stow
    local before
    before=$(cksum "$(registry)")
    rm "$HOME/.app"
    case "$1" in
        link) ln -s "$case_dir/user-choice" "$HOME/.app" ;;
        file) printf 'keep\n' > "$HOME/.app" ;;
        directory) mkdir "$HOME/.app" ;;
    esac
    reject
    [ "$before" = "$(cksum "$(registry)")" ] || fail 'failed preflight changed state'
    if [ "$1" = link ]; then link "$HOME/.app" "$case_dir/user-choice"; fi
}

parent_conflict() {
    case "$1" in
        file) printf 'keep\n' > "$HOME/.config" ;;
        dangling) ln -s "$case_dir/missing" "$HOME/.config" ;;
    esac
    reject
    contains 'parent is not a directory'
    absent "$HOME/.app"
    absent "$(registry)"
}

missing_source() {
    rm "$fixture/profiles/green.conf"
    reject
    contains 'missing source'
    untouched
}

optional_missing() {
    rm "$fixture/files/remote.conf" "$fixture/profiles/blue.conf"
    reject --ssh
    untouched
    reject --tmux blue
    untouched
    install
}

preflight_before_retarget() {
    run_stow
    mv "$fixture/files/app.conf" "$fixture/files/moved.conf"
    home[1]="files/moved.conf"
    rm "$fixture/profiles/green.conf"
    local before
    before=$(cksum "$(registry)")
    reject
    link "$HOME/.app" "$fixture/files/app.conf"
    [ "$before" = "$(cksum "$(registry)")" ] || fail 'partial state update'
}

xdg_and_cwd() {
    export XDG_CONFIG_HOME="$case_dir/alternate config"
    cd /
    run_stow
    link "$XDG_CONFIG_HOME/editor/config" "$fixture/files/editor.conf"
    absent "$HOME/.config"
    [ -f "$XDG_STATE_HOME/catalhoyuk/stow.tsv" ] || fail 'state override ignored'
}

state_default() {
    unset XDG_STATE_HOME
    run_stow
    [ -f "$HOME/.local/state/catalhoyuk/stow.tsv" ] || fail 'wrong default state path'
}

invalid_arguments() {
    reject --unknown
    reject --tmux
    reject --tmux --ssh
    reject --tmux missing
    reject --tmux red --tmux blue
    reject stray
    untouched
    XDG_CONFIG_HOME=relative reject
    XDG_STATE_HOME=relative reject
    HOME=relative reject
    HOME= reject
}

invalid_mapping() {
    home=() xdg_config_home=() ssh=() tmux_profiles=()
    case "$1" in
        odd) home=(.app files/app.conf .unpaired) ;;
        duplicate) home=(.app files/app.conf .app files/editor.conf) ;;
        ancestor) home=(.app files/app.conf .app/nested files/editor.conf) ;;
        descendant) home=(.app/nested files/editor.conf .app files/app.conf) ;;
        empty-destination) home=("" files/app.conf) ;;
        empty-source) home=(.app "") ;;
        absolute-destination) home=(/absolute/destination files/app.conf) ;;
        absolute-source) home=(.app /absolute/source) ;;
        destination-traversal) home=(../escape files/app.conf) ;;
        source-traversal) home=(.app ../escape) ;;
        nested-traversal) home=(folder/../escape files/app.conf) ;;
        empty-component) home=(folder//config files/app.conf) ;;
        dot-component) home=(folder/./config files/app.conf) ;;
        newline) home=($'.bad\nname' files/app.conf) ;;
        tab) home=(.app $'files/app\t.conf') ;;
        cross-group)
            home=(.config/editor/config files/app.conf)
            xdg_config_home=(editor/config files/editor.conf) ;;
    esac
    reject
    untouched
}

quoted_paths() {
    cp "$fixture/files/app.conf" "$fixture/files/config: #1.conf"
    home=(".app #1" "files/config: #1.conf" '$HOME.conf' "files/app.conf")
    xdg_config_home=(".app #1" "files/editor.conf")
    ssh=(".remote" "files/config: #1.conf")
    run_stow --ssh
    link "$HOME/.app #1" "$fixture/files/config: #1.conf"
    link "$HOME/\$HOME.conf" "$fixture/files/app.conf"
    link "$HOME/.config/.app #1" "$fixture/files/editor.conf"
    link "$HOME/.remote" "$fixture/files/config: #1.conf"
    idempotent
}

xdg_only() {
    home=() ssh=() tmux_profiles=()
    run_stow
    link "$HOME/.config/editor/config" "$fixture/files/editor.conf"
    absent "$HOME/.app"
}

empty_groups() {
    home=() xdg_config_home=() ssh=() tmux_profiles=()
    run_stow --ssh
    untouched
}

registration() {
    source "$fixture/bin/stow"
    local root=$fixture sources=() destinations=()
    stow_register "$HOME" .one files/app.conf .two files/editor.conf
    [ "${#sources[@]}" = 2 ] || fail 'wrong registration count'
    [ "${sources[0]}" = "$fixture/files/app.conf" ] || fail 'wrong source resolution'
    [ "${destinations[1]}" = "$HOME/.two" ] || fail 'registration order changed'
    stow_register "$HOME"
    if stow_register "$HOME" .unpaired > "$output" 2>&1; then fail 'odd pair count accepted'; fi
    if stow_register relative .three files/app.conf > "$output" 2>&1; then fail 'relative base accepted'; fi
    if stow_register > "$output" 2>&1; then fail 'missing base accepted'; fi
    untouched
}

bad_state() {
    mkdir -p "${XDG_STATE_HOME}/catalhoyuk"
    case "$1" in
        malformed) printf 'broken\n' > "$(registry)" ;;
        directory) mkdir "$(registry)" ;;
        symlink) ln -s "$case_dir/missing" "$(registry)" ;;
        parent) rm -r "${XDG_STATE_HOME}/catalhoyuk"; printf 'keep\n' > "${XDG_STATE_HOME}/catalhoyuk" ;;
    esac
    reject
    absent "$HOME/.app"
}

helper() {
    source "$fixture/bin/stow"
    untouched
    STOW_CHECK_ONLY=1 stow_link "$fixture/files/app.conf" "$HOME/.custom" > "$output"
    STOW_DRY_RUN=1 stow_link "$fixture/files/app.conf" "$HOME/.custom" > "$output"
    untouched
    stow_link "$fixture/files/app.conf" "$HOME/.custom" > "$output"
    mv "$fixture/files/app.conf" "$fixture/moved.conf"
    stow_link "$fixture/moved.conf" "$HOME/.custom" > "$output"
    link "$HOME/.custom" "$fixture/moved.conf"
    if stow_link relative "$HOME/.other" > "$output" 2>&1; then fail 'relative source accepted'; fi
    if stow_link "$fixture/moved.conf" relative > "$output" 2>&1; then fail 'relative destination accepted'; fi
    if stow_link "$fixture/moved.conf" "$HOME/" > "$output" 2>&1; then fail 'trailing slash accepted'; fi
    if stow_link > "$output" 2>&1; then fail 'missing arguments accepted'; fi
}

lock_refusal() {
    source "$fixture/bin/stow"
    local lock="$(registry).lock"
    mkdir -p "$lock"
    if stow_link "$fixture/files/app.conf" "$HOME/.custom" > "$output" 2>&1; then fail 'active lock accepted'; fi
    contains 'installer lock unavailable'
    absent "$HOME/.custom"
    absent "$(registry)"
    [ -d "$lock" ] || fail 'another process lock was removed'
    STOW_CHECK_ONLY=1 stow_link "$fixture/files/app.conf" "$HOME/.custom"
    STOW_DRY_RUN=1 stow_link "$fixture/files/app.conf" "$HOME/.custom" > "$output"
    absent "$HOME/.custom"
    rmdir "$lock"
    stow_link "$fixture/files/app.conf" "$HOME/.custom" > "$output"
    absent "$lock"
}

lock_cleanup() {
    source "$fixture/bin/stow"
    if ( ln() { return 1; }; stow_link "$fixture/files/app.conf" "$HOME/.custom" ) > "$output" 2>&1; then
        fail 'simulated link failure succeeded'
    fi
    absent "$(registry).lock"
    absent "$(registry)"
    stow_link "$fixture/files/app.conf" "$HOME/.custom" > "$output"
    absent "$(registry).lock"
}

lock_overlap() {
    source "$fixture/bin/stow"
    local destination
    for destination in "$(registry).lock" "$(registry).lock/child" "$(registry)/child"; do
        if stow_link "$fixture/files/app.conf" "$destination" > "$output" 2>&1; then fail 'state overlap accepted'; fi
        contains 'overlaps state'
    done
    untouched
}

concurrent_helpers() {
    source "$fixture/bin/stow"
    # Pause one registry commit while the other helper attempts to acquire the lock.
    (
        mv() {
            local i
            : > "$case_dir/ready"
            for ((i=0; i<500; i++)); do
                [ ! -e "$case_dir/release" ] || break
                sleep 0.02
            done
            [ -e "$case_dir/release" ] || return 1
            command mv "$@"
        }
        stow_link "$fixture/files/app.conf" "$HOME/.one"
    ) > "$case_dir/worker-output" 2>&1 &
    local worker=$! i
    trap 'touch "$case_dir/release"; wait "$worker" || :' EXIT
    for ((i=0; i<500; i++)); do
        [ ! -e "$case_dir/ready" ] || break
        sleep 0.02
    done
    [ -e "$case_dir/ready" ] || fail 'worker did not reach the registry commit'
    if stow_link "$fixture/files/editor.conf" "$HOME/.two" > "$output" 2>&1; then fail 'concurrent helper succeeded'; fi
    contains 'installer lock unavailable'
    absent "$HOME/.two"
    : > "$case_dir/release"
    wait "$worker"
    trap - EXIT
    stow_link "$fixture/files/editor.conf" "$HOME/.two" > "$output"
    [ "$(wc -l < "$(registry)" | tr -d ' ')" -eq 2 ] || fail 'ownership records were lost'
    mv "$fixture/files" "$fixture/moved"
    stow_link "$fixture/moved/app.conf" "$HOME/.one" > "$output"
    stow_link "$fixture/moved/editor.conf" "$HOME/.two" > "$output"
    link "$HOME/.one" "$fixture/moved/app.conf"
    link "$HOME/.two" "$fixture/moved/editor.conf"
    absent "$(registry).lock"
}

command_resolution() {
    mkdir "$case_dir/bin"
    ln -s "$(type -P echo)" "$case_dir/bin/stow"
    local PATH="$case_dir/bin:$PATH"
    source "$fixture/bin/stow"
    [ "$(type -t stow)" = file ] || fail 'sourcing shadows the stow executable'
    [ "$(stow external-stow)" = external-stow ] || fail 'stow no longer invokes the external command'
    declare -F stow_link >/dev/null || fail 'stow_link helper is missing'
    untouched
}

production_mapping() {
    # Follow the production arrays, not a duplicated file list.
    source "$repo_root/bin/stow"
    local root=$repo_root sources=() destinations=() i
    stow_mappings green 0
    "$BASH" "$repo_root/bin/stow" > "$output" 2>&1
    for ((i=0; i<${#sources[@]}; i++)); do link "${destinations[i]}" "${sources[i]}"; done
    "$BASH" "$repo_root/bin/stow" > "$output" 2>&1
    if grep -v '^\[skip\]' "$output"; then fail 'production mapping is not idempotent'; fi
}

run_test 'synthetic mapping installs files and directories' install
run_test 'repeat run preserves link and state inodes' idempotent
run_test 'moving sources only requires a mapping edit' move_sources
run_test 'mapped source directories can move' move_directory
run_test 'retargeting does not require deleting the old source' remap_existing_source
run_test 'moving the whole checkout preserves ownership' move_checkout
run_test 'existing relative links are adopted and survive source moves' adopt_relative_link
run_test 'new mappings work and removed mappings are left alone' edit_mapping
run_test 'SSH and tmux selections; new profiles are mapping data' profiles
run_test 'unselected optional links are untouched after a source move' optional_move
run_test 'dry runs never create or change links or state' dry_run
run_test 'dry-run adoption does not register ownership' dry_adopt
for kind in file directory link dangling directory-link; do
    run_test "unowned $kind conflict prevents partial installation" conflict "$kind"
done
for kind in link file directory; do
    run_test "owned link replaced manually with $kind is protected" modified_owned_link "$kind"
done
for kind in file dangling; do
    run_test "parent $kind conflict is preflighted" parent_conflict "$kind"
done
run_test 'missing selected source prevents partial installation' missing_source
run_test 'unselected missing sources do not block installation' optional_missing
run_test 'late conflicts prevent partial retargeting' preflight_before_retarget
run_test 'XDG overrides, spaces, and unrelated working directory' xdg_and_cwd
run_test 'state defaults to ~/.local/state' state_default
run_test 'invalid CLI arguments and environment paths fail closed' invalid_arguments
for kind in odd duplicate ancestor descendant empty-destination empty-source \
    absolute-destination absolute-source destination-traversal source-traversal \
    nested-traversal empty-component dot-component newline tab cross-group; do
    run_test "invalid $kind mapping fails before installation" invalid_mapping "$kind"
done
run_test 'quoted paths retain spaces, punctuation, and literal dollar signs' quoted_paths
run_test 'empty home group with XDG-only mappings' xdg_only
run_test 'empty groups are safe under Bash 3.2 nounset' empty_groups
run_test 'registration resolves ordered pairs without filesystem changes' registration
for kind in malformed directory symlink parent; do
    run_test "invalid state $kind prevents installation" bad_state "$kind"
done
run_test 'sourceable helper tracks moves independently of mappings' helper
run_test 'active or stale locks fail closed; checks and dry runs remain read-only' lock_refusal
run_test 'failed link operations release their lock' lock_cleanup
run_test 'destinations cannot overlap registry or lock internals' lock_overlap
run_test 'concurrent helpers cannot lose ownership; retries preserve retargeting' concurrent_helpers
run_test 'sourcing preserves external stow command resolution' command_resolution
run_test 'production mappings install and are idempotent' production_mapping
printf '\nAll %s tests passed (%s).\n' "$test_count" "$BASH_VERSION"
