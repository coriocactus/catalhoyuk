// Mirage's tests share this fixture. It runs the extension on a fake Pi and calls the
// renderers the way Pi's tool rows call them.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI, TuiMouseEvent, TuiMouseEventType } from "@earendil-works/pi-tui";
import { MARKERS } from "../../shared/selection.ts";
import { type FakePi, fake, fakePi, type Tool } from "../../test/fake-pi.ts";
import { core, load, themes, tui } from "../../test/pi.ts";
import type { ToolGroupView } from "../view.ts";

export const { default: installDisplay } = await load<typeof import("../index.ts")>(
  "../index.ts",
  import.meta.url,
);
export const { ToolGroups } = await load<typeof import("../model.ts")>(
  "../model.ts",
  import.meta.url,
);
export const { colouredDiff } = await load<typeof import("../style.ts")>(
  "../style.ts",
  import.meta.url,
);
export { paint } from "../../shared/colours.ts";
export { diffCounts, writtenLines } from "../../shared/format.ts";

export type Result = AgentToolResult<unknown>;
export type Message = Parameters<InstanceType<typeof ToolGroups>["observe"]>[0];
export type RenderContext = Parameters<NonNullable<Tool["renderCall"]>>[2];
type DisplayState = { view?: ToolGroupView };
type Notice = Parameters<ExtensionContext["ui"]["notify"]>;
type Renderers = ToolRenderers | Tool;
/** Private InteractiveMode lookup that binds tool renderers to their host. */
interface ToolLookup {
  getRegisteredToolDefinition(this: object, name: string): Renderers | undefined;
}

export const interactive = core.InteractiveMode.prototype as unknown as ToolLookup;
const nativeRender = core.ToolExecutionComponent.prototype.render;
const nativeLookup = interactive.getRegisteredToolDefinition;
const ui = fake<TUI>({ requestRender() {} });
export const assistantStart = { role: "assistant", content: [] } as unknown as Message;
export const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=";
export const root = mkdtempSync(join(tmpdir(), "pi-mirage-"));
const sessions: FakePi[] = [];
after(async () => {
  for (const pi of sessions) await pi.event("session_shutdown");
  assert.equal(
    core.ToolExecutionComponent.prototype.render,
    nativeRender,
    "last owner restores Pi rendering on shutdown",
  );
  assert.equal(
    interactive.getRegisteredToolDefinition,
    nativeLookup,
    "mirage never replaces Pi's tool lookup",
  );
  rmSync(root, { recursive: true, force: true });
});

export const mouse = (x: number, y = 0, type: TuiMouseEventType = "click"): TuiMouseEvent => ({
  type,
  button: "left",
  x,
  y,
  screenX: x,
  screenY: y,
  width: 160,
  height: 40,
  shift: false,
  alt: false,
  ctrl: false,
});
/** A rendered line without prose's zero-width selection markers, to compare raw styling. */
export const unmark = (line: string) =>
  MARKERS.reduce((value, marker) => value.replaceAll(marker, ""), line);
export const plain = (component: Component, width = 160) =>
  component
    .render(width)
    .map((line) => tui.stripTerminalSequences(line).trimEnd())
    .join("\n");
export const isImageLine = (line: string) =>
  line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
export const result = (value: string, details: unknown = {}): Result => ({
  content: [{ type: "text", text: value }],
  details,
});
export const firstText = (output: Result) => {
  const part = output.content[0];
  assert(part?.type === "text", "text result");
  return part.text;
};
/** Private ToolExecutionComponent state. */
export const internals = (component: object) =>
  component as { rendererState: DisplayState; imageComponents: Component[] };
export const component = (
  name: string,
  id: string,
  args: unknown,
  definition: Renderers | undefined,
  cwd: string,
  options: { showImages?: boolean; outputPad?: number } = {},
) =>
  new core.ToolExecutionComponent(
    name,
    id,
    args,
    { outputPad: 0, ...options },
    definition,
    ui,
    cwd,
  );

export interface Slot {
  definition: ToolRenderers;
  context: RenderContext;
  view: ToolGroupView;
  redraw(): void;
  result(output: Result, failed?: boolean, partial?: boolean): void;
}

/**
 * `global` is Pi's settings, which mirage reads at session start. `busy` makes Pi
 * report that it is working, as it does during a turn.
 */
export async function fixture({
  global = {},
  busy = false,
}: {
  global?: ReturnType<ExtensionAPI["getSettings"]>;
  busy?: boolean;
} = {}) {
  const dir = mkdtempSync(join(root, "case-"));
  const pi = fakePi(() => global),
    slots: Slot[] = [],
    notices: Notice[] = [];
  let allExpanded = false,
    entries: SessionEntry[] = [],
    invalidations = 0;
  let working = busy;
  const ctx = fake<ExtensionContext>({
    mode: "tui",
    cwd: dir,
    isIdle: () => !working,
    isProjectTrusted: () => false,
    ui: {
      getToolsExpanded: () => allExpanded,
      notify: (...args) => notices.push(args),
    },
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "test",
      getSessionFile: () => undefined,
    },
  });
  installDisplay(pi.api);
  sessions.push(pi);
  await pi.event("session_start", {}, ctx);
  const tool = (name: string): ToolRenderers => {
    const definition = pi.renderers(name);
    assert(definition, `${name} is drawn by mirage`);
    return definition;
  };
  function call(name: string, id: string, args: unknown, started = true): Slot {
    const definition = tool(name);
    const context = fake<RenderContext>({
      args,
      toolCallId: id,
      state: {},
      cwd: dir,
      executionStarted: started,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: false,
      isError: false,
      outputPad: 0,
      invalidate() {
        invalidations++;
      },
    });
    const render = () =>
      definition.renderCall?.(context.args, themes.theme, context) as ToolGroupView;
    const slot: Slot = {
      definition,
      context,
      view: render(),
      redraw() {
        slot.view = render();
      },
      result(output, failed = false, partial = false) {
        context.isError = failed;
        definition.renderResult?.(
          output,
          { expanded: allExpanded, isPartial: partial },
          themes.theme,
          context,
        );
      },
    };
    slots.push(slot);
    return slot;
  }
  return {
    pi,
    ctx,
    dir,
    tool,
    call,
    notices,
    get invalidations() {
      return invalidations;
    },
    /** Pi starts or stops working, as at the start and end of a turn. */
    setBusy(value: boolean) {
      working = value;
    },
    expand(value: boolean) {
      allExpanded = value;
      for (const slot of slots) slot.redraw();
    },
    async rebuild(event: string, values: unknown[] = []) {
      entries = values as SessionEntry[];
      await pi.event(event, {}, ctx);
    },
  };
}
