# pi-catalhoyuk

- `rearview`: recent rows first; prepend older batches on reaching the top.
- `mirage`: grouped tool rows, collapsible output/images, configurable colours.
- `inspector`: same-terminal filename opening, including while Pi is working.
- `shared`: filename and read-only transcript presentation protocols.

## After upgrading Pi

1. Upgrade normally and **restart Pi** (not just `/reload`).
2. Run `cd ~/.pi/agent/extensions && npm run verify`.
3. If it fails, give Pi the failure output and printed artifact paths, fix it, and rerun.

There is no version allowlist or approval step. Adapters check the APIs they use
and retain patch-ownership checks. Detected layout changes fall back to the native
transcript/previews or unpadded tool rows with a warning; missing entry points or
patch conflicts stop the affected extension from loading.

API shape checks cannot detect every behavioral change. Verification exercises the
installed package's real CLI, dialogs and scrolling; it reduces risk but is not a guarantee.
Also try a filename click and scrolling in your actual terminal after upgrading.

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

The terminal suite launches Pi's package-declared CLI with
**xterm.js (`@xterm/headless`) + Microsoft's `node-pty`**.
It waits for parsed terminal state, targets Unicode cells, checks RGB colours,
and gates background work rather than racing a fixed sleep. Real Pi/Vim run with
isolated settings and an offline fixture provider. Vim syntax stays on; personal
configuration, Ghostty settings, and installed Pi files are untouched.

Coverage includes grouping, live output padding, errors/diffs/images, clicks/Ctrl+O,
background work while Vim owns the terminal, newer/replacement drafts, editor failures,
saves, resizing, new/resume/fork/reload cleanup, disabling history, rapid scrolling
between prepend and layout, bounded paging, archived filenames/images, unchanged model
context, compatibility fallbacks, and idle CPU. Image checks cover Kitty commands,
not rasterized pixels. Raw output, cell snapshots, screens, and saved sessions remain
in the printed temporary directory for debugging.
