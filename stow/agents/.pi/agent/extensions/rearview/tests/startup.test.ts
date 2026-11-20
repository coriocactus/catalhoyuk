import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fake, fakePi } from "../../test/fake-pi.ts";
import { core, load, tui } from "../../test/pi.ts";
import { assistant, text, transcript } from "../../test/transcript.ts";

const { default: installHistory } = await load<typeof import("../index.ts")>(
  "../index.ts",
  import.meta.url,
);

test("at startup a fallback warning follows the transcript that Pi draws after session_start", () => {
  const pi = fakePi();
  installHistory(pi.api);
  const f = transcript(0),
    sm = core.SessionManager.inMemory(process.cwd());
  f.host.sessionManager = sm;
  for (let i = 0; i < 70; i++) sm.appendMessage(assistant(`MESSAGE_${i}`));
  // Pi's scroll API changed: Rearview leaves the native transcript in place, with one warning.
  (f.scroll as { getContentWidth?: unknown }).getContentWidth = undefined;
  const ctx = fake<ExtensionContext>({
    mode: "tui",
    ui: {
      // Pi adds a warning to the transcript, below what it holds.
      notify: (message) => f.chat.addChild(new tui.Text(`WARNING ${message}`, 0, 0)),
      onTerminalInput: () => () => {},
    },
  });
  try {
    pi.emit("session_start", { reason: "startup" }, ctx);
    f.host.renderSessionEntries(sm.buildContextEntries(), { populateHistory: true });
    const lines = text(f.chat).split("\n");
    const warning = lines.findIndex((line) => line.includes("WARNING"));
    assert.match(lines.slice(warning).join(" "), /history paging disabled/);
    assert(
      warning > lines.findIndex((line) => line.includes("MESSAGE_69")),
      "below the transcript",
    );
    assert.equal(lines.filter((line) => line.includes("WARNING")).length, 1);
  } finally {
    pi.emit("session_shutdown", { reason: "quit" });
  }
});
