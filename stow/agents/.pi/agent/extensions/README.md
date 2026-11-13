# pi-catalhoyuk

Seven local TypeScript extensions for the Pi terminal coding agent, installed at `~/.pi/agent/extensions`. [`GLOSSARY.md`](GLOSSARY.md) defines the terms their code and docs use.

- [`rearview`](rearview/README.md) starts the fullscreen transcript with its most recent entries and adds older pages above them as you scroll to the top.
- [`mirage`](mirage/README.md) draws Pi's `read`, `bash`, `edit`, `write`, and `codemode` calls as compact rows, and consecutive calls as one group with collapsible output, image previews, and its own colours. It only draws these tools: Pi still runs them.
- [`inspector`](inspector/README.md) opens a tool row's filename in your editor, in the same terminal, when you click it, also while Pi works.
- [`interupt`](interupt/README.md) makes `Esc` stop a running response only on its second press within 1.5 seconds.
- [`echo`](echo/README.md) expands an `@@name` token at the editor cursor into the Markdown snippet `~/.pi/agent/echo/name.md`.
- [`comrade`](comrade/README.md) adds a tool that hands a self-contained task to a fresh Pi process and returns its answer. A comrade shows its progress while it works, keeps its conversation for follow-ups, takes messages while it runs, and can run in the background, where it carries on after Pi exits.
- [`prose`](prose/README.md) draws Markdown code blocks without fence lines and keeps wrapped lines indented. In fullscreen mode, a selection ends at each line's text and starts at its content, and a copy joins wrapped lines back together.
- `shared` holds what the extensions have in common: the protocols they meet through (opening a file, read-only transcripts, nested rows, selection markers) and the helpers they would otherwise each copy (patching Pi's methods, the spinner, colours, formatting). Pi loads a separate copy of `shared` for each extension, so its modules keep no state of their own: what two extensions share lives under a global symbol or on the object they both reach.

## After upgrading Pi

1. Upgrade Pi and **restart Pi**. `/reload` is not enough.
2. Run `cd ~/.pi/agent/extensions && npm run pi-diff`. It prints Pi's changelog since the release recorded as `piReviewed` in `package.json`, then the diff of every Pi module the extensions import. Read it for two things: a feature Pi now has natively, which is better than an extension's, and a change to behaviour an adapter relies on.
3. Run `npm run verify`.
4. If it fails, give Pi the failure output and the artifact paths it printed, fix the cause, and run `npm run verify` again.
5. Run `npm run pi-diff -- --reviewed`. Commit the changed `package.json` together with the `lastChangelogVersion` that Pi wrote to `settings.json`.

Nothing at runtime blocks a Pi version, and `piReviewed` blocks nothing either: `npm run verify` only reports at its end whether it matches the installed Pi. Each adapter protects itself instead, in two steps:

- When its extension loads, an adapter replaces Pi's methods through `shared/patch.ts`. If Pi lacks one of those methods, or another extension has replaced the adapter's, that extension does not load. The other extensions are unaffected.
- When Pi calls a replaced method, the adapter checks the rest of what it reads from Pi. If that has changed, the adapter warns once and Pi's own behaviour stays: the native transcript (`rearview`), native image previews and native thinking blocks (`mirage`), or native Markdown, text, or selection (`prose`, which runs its checks as it loads). Without `outputPad` in Pi's render context, `mirage` draws its rows unpadded.

These checks see the shape of Pi's API, not every change in its behaviour, so step 2 cannot be skipped. `npm run verify` runs the installed Pi's real CLI, dialogs, and scrolling, which lowers the risk without removing it. After an upgrade, also click a filename and scroll the transcript in your own terminal.

### What `pi-diff` watches

No list of Pi files is kept by hand. `test/pi-diff.ts` reads every Pi import in extension code (tests excluded, `import type` included) and follows Pi's `.d.ts` re-exports, across Pi's packages, to the module that defines each symbol. It diffs the `.js` and `.d.ts` of those modules, and names every other changed file of the same packages. An adapter must import the Pi class it patches, since strict TypeScript accepts nothing less, so that class's module is watched as soon as the adapter exists. Two rules keep this true:

- Import Pi's symbols by name from a package's entry point. `npm test` rejects namespace, default, side-effect, and subpath imports, a dynamic `import()` of a Pi package, and any symbol that `pi-diff` cannot trace to its module.
- Reach a module that Pi does not export only by a `"dist/….js"` path literal under Pi's package directory, as `inspector/paths.ts` does. `pi-diff` watches each such path, and `npm test` rejects a dynamic `import()` in a file that names none.

`pi-diff` finds the previous release in Pi's managed install directory, which keeps the release that ran the last update beside the new one. If it is gone (after two upgrades without a review, say), or Pi is installed as an ordinary package, `pi-diff` fetches the reviewed release from npm into a temporary directory. `npm run pi-diff -- <version>` compares any release with the installed one.

## Development

One `package.json` and lockfile in this directory hold every development dependency. No extension has a package of its own or a runtime dependency.

Development needs Node 22.19+ (Pi's own minimum, which npm enforces through `devEngines`), Pi on `PATH` or `PI_PACKAGE_DIR`, `/usr/bin/vim`, and native build tools (on macOS, the Xcode Command Line Tools). Build `node-pty` from source: its 1.1.0 prebuilt helper has a permissions defect on macOS.

```sh
cd ~/.pi/agent/extensions
npm_config_build_from_source=true npm ci
npm run format
npm run verify
```

`npm run verify` runs these steps in order, and each also runs alone:

| Step | Command | What it does |
|---|---|---|
| Lint | `npm run check` | Biome. |
| Types | `npm run typecheck` | Strict TypeScript over every extension entry point, test, and support module, with `erasableSyntaxOnly` and `verbatimModuleSyntax`: no enums, namespaces, or parameter properties, and type-only imports use `import type`. |
| Tests | `npm test` | Unit and integration tests. A test that runs longer than a minute fails by name instead of stalling the suite. |
| Terminal | `npm run test:terminal` | Real Pi and Vim over a PTY. |
| Budgets | `npm run test:perf` | Real Pi over a PTY, alone and with the extensions, against the budgets below. |
| Review | `npm run pi-diff -- --status` | Reports whether `piReviewed` matches the installed Pi. |

Node runs the TypeScript tests directly, with its own type stripping and no build step:

- `<extension>/tests/*.test.ts` are one extension's unit tests. A suite imports only its own extension, `shared/`, and `test/`, so deleting an extension breaks no other extension's tests. Only the files in `test/` then need a change.
- `<extension>/tests/*.ts` without `.test` are that extension's fixtures.
- `test/*.test.ts` cover more than one extension: the `shared/` protocols, including two extensions meeting through separate copies of `shared/`; `mirage` with `rearview`; and `comrade` with `mirage`. Two guards sit beside them. Pi must autoload the seven extensions and never `test/` or `shared/`, which hold no `index.ts`, and `pi-diff` must trace every Pi import.
- `test/e2e/` holds the terminal and budget suites, with their offline providers.
- `test/pi.ts`, `test/fake-pi.ts`, `test/transcript.ts`, and `test/headless-terminal.ts` are test support. Extension code loads through `jiti` against the installed Pi, as Pi loads it. The fakes are typed against Pi's own declarations, so a renamed Pi API fails `npm run typecheck` at the fake.

### Terminal suite

`test/e2e/terminal.ts` starts Pi's CLI in a pseudo-terminal, with **xterm.js (`@xterm/headless`) and Microsoft's `node-pty`**. It waits for terminal state instead of sleeping, reads Unicode cells and RGB colours, and gates background work itself. Pi and Vim run with isolated settings and an offline provider. Vim's syntax highlighting stays on. Your own configuration, your terminal's settings, and the installed Pi's files are untouched. It covers:

- Groups, scripts run by Pi's `codemode` tool (live nested calls, saved calls after `/resume`, and `store()` entries), a live change of output padding, and command and script times, live and resumed.
- Tool errors, diffs, and images. Image checks read the Kitty graphics commands Pi sent, not pixels.
- Clicks and `Ctrl+O`, the agent working while Vim owns the terminal, newer and replaced editor drafts, a failing editor, saving a file, and resizing the terminal.
- Cleanup across `/new`, `/resume`, `/fork`, and `/reload`.
- Paging: history disabled, fast scrolling between a page being added and the next layout pass, the end of history, archived filenames and images, and model context left unchanged.
- An adapter's fallback when Pi's internals have changed.
- `echo` autocomplete and insertion without sending the message.
- Idle CPU: with all seven extensions loaded, Pi uses at most 0.05 s of CPU in 10 s (`IDLE_CPU_SECONDS`, `IDLE_SECONDS`).

Raw terminal output, cell snapshots, screens, and session files stay in the temporary directory the suite prints.

### Budgets

`test/e2e/perf.ts` runs one streamed reply twice, in Pi alone and in Pi with every extension, with tool output expanded (`Ctrl+O`), where rows cost most. `perf-probe.ts` times every fullscreen frame and reads Pi's CPU time at each mark, and `perf-provider.ts` streams the reply offline. A budget is the extensions' cost as a multiple of Pi's own in the same phase, so it holds on a slower machine. Idle is absolute: nothing may run.

| Phase | Budget (`BUDGET` in `perf.ts`) | What breaks it |
|---|---|---|
| Idle, before the reply and after it, a comrade's runs included | 15 ms of CPU and 1 frame in 3 s | A timer left running. |
| A write's 400 lines streaming in, below 1,200 expanded lines of its group | 1.5 times Pi's CPU | Highlighting the whole write for each frame. |
| Calls in progress in a group of 1,600 expanded lines, one a command printing for 3 s | 3.5 times Pi's CPU | A spinner frame that builds the group's output again. |

The suite prints each phase's CPU time, frames, and frame times (p50 and p99) for both runs.
