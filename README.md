# catalhoyuk

Dotfiles. Requires Bash 3.2+ and standard macOS/Linux utilities.

```sh
./stow.sh                     # home + XDG configs; green tmux
./stow.sh --ssh --tmux blue   # home + XDG configs; blue tmux; ssh vim
./stow.sh --dry-run           # no filesystem or state changes
```

## Mapping

`stow_mappings` in `stow.sh` contains ordered destination/source pairs:

- `home`: destinations under `$HOME`.
- `xdg_config_home`: under `${XDG_CONFIG_HOME:-$HOME/.config}`.
- Sources are relative to the repository root.
- `--ssh` adds `.vimrc-ssh`; `--tmux NAME` selects `config/tmux-NAME.conf` (default: `green`).

Move a source, update its array entry, rerun. Unselected links remain untouched.
`stow_register` queues pairs; all validation finishes before `stow_link` applies them.

## Ownership

Existing matching links are adopted. Recorded links are retargeted, even when
broken. Files, directories, and unrelated or manually changed links are refused.
The entire selection is checked before applying; filesystem failures are not rolled back.

State: `${XDG_STATE_HOME:-$HOME/.local/state}/catalhoyuk/stow.tsv`.
Keep it, and register existing links with a normal run before moving sources.

## Development

```sh
source ./stow.sh
stow_link /absolute/source /absolute/destination
bash tests/stow.sh
```
