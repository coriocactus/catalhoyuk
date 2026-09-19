# Local Pi extensions

- `fullscreen-history`: recent rows first; prepend older batches on reaching the top.
- `tool-display`: grouped tool rows, collapsible output/images, configurable colours.
- `vim-files`: same-terminal filename opening, including while Pi is working.
- `file-tools-shared`: filename and read-only transcript presentation protocols.

Runtime integration is tested against **Pi 0.85.1**. Run `/reload` after changes.

## Development

One package manifest and lockfile here own all development dependencies. No
per-test packages or runtime dependency installation.

Requires Node 22.18+, Pi on `PATH` (or `PI_PACKAGE_DIR`), `/usr/bin/vim`, and native
build tools (Xcode Command Line Tools on macOS). Build `node-pty` from source to
avoid its 1.1.0 macOS prebuilt-helper permissions defect; no permission patches:

```sh
cd ~/.pi/agent/extensions
npm_config_build_from_source=true npm ci
npm run format
npm run verify
```

`verify` runs Biome, strict TypeScript, unit/integration tests, and the terminal
suite. Individual commands: `npm run check`, `npm run typecheck`, `npm test`,
`npm run test:terminal`.

The terminal suite uses **xterm.js (`@xterm/headless`) + Microsoft's `node-pty`**.
It waits for parsed terminal state, targets Unicode cells, checks RGB colours,
and gates background work rather than racing a fixed sleep. Real Pi/Vim run with
isolated settings and an offline fixture provider. Vim syntax stays on; personal
configuration, Ghostty settings, and installed Pi files are untouched.

Coverage includes grouping, errors/diffs/images, clicks/Ctrl+O, background work
while Vim owns the terminal, draft preservation, saves, resizing, reload/resume,
bounded history paging while busy, viewport anchors, archived filenames/images,
unchanged model context, and idle CPU. Image checks cover Kitty commands, not rasterized pixels. Raw
output, cell snapshots, screens, and the saved session remain in the printed
temporary directory for debugging.
