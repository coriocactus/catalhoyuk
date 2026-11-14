# Development

This document covers how to run the repository's test suites, how the `bin/stow` wrapper manages symlinks, and how the individual tool configurations work.

## Tests

Run `bin/check` to execute the full test suite, or pass `--shell` to skip the Pi extension verification:

```sh
bin/check          # stow, repo4, config, Pi extension
bin/check --shell  # stow, repo4, config
```

You can also run each suite individually:

```sh
bash tests/stow.sh
zsh -f tests/repo4.zsh
bash tests/config.sh
npm --prefix stow/agents/.pi/agent/extensions run verify
```

The shell suites require Bash 3.2+, GNU Stow, Zsh, Git, JJ, `prek`, Vim, and `tmux` (`brew install stow zsh git jj prek vim tmux`). For the Pi extension suite's prerequisites and setup, see the [extension README](../stow/agents/.pi/agent/extensions/README.md#development). Note that `bin/check` does not install npm dependencies.

All tests run in isolated environments with their own temporary `HOME`, configuration directories, repositories, and `tmux` sockets, so they never install plugins or touch live user profiles:

- `tests/stow.sh` exercises the installer mechanics (linking, directory folding, conflict detection, pruning, `track`, and `untrack`) against a synthetic checkout, so adding or removing actual dotfiles never breaks the installer tests.
- `tests/config.sh` installs the repository's real Stow packages into the isolated `HOME` and verifies the configurations themselves.
- `tests/repo4.zsh` tests profile initialization and repository identity switching in Zsh.

## Installer

`bin/stow` runs `stow -d stow -t TARGET` once per package. It always passes `-v`, and adds `-n` when invoked with `--dry-run`. Each `stow` invocation checks all of its own conflicts before changing the filesystem, though a multi-package run as a whole is not a single transaction.

Packages are linked according to their role:

- `home` and `xdg` run with `--no-folding`, creating real directories in the target and one symlink per leaf file. When stowing `xdg`, `--ignore` excludes `identities.example` from the target.
- `agents` uses Stow's directory folding so that `~/.agents` and `~/.pi/agent/extensions` become directory symlinks (which also installs `agents/.agents/.skill-lock.json` at `$HOME/.agents/.skill-lock.json`). Before running Stow, `bin/stow` creates `~/.pi/agent` as a real directory so Pi's runtime state stays out of the checkout, and refuses to proceed if `~/.pi/agent/extensions` already exists as a real directory.
- Passing `--repo4` runs a preflight check of `repo4 init` before linking and runs the initialization itself after linking succeeds.

### track and untrack

`bin/stow track` and `bin/stow untrack` validate all supplied paths as a batch before moving anything. If any path in the batch is invalid, the entire command aborts without making changes. Paths in a single batch may not repeat or nest inside one another.

`track` moves each file or directory to `stow/PACKAGE/RELATIVE-PATH` and then runs `stow -S` for the affected packages. If Stow fails, every item in the batch is moved back to its original path. If Stow silently skips an item because its filename matches Stow's default ignore list (for example, a root `README.*`), `bin/stow` moves that item back and prints a warning. When tracking a directory, `bin/stow` treats it as a single unit without inspecting its contents: symlinks inside the directory move as-is (so relative symlinks pointing outside the directory will break), and git-ignored files inside it move along and remain uncommitted. If the destination directory already exists in the package, `track` refuses the path rather than merging directories.

`untrack` accepts either a symlink at the exact path Stow creates (including folded directory symlinks such as `~/.agents`) or a real directory containing nothing but such symlinks, which is what a `--no-folding` package produces. It removes the symlinks, moves the tracked file or directory back to its target path, and prunes any directories left empty in the package.

### Renaming and removing files

After renaming or deleting a file in a package, rerun `bin/stow`. Stow automatically removes dangling symlinks that it owns inside directories the package still contains.

Stow does not visit directories that have been completely removed from a package, and if you move the repository checkout to a new path, Stow refuses existing symlinks into the old path as "not owned by stow". Before restructuring a package or moving the checkout, run `bin/stow --delete` (which removes the symlinks and leaves empty directories behind), or clean up the dangling symlinks afterwards with the `find` command in the [README](../README.md#layout).

## Configuration notes

### Tmux

The `home` package provides `~/.tmux.conf`, which uses `run-shell` to execute `$XDG_CONFIG_HOME/tmux/brew-zsh.sh` (defaulting to `~/.config/tmux/brew-zsh.sh`). That script selects Homebrew's Zsh by checking `brew --prefix`, `$HOMEBREW_PREFIX`, `/opt/homebrew`, `/home/linuxbrew/.linuxbrew`, and `/usr/local` in order, falling back to `tmux`'s default shell if none of those contain `zsh`. Changes apply to newly opened panes only.

### Vim

Vim never downloads anything automatically on startup. Running `:BootstrapPlugins` downloads `vim-plug` `0.14.0` if it is not already installed and then runs `PlugInstall --sync`. Restart Vim afterwards. Run `:PlugUpdate` to update installed plugins.

`<leader>y` yanks to the system clipboard (`"+`). Over SSH (`$SSH_CONNECTION` is set), or in a Vim built without clipboard support, it yanks through `vim-oscyank` instead, which sends the text to the local terminal with OSC 52. This needs a terminal that accepts OSC 52 and, inside `tmux`, the `set-clipboard on` setting in `~/.tmux.conf`. `<leader>d` and `<leader>p` always use `"+`.

### JJ

Running `jj prek` with no arguments executes `pre-commit` hooks on the files changed in `@-` and then runs `commit-msg` hooks on `@-`'s description. Only after both stages succeed is the resulting description written back to `@-`, leaving message validation and commit trailers to the repository's hooks.

A full `jj prek` run requires a non-empty description on `@-`, an empty and conflict-free working copy `@` with a single parent, and a colocated `.git` directory. Both `SKIP` and `PREK_SKIP` must be unset. If a hook modifies files in the working copy or a concurrent JJ operation rewrites `@`, the run stops without applying the updated commit message. Any automatic fixes made by hooks land in `@`: review them, run `jj squash`, and rerun `jj prek`. Because JJ edits do not automatically revoke trailers in commit descriptions, rerun `jj prek` whenever you modify previously checked content.

Passing any arguments (such as `jj prek ruff`, `jj prek --verbose`, or `jj prek --dry-run`) runs in check-only mode against the working-copy contents without rewriting `@-` or requiring `@` to be empty. Deleted files are always excluded. If no changed files remain, check-only runs exit early, whereas full runs still execute `always_run` and `commit-msg` hooks.

Temporary commit-message files are created under `.git` so that Docker-based hooks (which mount the repository rather than the host's temporary directory) can read and edit them. The repository's own `prek` tests use local shell hooks and require neither Docker nor network access.

### Zsh

The shell sets `$BRANCH` to the current Git branch and `$BOOKMARK` to the nearest local JJ bookmark, refreshing both before each prompt and on `cd` (outside a repository, both variables are empty). `PATH` and completion directories are configured before tool integrations load, and reloading `.zshrc` deduplicates path entries.
