# catalhoyuk

Dotfiles. Requires Bash 3.2+ and standard macOS/Linux utilities.

## Install

```sh
./bin/stow                    # home + XDG configs, green tmux
./bin/stow --ssh --tmux blue  # also SSH vimrc, blue tmux
./bin/stow --repo4            # also repo4 identity profiles
./bin/stow --dry-run          # report only
```

Then start a new shell. Run `:BootstrapPlugins` in Vim to install plugins, then restart Vim.

## Layout

| Path | Contents |
| --- | --- |
| `bin/stow` | Installer; `stow_mappings` lists destination/source pairs |
| `bin/check` | Test runner |
| `config/` | Shell, editor, tmux, git, jj, and tool configs |
| `config/bin/jj-prek` | `jj prek` helper, installed to `~/.local/bin` |
| `repo4/` | Repository identity switcher for Git and JJ |
| `agents/` | Agent skills and Pi settings/extensions |
| `tests/` | Shell test suites |
| `Brewfile` | Homebrew packages |

## Stow

- Mappings live in `stow_mappings` in `bin/stow`. To move a file: move the source, update the pair, rerun.
- `--tmux NAME` selects `config/tmux-NAME.conf`. Profiles differ only in colour.
- Ownership is recorded in `${XDG_STATE_HOME:-~/.local/state}/catalhoyuk/stow.tsv`. Keep it.
- Matching links are adopted; recorded links are retargeted. Files, directories, and foreign links are refused.
- Concurrent runs are refused; see [lock recovery](docs/development.md#installer-lock).

## repo4

Requires Zsh and Git; JJ for JJ repositories.

```sh
./bin/stow --repo4   # links helper, creates profiles if absent
exec zsh
repo4 self           # or: repo4 work
```

- Profiles: `${XDG_CONFIG_HOME:-~/.config}/repo4/identities.conf` (mode 600). `self` is prefilled; fill in `work`.
- Selection sets Git and JJ identity locally in the current repository. There is no global Git identity.
- JJ author repair needs a mutable leaf `@`. Git HEAD is never amended.

## Development

```sh
./bin/check          # all suites
./bin/check --shell  # skip Pi extension verification
```

Details in [docs/development.md](docs/development.md).
