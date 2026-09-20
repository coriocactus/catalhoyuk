#!/usr/bin/env bash
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
contains() { grep -F -- "$1" "$output" >/dev/null || fail "missing output: $1"; }
install() { "$BASH" "$checkout/bin/stow" "$@" > "$output" 2>&1 || fail "stow $* failed"; }
reject() { if "$BASH" "$checkout/bin/stow" "$@" > "$output" 2>&1; then fail "stow $* unexpectedly succeeded"; fi; }

setup() {
    case_dir="$scratch/$test_count"
    output="$case_dir/output"
    checkout=$repo_root
    export HOME="$case_dir/home with spaces" XDG_CONFIG_HOME="$case_dir/config 'quoted'"
    export XDG_STATE_HOME="$case_dir/state"
    mkdir -p "$HOME"
}

run_test() {
    local title=$1
    shift
    test_count=$((test_count + 1))
    ( setup; trap 'fail "unexpected failure at line $LINENO"' ERR; "$@" )
    printf 'ok %s - %s\n' "$test_count" "$title"
}

# A trimmed copy of the checkout that can be modified: the Pi extension tree is replaced by a stub.
copy_checkout() {
    checkout="$case_dir/checkout with spaces"
    mkdir -p "$checkout/bin" "$checkout/stow/agents/.agents/skills" "$checkout/stow/agents/.pi/agent/extensions"
    cp "$repo_root/bin/stow" "$checkout/bin/"
    cp -R "$repo_root/stow/home" "$repo_root/stow/xdg" "$repo_root/stow/vim-ssh" "$repo_root"/stow/tmux-* "$checkout/stow/"
    cp "$repo_root/stow/agents/.pi/agent/"{settings,advisor}.json "$checkout/stow/agents/.pi/agent/"
    printf 'stub\n' > "$checkout/stow/agents/.pi/agent/extensions/index.ts"
    printf '{}\n' > "$checkout/stow/agents/skills-lock.json"
}

# Every regular file in a leaf package must be linked at the same relative path.
package_linked() {
    local package=$1 target=$2 file
    while IFS= read -r file; do
        linked "$target/${file#"$checkout/stow/$package/"}" "$file"
    done < <(find "$checkout/stow/$package" -type f -not -name identities.example)
}

default_install() {
    install
    package_linked home "$HOME"
    package_linked xdg "$XDG_CONFIG_HOME"
    linked "$HOME/.tmux.conf" "$checkout/stow/tmux-green/.tmux.conf"
    linked "$HOME/.agents" "$checkout/stow/agents/.agents"
    linked "$HOME/.pi/agent/settings.json" "$checkout/stow/agents/.pi/agent/settings.json"
    linked "$HOME/.pi/agent/advisor.json" "$checkout/stow/agents/.pi/agent/advisor.json"
    linked "$HOME/.pi/agent/extensions" "$checkout/stow/agents/.pi/agent/extensions"
    [ -d "$HOME/.pi/agent" ] && [ ! -L "$HOME/.pi" ] && [ ! -L "$HOME/.pi/agent" ] || fail '~/.pi must stay a real directory'
    [ -d "$HOME/.local/bin" ] && [ ! -L "$HOME/.local/bin" ] || fail '~/.local/bin must stay a real directory'
    absent "$HOME/.vimrc-ssh"
    absent "$HOME/skills-lock.json"
    absent "$XDG_CONFIG_HOME/repo4/identities.example"
    absent "$XDG_STATE_HOME"
}

flags() {
    install --ssh --tmux blue
    linked "$HOME/.vimrc-ssh" "$checkout/stow/vim-ssh/.vimrc-ssh"
    linked "$HOME/.tmux.conf" "$checkout/stow/tmux-blue/.tmux.conf"
    install
    absent "$HOME/.vimrc-ssh"
    linked "$HOME/.tmux.conf" "$checkout/stow/tmux-green/.tmux.conf"
    reject --tmux purple
    contains 'tmux-*'
    reject --tmux
    reject --bogus
    linked "$HOME/.tmux.conf" "$checkout/stow/tmux-green/.tmux.conf"
}

dry_run() {
    install --dry-run --ssh
    contains 'LINK: .vimrc-ssh'
    absent "$HOME/.vimrc"
    absent "$HOME/.pi"
    absent "$XDG_CONFIG_HOME"
    install --tmux red
    install --dry-run
    contains 'tmux-green/.tmux.conf'
    linked "$HOME/.tmux.conf" "$checkout/stow/tmux-red/.tmux.conf"
}

rename_prunes_stale_link() {
    copy_checkout
    install
    mv "$checkout/stow/home/.ripgreprc" "$checkout/stow/home/.rgrc"
    mv "$checkout/stow/xdg/hunk/config.toml" "$checkout/stow/xdg/hunk/other.toml"
    install
    absent "$HOME/.ripgreprc"
    absent "$XDG_CONFIG_HOME/hunk/config.toml"
    linked "$HOME/.rgrc" "$checkout/stow/home/.rgrc"
    linked "$XDG_CONFIG_HOME/hunk/other.toml" "$checkout/stow/xdg/hunk/other.toml"
}

conflicts() {
    printf 'mine\n' > "$HOME/.zshrc"
    reject
    contains 'conflict'
    [ "$(cat "$HOME/.zshrc")" = mine ] || fail 'existing file was replaced'
    rm "$HOME/.zshrc"
    ln -s /etc/hosts "$HOME/.vimrc"
    reject
    [ "$(readlink "$HOME/.vimrc")" = /etc/hosts ] || fail 'foreign symlink was replaced'
    rm "$HOME/.vimrc"
    mkdir -p "$HOME/.pi/agent/extensions"
    reject
    contains 'move aside'
    absent "$HOME/.zshrc"
}

coexists_with_real_directories() {
    mkdir -p "$HOME/.agents/skills/own" "$HOME/.pi/agent/sessions"
    printf 'mine\n' > "$HOME/.agents/skills/own/SKILL.md"
    install
    [ ! -L "$HOME/.agents" ] || fail 'existing ~/.agents was replaced by a link'
    [ -f "$HOME/.agents/skills/own/SKILL.md" ] || fail 'own skill was removed'
    linked "$HOME/.agents/skills/postgres" "$checkout/stow/agents/.agents/skills/postgres"
    [ -d "$HOME/.pi/agent/sessions" ] || fail 'Pi state was removed'
}

delete() {
    install --ssh --tmux red --repo4
    mkdir -p "$HOME/.pi/agent/sessions"
    install --delete
    absent "$HOME/.zshrc"
    absent "$HOME/.tmux.conf"
    absent "$HOME/.vimrc-ssh"
    absent "$HOME/.agents"
    absent "$HOME/.pi/agent/settings.json"
    absent "$HOME/.pi/agent/advisor.json"
    absent "$XDG_CONFIG_HOME/tmux/common.conf"
    [ -f "$XDG_CONFIG_HOME/repo4/identities.conf" ] || fail 'private profiles were removed'
    [ -d "$HOME/.pi/agent/sessions" ] || fail 'Pi state was removed'
}

for tool in stow zsh; do
    command -v "$tool" >/dev/null 2>&1 || { printf 'Missing test dependency: %s\n' "$tool" >&2; exit 1; }
done
run_test 'default install links every package file' default_install
run_test '--ssh and --tmux toggle; unselected packages are removed' flags
run_test '--dry-run reports without changing anything' dry_run
run_test 'renamed sources drop their stale links on rerun' rename_prunes_stale_link
run_test 'files, foreign links, and a real extensions directory are refused' conflicts
run_test 'existing directories are descended, not replaced' coexists_with_real_directories
run_test '--delete removes links and keeps private state' delete
printf '\nAll %s stow tests passed (bash %s).\n' "$test_count" "$BASH_VERSION"
