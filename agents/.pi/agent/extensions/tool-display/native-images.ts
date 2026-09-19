import { ToolExecutionComponent, VERSION } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

const OWNER = Symbol.for("tool-display.native-images.owner.v1");
const SLOT = Symbol.for("tool-display.native-images.slot.v1");
const PATCH = Symbol.for("tool-display.native-images.patch.v1");
type ImageState = { [SLOT]?: Component };
type Render = ToolExecutionComponent["render"];
interface Patch {
  original: Render;
  render: Render;
  users: number;
  reports: ((error: Error) => void)[];
}

// Pi has no public per-tool image ownership option. These are the ONLY private
// fields this compatibility adapter uses. Check capabilities, not version numbers.
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
 * Move Pi's native image components into our collapsible body. Pi still owns
 * decoding, Kitty conversion, sizing, and capability/settings checks. Only
 * tagged self-rendering tools are affected; result content is never changed.
 * Remove this adapter when Pi exposes renderer-owned images publicly.
 */
export function installNativeImageSlot(
  report: (error: Error) => void = (error) => {
    throw error;
  },
): () => void {
  const prototype = ToolExecutionComponent.prototype as typeof ToolExecutionComponent.prototype & {
    [PATCH]?: Patch;
  };
  let patch = prototype[PATCH];
  if (patch && prototype.render !== patch.render)
    throw new Error("Another extension replaced tool-display's image adapter.");
  if (!patch) {
    const original = prototype.render;
    if (typeof original !== "function")
      throw new Error("Pi's native tool renderer is unavailable.");
    const reports: Patch["reports"] = [];
    let warned = false;
    const render: Render = function (this: ToolExecutionComponent, width) {
      const component = this as unknown as NativeComponent;
      const fallback = () => {
        if (!warned) {
          warned = true;
          reports.at(-1)?.(
            new Error(
              `Pi ${VERSION}: image adapter API changed; using native previews. Run npm run verify in ~/.pi/agent/extensions.`,
            ),
          );
        }
        return original.call(this, width);
      };
      if (!("toolDefinition" in component)) return fallback();
      if (!component.toolDefinition?.[OWNER] || component.toolDefinition.renderShell !== "self") {
        return original.call(this, width);
      }
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
        return fallback();
      }
      component.rendererState[SLOT] ??= {
        invalidate() {},
        render(imageWidth) {
          return component.imageComponents.flatMap((image, index) => [
            ...(component.imageSpacers[index]?.render(imageWidth) ?? []),
            ...image.render(imageWidth),
          ]);
        },
      };
      // Match Pi's self-shell spacing and hit-testing, without appending images
      // a second time. The view decides whether to render the supplied slot.
      const lines = component.selfRenderContainer.render(width);
      component.selfRenderHeight = lines.length;
      return lines.length ? ["", ...lines] : [];
    };
    patch = { original, render, users: 0, reports };
    prototype[PATCH] = patch;
    prototype.render = render;
  }
  patch.users++;
  patch.reports.push(report);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    patch.reports.splice(patch.reports.lastIndexOf(report), 1);
    if (--patch.users !== 0) return;
    if (prototype.render === patch.render) {
      prototype.render = patch.original;
      delete prototype[PATCH];
    }
  };
}
