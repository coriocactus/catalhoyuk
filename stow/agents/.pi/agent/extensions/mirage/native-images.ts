import { ToolExecutionComponent, VERSION } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { type AnchoredComponent, type AnchorState, ROW_ANCHOR } from "../shared/anchors.ts";

const OWNER = Symbol.for("mirage.native-images.owner.v1");
const SLOT = Symbol.for("mirage.native-images.slot.v1");
const PATCH = Symbol.for("mirage.native-images.patch.v1");
type ImageState = AnchorState & { [SLOT]?: Component };
type Render = ToolExecutionComponent["render"];
type Context = (this: ToolExecutionComponent, previous?: Component) => { state: ImageState };
interface Patch {
  original: Render;
  render: Render;
  originalContext: Context;
  context: Context;
  users: number;
  reports: ((error: Error) => void)[];
}

// The only private boundary for images and tool-shell anchor forwarding.
interface NativeComponent {
  toolDefinition?: { [OWNER]?: boolean; renderShell?: string };
  rendererState: ImageState;
  selfRenderContainer: Component;
  selfRenderHeight: number;
  imageComponents: Component[];
  imageSpacers: Component[];
}

export function ownImageRendering<T extends object>(definition: T): T {
  return { ...definition, [OWNER]: true };
}

export function renderNativeImages(state: object, width: number): string[] {
  return (state as ImageState)[SLOT]?.render(width) ?? [];
}

/**
 * Bind each native image slot before renderCall, not during painting. A group's
 * leader can then render a later member's previews on the very first frame.
 * Pi still owns decoding, async conversion, image IDs, sizing and settings.
 */
export function installNativeImageSlot(
  report: (error: Error) => void = (error) => {
    throw error;
  },
): () => void {
  const prototype = ToolExecutionComponent.prototype as unknown as {
    render: Render;
    getRenderContext: Context;
    [PATCH]?: Patch;
  };
  let patch = prototype[PATCH];
  if (patch && (prototype.render !== patch.render || prototype.getRenderContext !== patch.context))
    throw new Error("Another extension replaced mirage's image adapter.");
  if (!patch) {
    const original = prototype.render;
    const originalContext = prototype.getRenderContext;
    if (typeof original !== "function" || typeof originalContext !== "function")
      throw new Error("Pi's native tool renderer is unavailable.");
    const reports: Patch["reports"] = [];
    let warned = false;
    const warn = () => {
      if (warned) return;
      warned = true;
      reports.at(-1)?.(
        new Error(
          `Pi ${VERSION}: image adapter API changed; using native previews. Run npm run verify in ~/.pi/agent/extensions.`,
        ),
      );
    };
    const owned = (component: NativeComponent) =>
      component.toolDefinition?.[OWNER] && component.toolDefinition.renderShell === "self";
    const bind = (component: NativeComponent): boolean => {
      if (
        !component.rendererState ||
        typeof component.rendererState !== "object" ||
        typeof component.selfRenderContainer?.render !== "function" ||
        typeof component.selfRenderHeight !== "number" ||
        !Array.isArray(component.imageComponents) ||
        !Array.isArray(component.imageSpacers) ||
        !component.imageComponents.every((image) => typeof image?.render === "function") ||
        !component.imageSpacers.every((spacer) => typeof spacer?.render === "function")
      ) {
        if (component.rendererState && typeof component.rendererState === "object")
          delete component.rendererState[SLOT];
        warn();
        return false;
      }
      component.rendererState[SLOT] ??= {
        invalidate() {},
        render(width) {
          return component.imageComponents.flatMap((image, index) => [
            ...(component.imageSpacers[index]?.render(width) ?? []),
            ...image.render(width),
          ]);
        },
      };
      return true;
    };
    const context: Context = function (previous) {
      const result = originalContext.call(this, previous);
      const component = this as unknown as NativeComponent;
      if (owned(component) && bind(component)) {
        (this as AnchoredComponent)[ROW_ANCHOR] ??= {
          capture(line, width) {
            return component.rendererState[ROW_ANCHOR]?.capture(line - 1, width);
          },
          locate(anchor, width) {
            const line = component.rendererState[ROW_ANCHOR]?.locate(anchor, width);
            return line === undefined ? undefined : line + 1;
          },
        };
      }
      return result;
    };
    const render: Render = function (this: ToolExecutionComponent, width) {
      const component = this as unknown as NativeComponent;
      if (!("toolDefinition" in component)) {
        warn();
        return original.call(this, width);
      }
      if (!owned(component) || !bind(component)) return original.call(this, width);
      const lines = component.selfRenderContainer.render(width);
      component.selfRenderHeight = lines.length;
      return lines.length ? ["", ...lines] : [];
    };
    patch = { original, render, originalContext, context, users: 0, reports };
    prototype[PATCH] = patch;
    prototype.render = render;
    prototype.getRenderContext = context;
  }
  patch.users++;
  patch.reports.push(report);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    patch.reports.splice(patch.reports.lastIndexOf(report), 1);
    if (--patch.users !== 0) return;
    if (prototype.render === patch.render && prototype.getRenderContext === patch.context) {
      prototype.render = patch.original;
      prototype.getRenderContext = patch.originalContext;
      delete prototype[PATCH];
    }
  };
}
