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
}

// Pi has no public per-tool image ownership option. These are the ONLY private
// fields this compatibility adapter uses. Keep this boundary version-pinned.
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
export function installNativeImageSlot(): () => void {
  if (VERSION !== "0.85.1") {
    throw new Error(
      `tool-display image adapter supports Pi 0.85.1, not ${VERSION}. Revalidate native-images.ts before enabling it on this version.`,
    );
  }
  const prototype = ToolExecutionComponent.prototype as typeof ToolExecutionComponent.prototype & {
    [PATCH]?: Patch;
  };
  let patch = prototype[PATCH];
  if (patch && prototype.render !== patch.render)
    throw new Error("Another extension replaced tool-display's image adapter.");
  if (!patch) {
    const original = prototype.render;
    const render: Render = function (this: ToolExecutionComponent, width) {
      const component = this as unknown as NativeComponent;
      if (!component.toolDefinition?.[OWNER] || component.toolDefinition.renderShell !== "self") {
        return original.call(this, width);
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
    patch = { original, render, users: 0 };
    prototype[PATCH] = patch;
    prototype.render = render;
  }
  patch.users++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--patch.users !== 0) return;
    if (prototype.render === patch.render) {
      prototype.render = patch.original;
      delete prototype[PATCH];
    }
  };
}
