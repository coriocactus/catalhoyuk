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

- Shell suites need Bash 3.2+, Stow, Zsh, Git, JJ, prek, Vim, tmux: `brew install stow zsh git jj prek vim tmux`.
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

- Plain `jj prek` runs `pre-commit` on files changed in `@-`, then `commit-msg` on its description. Only after both succeed is the resulting description applied to `@-`; repository hooks own message validation and trailers.
- Full runs require a described `@-`, an empty, conflict-free `@` with one parent, and a colocated `.git` directory. `SKIP` and `PREK_SKIP` must be unset. Hooks changing files or concurrent JJ rewrites stop the run without applying the message.
- Fixes land in `@`; review, `jj squash`, and rerun. Rerun after changing previously checked content; trailers are not automatically revoked by JJ edits.
- Any arguments (`jj prek ruff`, `jj prek --verbose`, `jj prek --dry-run`) mean checks only: use working-copy contents without rewriting `@-` or requiring an empty `@`.
- Deleted files are excluded. An empty selection skips check-only runs, but full runs still execute `always_run` and message hooks.
- Message files live temporarily under `.git` so Docker hooks can access them. Real prek tests use local shell hooks, without Docker or network access.

### Zsh

- `$BRANCH`: current Git branch. `$BOOKMARK`: nearest local JJ bookmark. Both refresh before each prompt and on `cd`; empty outside a repository.
- PATH and completion directories are set before integrations. Reloading `.zshrc` keeps entries unique.
