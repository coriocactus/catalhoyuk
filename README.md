# catalhoyuk

Dotfiles, installed with [GNU Stow](https://www.gnu.org/software/stow/).

## Install

```sh
brew install stow
./bin/stow                    # home + XDG configs, green tmux
./bin/stow --ssh --tmux blue  # also SSH vimrc, blue tmux
./bin/stow --repo4            # also repo4 identity profiles
./bin/stow --dry-run          # report only
./bin/stow --delete           # remove all links
```

Rerunning applies the current flags: a profile or `--ssh` you drop is unlinked.
Then start a new shell. Run `:BootstrapPlugins` in Vim to install plugins, then restart Vim.

## Layout

| Path | Contents |
| --- | --- |
| `bin/stow` | Installer wrapper around `stow` |
| `bin/check` | Test runner |
| `stow/` | Packages; each mirrors its target directory |
| `manual/` | Applied by hand: crontab, Rectangle export |
| `tests/` | Shell test suites |
| `Brewfile` | Homebrew packages |

Packages:

| Package | Target | Notes |
| --- | --- | --- |
| `home` | `~` | Leaf files linked; directories created |
| `xdg` | `~/.config` | Same; `repo4/identities.example` is not linked |
| `agents` | `~` | `.agents` and `.pi/agent/extensions` linked as directories |
| `tmux-*` | `~` | One selected by `--tmux`; profiles differ only in colour |
| `vim-ssh` | `~` | Selected by `--ssh` |

To add a file, place it in a package at its home-relative path and rerun.
Existing files and foreign symlinks are never replaced; Stow reports a conflict.

Rerunning also removes dangling links, except in directories a package no longer has
or links made by an older layout of this repository. To find every dangling link into
the checkout (drop `-print`, add `-delete` to remove, then rerun `./bin/stow`):

```sh
find ~ -maxdepth 3 -type l -lname '*/catalhoyuk/*' ! -exec test -e {} \; -print 2>/dev/null
```

## Node, Bun, Yarn

Homebrew provides the global `node`, `npm`, `bun`, and `yarn`; global npm CLIs
are installed from `~` with Homebrew's npm. [mise](https://mise.jdx.dev) overrides
them per project: Zsh activates it, and on `cd` it selects the version the project
declares, falling back to Homebrew elsewhere. `stow/xdg/mise/config.toml` pins
nothing globally; it only lets Node, Bun, and Yarn read `.nvmrc`, `.node-version`,
`.bun-version`, `.yvmrc`, and `package.json` (`devEngines`, `packageManager`).
`mise.toml` and `.tool-versions` always apply.

```sh
mise install                    # install what the project declares
mise use --pin node@24 yarn@1   # declare versions in a project
mise exec -- COMMAND            # non-interactive shells
```

mise ignores `engines` in `package.json`: it is a compatibility range, not a
version to develop with. In such a project, `mise use node@24` writes a `mise.toml`.

## repo4

Repository identity switcher for Git and JJ. Requires Zsh and Git; JJ for JJ repositories.

```sh
./bin/stow --repo4   # links helper, creates profiles if absent
exec zsh
repo4 self           # or: repo4 work
```

- Profiles: `~/.config/repo4/identities.conf` (mode 600). `self` is prefilled; fill in `work`.
- Selection sets Git and JJ identity locally in the current repository. There is no global Git identity.
- JJ author repair needs a mutable leaf `@`. Git HEAD is never amended.

## Development

```sh
./bin/check          # all suites
./bin/check --shell  # skip Pi extension verification
```

Details in [docs/development.md](docs/development.md).
