# pi-catalhoyuk

Local TypeScript extensions for the Pi terminal coding agent, installed at `~/.pi/agent/extensions`:

- [`rearview`](rearview/README.md): Renders the most recent transcript rows first and prepends older batches when you scroll to the top.
- [`mirage`](mirage/README.md): Groups consecutive tool rows, including codemode scripts and their nested calls, with collapsible output, image previews, and configurable colours. It changes only how Pi's own tools are drawn and never replaces the tools themselves.
- [`inspector`](inspector/README.md): Opens clicked tool filenames in Vim inside the same terminal, including while Pi is working.
- `interupt`: Requires a second `Esc` press within 1.5 seconds to stop a running response. The first `Esc` arms interruption.
- [`echo`](echo/README.md): Expands `@@name` tokens into Markdown snippets from `~/.pi/agent/echo/*.md` at the editor cursor.
- [`comrade`](comrade/README.md): Provides a tool that delegates a self-contained task to a fresh Pi process and returns its final answer, with live progress and follow-ups that continue the comrade's conversation.
- [`prose`](prose/README.md): Draws Markdown code blocks without fence lines and keeps wrapped lines indented. In fullscreen, every selection stops at the text and starts at a row's content, and a copy joins wrapped rows back into their lines.
- `shared`: Defines the internal filename-opening, read-only transcript presentation, and selection-marker protocols shared across extensions.

## After upgrading Pi

1. Upgrade Pi normally and **restart Pi** (do not just run `/reload`).
2. Run `cd ~/.pi/agent/extensions && npm run pi-diff`. This prints Pi's changelog since the release recorded in `piReviewed` in `package.json`, and then diffs every Pi module imported by the extensions. Review the diff to check whether Pi now provides any extension features natively (prefer native support) and whether a changed module alters behaviour an adapter relies on.
3. Run `npm run verify`.
4. If verification fails, pass the failure output and printed artifact paths to Pi, fix the issue, and rerun `npm run verify`.
5. Run `npm run pi-diff -- --reviewed`, and commit the updated `package.json` together with the `lastChangelogVersion` update that Pi wrote to `settings.json`.

There is no runtime version allowlist or manual approval gate. Adapters verify the APIs they use on load and retain patch-ownership checks: if an adapter detects an internal layout change, it warns and falls back to Pi's native transcript, native image previews, native thinking blocks, or unpadded tool rows, whereas missing entry points or conflicting patches stop only the affected extension from loading. The `piReviewed` field in `package.json` does not block execution. `npm run verify` simply reports at the end whether `piReviewed` matches the installed Pi version.

Because runtime API-shape checks cannot catch every behavioural change, step 2 remains essential. While `npm run verify` exercises the installed Pi package's real CLI, dialogs, and scrolling, it reduces risk rather than guaranteeing compatibility. After upgrading, also test a filename click and transcript scrolling in your real terminal after upgrading.

### What `pi-diff` watches

No list of watched Pi files is maintained by hand. `test/pi-diff.ts` parses every Pi import across the extension source files (excluding tests), including `import type` declarations, and traces Pi's `.d.ts` re-exports, including those across Pi packages, to the specific module that defines each imported symbol. It then diffs both the `.js` and `.d.ts` files of those defining modules and lists any other changed files in the same packages by name. Because strict TypeScript requires any adapter that patches a Pi class or replaces methods on a Pi object to import that class or type, its defining module is watched automatically. To preserve that guarantee, follow two rules when importing from Pi:

- Reach Pi internals only through a symbol imported from a Pi package, never through an untyped object traversal or a direct path into Pi's `dist` directory.
- Import Pi symbols by name from package root entry points. `npm test` rejects namespace, default, side-effect, subpath, and dynamic `import()` forms, as well as any symbol that `pi-diff` cannot trace to a defining module, ensuring upgrade reviews never silently watch less code.

By default, `pi-diff` locates the previous release from Pi's managed installation directory, which retains the release that performed the last update alongside the new one. If that directory is no longer present (for example, after two upgrades without a review) or if Pi is installed as a standard package, `pi-diff` fetches the reviewed release's packages from npm into a temporary directory. You can also run `npm run pi-diff -- <version>` to compare any specific release against the installed one.

## Development

A single `package.json` and lockfile in this directory manage all development dependencies. There are no per-extension packages or runtime dependencies.

Development requires Node 22.19+ (Pi's own minimum, enforced by npm via `devEngines`), Pi on `PATH` (via its managed launcher or a package install) or `PI_PACKAGE_DIR`, `/usr/bin/vim`, and native build tools (Xcode Command Line Tools on macOS). Build `node-pty` from source so that you avoid the macOS prebuilt-helper permissions defect in `node-pty` 1.1.0 without needing post-install permission patches:

```sh
cd ~/.pi/agent/extensions
npm_config_build_from_source=true npm ci
npm run format
npm run verify
```

`npm run verify` runs Biome, strict TypeScript typechecking, unit and integration tests, and the headless terminal suite, then checks whether `piReviewed` matches the installed Pi version. You can also run the individual steps with `npm run check`, `npm run typecheck`, `npm test`, `npm run test:terminal`, and `npm run pi-diff`.

Typechecking covers every extension entry point, test file, and support module with `erasableSyntaxOnly` and `verbatimModuleSyntax` enabled: enums, namespaces, and parameter properties are disallowed, and type-only imports must use `import type`.

Tests are written in TypeScript and executed directly by Node using native type stripping, with no build step:

- `<extension>/tests/*.test.ts`: Unit tests for a single extension. Each suite imports only its own extension, `shared/`, and `test/`, so deleting an extension never breaks another extension's tests (only the cross-extension files in `test/` need updating).
- `<extension>/tests/*.ts` (without `.test`): Shared test fixtures for that extension.
- `test/*.test.ts`: Cross-extension tests covering `shared/` contracts, `mirage` × `rearview` integration, a layout guard verifying that Pi autoloads only the seven extensions (and never `test/` or `shared/`, which must not contain an `index.ts`), and a guard verifying that `pi-diff` can trace every Pi import.
- `test/e2e/`: The end-to-end terminal suite and its offline fixture provider.
- `test/pi.ts`, `test/fake-pi.ts`, `test/transcript.ts`, `test/headless-terminal.ts`: Shared test support. Extension code is loaded through `jiti` against the installed Pi package just as Pi loads it at runtime, and test fakes are typed against Pi's own declarations so that an upstream API rename fails `npm run typecheck` at the fake.

The end-to-end terminal suite spawns Pi's package-declared CLI inside a real pseudo-terminal using **xterm.js (`@xterm/headless`) and Microsoft's `node-pty`**. Instead of relying on fixed sleeps, it waits for parsed terminal state, inspects Unicode cells and RGB colours, and gates background work explicitly. Real Pi and Vim processes run with isolated settings and an offline fixture provider. Vim syntax highlighting stays enabled, and your personal configuration, Ghostty settings, and installed Pi files are never touched.

The terminal suite covers tool grouping, codemode scripts executed by Pi's codemode tool (live nested calls, saved calls after resume, and `store()` entries), live output padding changes, command and script execution durations (both live and resumed), tool errors, diffs, and images, mouse clicks and `Ctrl+O` toggling, background agent work while Vim owns the terminal, newer and replacement editor drafts, editor failures, file saves, terminal resizing, cleanup across `/new`, `/resume`, `/fork`, and `/reload`, disabling history, rapid scrolling between batch prepends and layout passes, bounded history paging, archived filenames and images, unchanged model context, compatibility fallbacks, idle CPU usage, and `echo` snippet autocomplete and insertion without message submission. Image assertions verify emitted Kitty graphics commands rather than rasterized pixels. Raw terminal output, cell snapshots, rendered screens, and saved session files are preserved in the printed temporary directory for debugging.
