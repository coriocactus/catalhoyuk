# catalhoyuk

Personal dotfiles and [Pi agent extensions](stow/agents/.pi/agent/extensions/README.md), installed into `$HOME` and `$XDG_CONFIG_HOME` with [GNU Stow](https://www.gnu.org/software/stow/).

## Install

```sh
brew install stow
./bin/stow             # home + XDG configs
./bin/stow --repo4     # also repo4 identity profiles
./bin/stow --dry-run   # report only
./bin/stow --delete    # remove all links
```

After running the installer, start a new shell to load the Zsh configuration. To install Vim plugins, open Vim, run `:BootstrapPlugins`, and restart Vim.

## Layout

| Path | Contents |
| --- | --- |
| `bin/stow` | Installer wrapper around GNU `stow` |
| `bin/check` | Test runner for shell suites and Pi extensions |
| `stow/` | Stow packages, each mirroring its target directory |
| `manual/` | Configurations applied by hand (crontab and Rectangle export) |
| `tests/` | Shell test suites |
| `Brewfile` | Homebrew package manifest |

Each directory under `stow/` is a Stow package:

| Package | Target | Notes |
| --- | --- | --- |
| `home` | `~` | Creates real directories and symlinks individual leaf files |
| `xdg` | `~/.config` | Creates real directories and symlinks individual leaf files, except `repo4/identities.example` |
| `agents` | `~` | Symlinks `.agents` and `.pi/agent/extensions` as directories |

Stow never replaces existing regular files or foreign symlinks. If a target path is already occupied, it stops and reports a conflict.

Rerunning `./bin/stow` also prunes dangling symlinks that Stow owns, except inside directories that a package no longer contains or for symlinks created by an older layout of this repository. To list every dangling symlink pointing into the checkout (drop `-print`, add `-delete` to remove them, and then rerun `./bin/stow`):

```sh
find ~ -maxdepth 3 -type l -lname '*/catalhoyuk/*' ! -exec test -e {} \; -print 2>/dev/null
```

## Tracking files

Use `./bin/stow track` to move an existing file or directory into the checkout and replace it with a symlink, or `./bin/stow untrack` to move a tracked item back to its target location:

```sh
./bin/stow track ~/.some-file        # move into the checkout, link back
./bin/stow track ~/.config/app       # a directory moves as one unit
./bin/stow untrack ~/.some-file      # replace the link with the file again
./bin/stow --dry-run track ~/.x      # report only
```

When tracking a path, `bin/stow` selects the destination package automatically: paths under `$XDG_CONFIG_HOME` go to `xdg`, paths elsewhere under `$HOME` go to whichever package already holds the deepest matching parent directory (such as `agents` for `~/.pi/agent/…`), and everything else goes to `home`. A tracked directory then takes the linking shape of its package: `agents` links the directory itself so any files written there later live directly in the checkout, whereas `home` and `xdg` recreate the directory in the target and link each file individually.

`track` refuses symlinks, git-ignored destinations, filenames on Stow's ignore list, and directories that are already partly in the checkout. If Stow fails while linking, `bin/stow` moves every item back to its original path. Once a file is tracked, commit it as usual.

You can also add a file manually by placing it in a package at its target-relative path and rerunning `./bin/stow`.

## Node, Bun, Yarn

Homebrew provides the global `node`, `npm`, `bun`, and `yarn` binaries, and global npm CLIs are installed from `~` using Homebrew's `npm`. Per-project versions are managed by [mise](https://mise.jdx.dev): Zsh activates `mise` on startup, and changing directories with `cd` selects the version declared by the project or falls back to the Homebrew binaries elsewhere.

The configuration in `stow/xdg/mise/config.toml` pins nothing globally. It only enables reading idiomatic version files for Node, Bun, and Yarn (`.nvmrc`, `.node-version`, `.bun-version`, `.yvmrc`, and `package.json` `devEngines` and `packageManager`), in addition to `mise.toml` and `.tool-versions`, which always apply.

```sh
mise install                    # install what the project declares
mise use --pin node@24 yarn@1   # declare versions in a project
mise exec -- COMMAND            # non-interactive shells
```

Pi needs Node.js 22.19 or newer, so Zsh aliases `pi` to run with Homebrew's Node first on `PATH`. This covers `pi update` and `pi install`, and commands Pi runs inherit Homebrew's Node too, so use `mise exec --` there when a project's version matters.

`mise` ignores the `engines` field in `package.json` because it expresses a compatibility range rather than a concrete version to develop with. In projects that only declare `engines`, run `mise use node@24` to write a `mise.toml`.

## repo4

`repo4` is a repository identity switcher for Git and Jujutsu (JJ). It requires Zsh and Git, plus JJ when run in a JJ repository.

```sh
./bin/stow --repo4   # links helper, creates profiles if absent
exec zsh
repo4 self           # or: repo4 work
```

Identity profiles live in `~/.config/repo4/identities.conf` (created with mode `600`). The `self` profile is prefilled from the template. Fill in the `work` profile before using `repo4 work`.

Running `repo4 self` or `repo4 work` configures `user.name` and `user.email` locally in the current repository for Git and, if applicable, JJ. There is no global Git identity. In a JJ repository, `repo4` also repairs the author of the working-copy commit `@`, which requires `@` to be a mutable leaf commit. Git `HEAD` is never amended.

## Development

```sh
./bin/check          # all suites
./bin/check --shell  # skip Pi extension verification
```

See [docs/development.md](docs/development.md) for test prerequisites, installer internals, and configuration notes.
