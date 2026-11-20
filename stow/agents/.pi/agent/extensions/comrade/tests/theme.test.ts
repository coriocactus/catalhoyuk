// What a row has drawn once is drawn again after a theme change, in the new theme's colours. Pi
// hands every row the same theme object whatever the theme.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakePi } from "../../test/fake-pi.ts";
import { load, themes } from "../../test/pi.ts";

const view = await load<typeof import("../view.ts")>("../view.ts", import.meta.url);
const { createTranscripts } = await load<typeof import("../transcripts.ts")>(
  "../transcripts.ts",
  import.meta.url,
);

test("a row drawn again after a theme change takes the new theme's colours", (t) => {
  t.after(() => themes.setTheme("dark"));
  const theme = themes.theme;
  const look = {
    phase: "finished" as const,
    task: "Check the notes",
    expanded: true,
    blocks: [
      { kind: "text" as const, text: "# Notes", source: {} },
      { kind: "thinking" as const, text: "They read cleanly.", source: {} },
    ],
  };
  const row = new view.RowView(look, undefined, "", theme, 0);
  const lines = () => {
    row.invalidate();
    return row.render(80);
  };
  const line = (text: string) => lines().find((each) => each.includes(text)) ?? "";
  const colours = () => ({
    task: theme.getFgAnsi("muted"),
    heading: theme.getFgAnsi("mdHeading"),
    thought: theme.getFgAnsi("dim"),
  });
  const dark = colours();
  // The task behind its bar.
  assert(line("│").includes(dark.task));
  themes.setTheme("light");
  const light = colours();
  assert.notDeepEqual(light, dark);
  for (const [text, colour] of [
    ["│", "task"],
    ["Notes", "heading"],
    ["They read cleanly.", "thought"],
  ] as const) {
    assert(line(text).includes(light[colour]), `the ${colour} in the light theme`);
    assert(!line(text).includes(dark[colour]), `the ${colour} not in the dark theme`);
  }
});

test("a run's work is built again in a new theme", (t) => {
  t.after(() => themes.setTheme("dark"));
  const transcripts = createTranscripts(fakePi().api);
  const messages = [
    { role: "user", content: "task" },
    { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" },
  ] as never[];
  transcripts.track("run", messages, true);
  const blocks = () => transcripts.blocksFor("run", () => undefined, "/tmp", themes.theme, true);
  const first = blocks();
  assert.equal(blocks(), first, "the same blocks until something changes");
  themes.setTheme("light");
  assert.notEqual(blocks(), first);
});
