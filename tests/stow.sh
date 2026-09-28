#!/usr/bin/env bash
# Mechanism tests for bin/stow, run against a synthetic checkout so they never depend on
# which dotfiles are tracked. tests/config.sh installs the real packages.
set -eEu

repo_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/catalhoyuk-stow.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
test_count=0

fail() {
    local details=
    [ ! -f "$output" ] || details=$(< "$output")
    printf 'FAIL: %s\n%s\n' "$*" "$details" >&2
    exit 1
}
linked() { [ -L "$1" ] && [ "$1" -ef "$2" ] || fail "expected $1 -> $2"; }
absent() { [ ! -e "$1" ] && [ ! -L "$1" ] || fail "expected absent: $1"; }
real_dir() { [ -d "$1" ] && [ ! -L "$1" ] || fail "expected a real directory: $1"; }
# A regular file (not a link) whose content is exactly $2.
real_file() { [ -f "$1" ] && [ ! -L "$1" ] && [ "$(< "$1")" = "$2" ] || fail "expected a regular file containing '$2': $1"; }
contains() { grep -F -- "$1" "$output" >/dev/null || fail "missing output: $1"; }
install() { "$BASH" "$checkout/bin/stow" "$@" > "$output" 2>&1 || fail "stow $* failed"; }
reject() { if "$BASH" "$checkout/bin/stow" "$@" > "$output" 2>&1; then fail "stow $* unexpectedly succeeded"; fi; }
# Snapshot of the checkout and both targets: any change to paths, link targets, or contents shows.
state() {
    local dir path
    for dir in "$checkout/stow" "$HOME" "$XDG_CONFIG_HOME"; do
        [ -d "$dir" ] || continue
        find "$dir" | LC_ALL=C sort | while IFS= read -r path; do
            if [ -L "$path" ]; then printf '%s -> %s\n' "$path" "$(readlink "$path")"
            elif [ -f "$path" ]; then printf '%s = %s\n' "$path" "$(cksum < "$path")"
            else printf '%s/\n' "$path"
            fi
        done
    done
}
unchanged() { state > "$case_dir/after"; cmp -s "$case_dir/before" "$case_dir/after" || fail "$1"; }

put() { mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; }

setup() {
    case_dir="$scratch/$test_count"
    output="$case_dir/output"
    export HOME="$case_dir/home with spaces" XDG_CONFIG_HOME="$case_dir/config 'quoted'"
    export XDG_STATE_HOME="$case_dir/state"
    mkdir -p "$HOME"
    # Package names are fixed by bin/stow; their contents are placeholders.
    checkout="$case_dir/checkout with spaces"
    mkdir -p "$checkout/bin"
    cp "$repo_root/bin/stow" "$checkout/bin/"
    local pkgs="$checkout/stow"
    put "$pkgs/home/.homerc" home
    put "$pkgs/home/.local/bin/tool" tool
    put "$pkgs/xdg/app/config.toml" app
    put "$pkgs/xdg/repo4/identities.example" template
    put "$pkgs/agents/.agents/skills/demo/SKILL.md" skill
    put "$pkgs/agents/.agents/.skill-lock.json" lock
    put "$pkgs/agents/.pi/agent/settings.json" settings
    put "$pkgs/agents/.pi/agent/extensions/index.ts" extension
    put "$pkgs/vim-ssh/.vimrc-ssh" ssh
}

run_test() {
    local title=$1
    shift
    test_count=$((test_count + 1))
    ( setup; trap 'fail "unexpected failure at line $LINENO"' ERR; "$@" )
    printf 'ok %s - %s\n' "$test_count" "$title"
}

# ---- install ---------------------------------------------------------------

default_install() {
    install
    linked "$HOME/.homerc" "$checkout/stow/home/.homerc"
    linked "$HOME/.local/bin/tool" "$checkout/stow/home/.local/bin/tool"
    real_dir "$HOME/.local/bin"
    linked "$XDG_CONFIG_HOME/app/config.toml" "$checkout/stow/xdg/app/config.toml"
    real_dir "$XDG_CONFIG_HOME/app"
    absent "$XDG_CONFIG_HOME/repo4/identities.example"
    linked "$HOME/.agents" "$checkout/stow/agents/.agents"
    linked "$HOME/.pi/agent/settings.json" "$checkout/stow/agents/.pi/agent/settings.json"
    linked "$HOME/.pi/agent/extensions" "$checkout/stow/agents/.pi/agent/extensions"
    real_dir "$HOME/.pi/agent"
    absent "$HOME/.vimrc-ssh"
    absent "$XDG_STATE_HOME"
}

flags() {
    install --ssh
    linked "$HOME/.vimrc-ssh" "$checkout/stow/vim-ssh/.vimrc-ssh"
    install
    absent "$HOME/.vimrc-ssh"
    reject --bogus
    reject --tmux home
    reject stray
    reject track
    reject --ssh track "$HOME/.homerc"
    linked "$HOME/.homerc" "$checkout/stow/home/.homerc"
}

dry_run() {
    install --dry-run --ssh
    contains 'LINK: .vimrc-ssh'
    absent "$HOME/.homerc"
    absent "$HOME/.agents"
    absent "$HOME/.pi"
    absent "$XDG_CONFIG_HOME"
}

rename_prunes_stale_link() {
    install
    mv "$checkout/stow/home/.homerc" "$checkout/stow/home/.renamedrc"
    mv "$checkout/stow/xdg/app/config.toml" "$checkout/stow/xdg/app/other.toml"
    install
    absent "$HOME/.homerc"
    absent "$XDG_CONFIG_HOME/app/config.toml"
    linked "$HOME/.renamedrc" "$checkout/stow/home/.renamedrc"
    linked "$XDG_CONFIG_HOME/app/other.toml" "$checkout/stow/xdg/app/other.toml"
}

conflicts() {
    printf 'mine\n' > "$HOME/.homerc"
    reject
    contains 'conflict'
    real_file "$HOME/.homerc" mine
    rm "$HOME/.homerc"
    mkdir -p "$HOME/.local/bin"
    ln -s /etc/hosts "$HOME/.local/bin/tool"
    reject
    [ "$(readlink "$HOME/.local/bin/tool")" = /etc/hosts ] || fail 'foreign symlink was replaced'
    rm "$HOME/.local/bin/tool"
    mkdir -p "$HOME/.pi/agent/extensions"
    reject
    contains 'move aside'
    absent "$HOME/.homerc"
}

coexists_with_real_directories() {
    mkdir -p "$HOME/.agents/skills/own" "$HOME/.pi/agent/sessions"
    printf 'mine\n' > "$HOME/.agents/skills/own/SKILL.md"
    install
    real_dir "$HOME/.agents"
    real_file "$HOME/.agents/skills/own/SKILL.md" mine
    linked "$HOME/.agents/skills/demo" "$checkout/stow/agents/.agents/skills/demo"
    linked "$HOME/.agents/.skill-lock.json" "$checkout/stow/agents/.agents/.skill-lock.json"
    real_dir "$HOME/.pi/agent/sessions"
}

delete() {
    install --ssh
    mkdir -p "$HOME/.pi/agent/sessions"
    install --delete
    absent "$HOME/.homerc"
    absent "$HOME/.local/bin/tool"
    absent "$HOME/.vimrc-ssh"
    absent "$HOME/.agents"
    absent "$HOME/.pi/agent/settings.json"
    absent "$HOME/.pi/agent/extensions"
    absent "$XDG_CONFIG_HOME/app/config.toml"
    real_dir "$HOME/.pi/agent/sessions"
}

# ---- track / untrack -------------------------------------------------------

track_moves_and_links() {
    install
    printf 'secret\n' > "$HOME/.newrc"
    chmod 600 "$HOME/.newrc"
    install track "$HOME/.newrc"
    contains 'tracked ~/.newrc -> stow/home/.newrc'
    linked "$HOME/.newrc" "$checkout/stow/home/.newrc"
    real_file "$checkout/stow/home/.newrc" secret
    [ "$(LC_ALL=C ls -l "$checkout/stow/home/.newrc" | cut -c1-10)" = -rw------- ] || fail 'file mode was not kept'
    # A relative path works, and a full reinstall keeps the new link.
    put "$HOME/.relative" relative
    ( cd "$HOME" && "$BASH" "$checkout/bin/stow" track .relative ) > "$output" 2>&1 || fail 'relative track failed'
    linked "$HOME/.relative" "$checkout/stow/home/.relative"
    install
    linked "$HOME/.newrc" "$checkout/stow/home/.newrc"
}

track_chooses_package() {
    install
    put "$XDG_CONFIG_HOME/newapp/settings.ini" xdg
    put "$HOME/.local/bin/newtool" home
    put "$HOME/.pi/agent/models.json" agents
    put "$HOME/.pi/other.json" agents-shallow
    put "$HOME/.fresh/nested/file" new-directory
    install track "$XDG_CONFIG_HOME/newapp/settings.ini" "$HOME/.local/bin/newtool" \
        "$HOME/.pi/agent/models.json" "$HOME/.pi/other.json" "$HOME/.fresh/nested/file"
    linked "$XDG_CONFIG_HOME/newapp/settings.ini" "$checkout/stow/xdg/newapp/settings.ini"
    linked "$HOME/.local/bin/newtool" "$checkout/stow/home/.local/bin/newtool"
    linked "$HOME/.pi/agent/models.json" "$checkout/stow/agents/.pi/agent/models.json"
    linked "$HOME/.pi/other.json" "$checkout/stow/agents/.pi/other.json"
    linked "$HOME/.fresh/nested/file" "$checkout/stow/home/.fresh/nested/file"
    real_dir "$HOME/.pi/agent"
    real_dir "$HOME/.fresh/nested"
    real_dir "$XDG_CONFIG_HOME/newapp"
}

track_directory() {
    install
    put "$XDG_CONFIG_HOME/app/extra.toml" extra
    put "$XDG_CONFIG_HOME/app/sub dir/deep.toml" deep
    install track "$XDG_CONFIG_HOME/app/"
    linked "$XDG_CONFIG_HOME/app/extra.toml" "$checkout/stow/xdg/app/extra.toml"
    linked "$XDG_CONFIG_HOME/app/sub dir/deep.toml" "$checkout/stow/xdg/app/sub dir/deep.toml"
    linked "$XDG_CONFIG_HOME/app/config.toml" "$checkout/stow/xdg/app/config.toml"
    real_dir "$XDG_CONFIG_HOME/app/sub dir"
    reject track "$XDG_CONFIG_HOME/app"
    contains 'nothing untracked'
}

track_refusals() {
    install
    printf 'mine\n' > "$HOME/.mine"
    ln -s /etc/hosts "$HOME/.foreign"
    put "$case_dir/outside" outside
    put "$HOME/.dup" dup
    put "$checkout/stow/home/.dup" packaged
    state > "$case_dir/before"
    local refused
    for refused in "$HOME/.homerc" "$HOME/.foreign" "$HOME/.missing" "$case_dir/outside" "$HOME/.dup" \
        "$HOME/.agents/skills/demo/SKILL.md" "$HOME" "$XDG_CONFIG_HOME" "$checkout" "$case_dir"; do
        reject track "$refused"
    done
    contains 'refusing to track a directory containing'
    # One bad path refuses the whole batch.
    reject track "$HOME/.mine" "$HOME/.missing"
    reject track "$HOME/.mine" "$HOME/.mine"
    contains 'more than once'
    unchanged 'a refused track changed something'
}

track_rolls_back() {
    install
    printf 'mine\n' > "$HOME/.mine"
    # Stow refuses the whole package when anything conflicts; the file must go back.
    put "$checkout/stow/home/.clash" packaged
    put "$HOME/.clash" local
    state > "$case_dir/before"
    reject track "$HOME/.mine"
    contains 'nothing changed'
    unchanged 'failed stow was not rolled back'
    rm "$checkout/stow/home/.clash"
    # Stow silently skips names on its ignore list; those must go back too.
    put "$HOME/README.md" readme
    reject track "$HOME/.mine" "$HOME/README.md"
    contains 'stow ignores this name'
    linked "$HOME/.mine" "$checkout/stow/home/.mine"
    real_file "$HOME/README.md" readme
    absent "$checkout/stow/home/README.md"
}

track_git_ignored() {
    install
    git -C "$checkout" init --quiet
    printf '/stow/agents/.pi/agent/auth.json\n' > "$checkout/.gitignore"
    put "$HOME/.pi/agent/auth.json" token
    reject track "$HOME/.pi/agent/auth.json"
    contains 'ignored by git'
    real_file "$HOME/.pi/agent/auth.json" token
    absent "$checkout/stow/agents/.pi/agent/auth.json"
}

untrack_restores() {
    install
    install untrack "$HOME/.homerc" "$HOME/.local/bin/tool" "$XDG_CONFIG_HOME/app/config.toml"
    contains 'untracked ~/.homerc <- stow/home/.homerc'
    real_file "$HOME/.homerc" home
    real_file "$HOME/.local/bin/tool" tool
    real_file "$XDG_CONFIG_HOME/app/config.toml" app
    absent "$checkout/stow/home/.homerc"
    absent "$checkout/stow/home/.local"
    absent "$checkout/stow/xdg/app"
    real_dir "$checkout/stow/home"
    # A folded directory comes back whole.
    install untrack "$HOME/.agents"
    real_file "$HOME/.agents/skills/demo/SKILL.md" skill
    absent "$checkout/stow/agents/.agents"
    install
    real_file "$HOME/.homerc" home
}

untrack_refusals() {
    install
    ln -s /etc/hosts "$HOME/.foreign"
    ln -s "$checkout/stow/home/.gone" "$HOME/.dangling"
    mkdir -p "$case_dir/elsewhere"
    ln -s "$checkout/stow/home/.homerc" "$case_dir/elsewhere/.homerc"
    printf 'mine\n' > "$HOME/.mine"
    state > "$case_dir/before"
    local refused
    for refused in "$HOME/.mine" "$HOME/.foreign" "$HOME/.dangling" "$HOME/.missing" \
        "$HOME/.agents/skills/demo/SKILL.md" "$case_dir/elsewhere/.homerc"; do
        reject untrack "$refused"
    done
    reject untrack "$HOME/.homerc" "$HOME/.homerc"
    contains 'more than once'
    unchanged 'a refused untrack changed something'
}

round_trip() {
    install
    put "$HOME/.newrc" new
    put "$XDG_CONFIG_HOME/newapp/a" a
    state > "$case_dir/before"
    install --dry-run track "$HOME/.newrc" "$XDG_CONFIG_HOME/newapp"
    contains '[dry-run] track ~/.newrc -> stow/home/.newrc'
    unchanged 'dry-run track changed something'
    install track "$HOME/.newrc" "$XDG_CONFIG_HOME/newapp"
    install --dry-run untrack "$HOME/.newrc"
    contains '[dry-run] untrack ~/.newrc <- stow/home/.newrc'
    linked "$HOME/.newrc" "$checkout/stow/home/.newrc"
    install untrack "$HOME/.newrc" "$XDG_CONFIG_HOME/newapp/a"
    unchanged 'track then untrack did not restore the original state'
}

command -v stow >/dev/null 2>&1 || { printf 'Missing test dependency: stow\n' >&2; exit 1; }
run_test 'install links leaf packages per file and folds agents' default_install
run_test '--ssh toggles; unknown arguments are refused' flags
run_test '--dry-run reports without changing anything' dry_run
run_test 'renamed sources drop their stale links on rerun' rename_prunes_stale_link
run_test 'files, foreign links, and a real extensions directory are refused' conflicts
run_test 'existing directories are descended, not replaced' coexists_with_real_directories
run_test '--delete removes links and keeps private state' delete
run_test 'track moves a file into its package and links it back' track_moves_and_links
run_test 'track picks xdg, home, or the package already holding the directory' track_chooses_package
run_test 'track of a directory tracks each untracked file in it' track_directory
run_test 'track refuses tracked, foreign, missing, outside, and whole-target paths' track_refusals
run_test 'track moves files back when stow fails or ignores them' track_rolls_back
run_test 'track refuses git-ignored destinations' track_git_ignored
run_test 'untrack replaces links with files and prunes empty directories' untrack_restores
run_test 'untrack refuses anything that is not a stow link' untrack_refusals
run_test 'dry runs change nothing; track then untrack is a round trip' round_trip
printf '\nAll %s stow tests passed (bash %s).\n' "$test_count" "$BASH_VERSION"
