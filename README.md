# catalhoyuk

Dotfiles. Bash 3.2+ and standard macOS/Linux utilities.

```sh
./stow.sh                       # home + XDG configs; green tmux
./stow.sh --ssh --tmux blue     # also SSH vim; blue tmux
./stow.sh --dry-run             # no filesystem or state changes
```

## Mappings

`stow_mappings` in `stow.sh` contains ordered destination/source pairs:
- `home`: destinations under `$HOME`.
- `xdg_config_home`: under `${XDG_CONFIG_HOME:-$HOME/.config}`.
- Sources are repository-relative; `--tmux NAME` selects `config/tmux-NAME.conf`.

Move a source, update its array entry, rerun. Unselected links remain untouched.
Matching links are adopted; recorded links can be retargeted even when broken.
Files, directories, and unrelated or manually changed links are refused.
The selection is checked first; filesystem failures are not rolled back.
Ownership: `${XDG_STATE_HOME:-$HOME/.local/state}/catalhoyuk/stow.tsv`.
Keep it, and register existing links before moving sources.

## Development

```sh
source ./stow.sh
stow_link /absolute/source /absolute/destination
bash tests/stow.sh
```

## repo4

Repository identities. Requires zsh and Git, plus JJ in JJ repositories.
Helper and template live in `repo4/`; only the helper is stowed.

```sh
./stow.sh --repo4   # install links and run repo4 init; never overwrites profiles
repo4 self          # or: repo4 work; select per repository
```

Profiles are a private mode-600 copy. `self` is prefilled; edit the blank `work` fields.
Git has no global identity default. Selections configure Git and JJ locally.
JJ author repair requires a mutable leaf `@`; Git HEAD is never amended.
Identity overrides are refused; cross-tool write failures may leave partial settings.
Tests: `zsh -f tests/repo4.zsh`.
