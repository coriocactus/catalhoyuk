# Development

## Tests

```sh
./bin/check          # stow, repo4, config, Pi extension
./bin/check --shell  # stow, repo4, config
```

Individual suites:

```sh
bash tests/stow.sh
zsh -f tests/repo4.zsh
bash tests/config.sh
npm --prefix stow/agents/.pi/agent/extensions run verify
```

- Shell suites need Bash 3.2+, Stow, Zsh, Git, JJ, Vim, tmux: `brew install stow zsh git jj vim tmux`.
- Tests isolate `HOME`, config, repositories, and tmux sockets. They do not install plugins or touch live profiles.
- `tests/stow.sh` and `tests/config.sh` run `bin/stow` into the isolated `HOME` and test the result.
- Pi extension setup: [extension README](../stow/agents/.pi/agent/extensions/README.md#development). `bin/check` does not install dependencies.

## Installer

`bin/stow` runs `stow -d stow -t TARGET` per package, always with `-v`, and `-n` for `--dry-run`.

- `home` and `xdg` use `--no-folding`: real directories, one link per file.
- `agents` folds: `~/.agents` and `~/.pi/agent/extensions` become directory links. `~/.pi/agent` is created first so Pi's own state stays out of the checkout. A real `~/.pi/agent/extensions` directory is refused.
- Unselected `tmux-*` and `vim-ssh` packages are unstowed on every run.
- `--ignore` keeps `skills-lock.json` and `identities.example` out of the targets.
- `--repo4` preflights `repo4 init` before linking and runs it after.

Each `stow` invocation checks all its conflicts before changing anything, but the run as a whole is not a transaction.

### Renaming and removing files

Rerun `./bin/stow`. Stow removes dangling links it owns in directories the package still contains.

It does not visit directories the package no longer has, and it refuses links into a moved checkout as "not owned by stow". Either run `./bin/stow --delete` before restructuring or moving, or remove the dangling links afterwards with the `find` command in the [README](../README.md#layout). `--delete` leaves empty directories behind.

## Configuration notes

### Tmux

- Profiles hold colours and an include of `~/.config/tmux/common.conf`.
- `brew-zsh.sh` picks Homebrew Zsh via `brew --prefix`, else `$HOMEBREW_PREFIX`, `/opt/homebrew`, `/home/linuxbrew/.linuxbrew`, `/usr/local`. Falls back to tmux's default shell.
- Applies to new panes only.

### Vim

- Startup never downloads anything.
- `:BootstrapPlugins` fetches vim-plug 0.14.0 if absent, then runs `PlugInstall --sync`. Restart Vim after.
- `:PlugUpdate` updates plugins.

### JJ

- `jj prek [HOOK] [OPTIONS]` runs hooks on files changed in `@-`, using working-copy contents.
- Fixes land in `@`; review and `jj squash` manually. `@-` is never rewritten.
- Deleted files and empty selections are skipped. Prek's Git repository requirements still apply.

### Zsh

- `$BRANCH`: current Git branch. `$BOOKMARK`: nearest local JJ bookmark. Both refresh before each prompt and on `cd`; empty outside a repository.
- PATH and completion directories are set before integrations. Reloading `.zshrc` keeps entries unique.
