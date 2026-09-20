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
npm --prefix agents/.pi/agent/extensions run verify
```

- Shell suites need Bash 3.2+, Zsh, Git, JJ, Vim, tmux: `brew install zsh git jj vim tmux`.
- Tests isolate `HOME`, config, repositories, and tmux sockets. They do not install plugins or touch live profiles.
- `tests/config.sh` runs `bin/stow` into the isolated `HOME` and tests the resulting symlinks.
- Pi extension setup: [extension README](../agents/.pi/agent/extensions/README.md#development). `bin/check` does not install dependencies.

## Installer API

Source `bin/stow` to use its functions directly:

```sh
. ./bin/stow
stow_link /absolute/source /absolute/destination
```

Selection is validated before any change. Filesystem failures are not rolled back.

## Installer lock

Each mutating `stow_link` holds `stow.tsv.lock` (a directory beside `stow.tsv`) from validation through registry replacement. Contention fails immediately; checks and dry runs take no lock.

A killed process can leave the lock behind. Confirm no installer is running, then `rmdir` the lock directory and rerun. Never delete `stow.tsv`.

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
