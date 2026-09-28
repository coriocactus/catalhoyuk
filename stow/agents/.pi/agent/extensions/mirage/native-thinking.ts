import { AssistantMessageComponent, VERSION } from "@earendil-works/pi-coding-agent";

const PATCH = Symbol.for("mirage.native-thinking.patch.v1");
type Update = AssistantMessageComponent["updateContent"];
interface NativeComponent {
  hideThinkingBlock: boolean;
  lastMessage?: Parameters<Update>[0];
}
interface Owner {
  report(error: Error): void;
  visibility(hidden: boolean): void;
}
interface Patch {
  original: Update;
  update: Update;
  owners: Set<Owner>;
}

/**
 * Pi's empty hidden-thinking label still occupies rows. Project only the render
 * input, retaining the original message for native toggles and invalidation.
 * No session, provider, or event message is edited.
 */
export function installNativeThinking(
  report: Owner["report"],
  visibility: Owner["visibility"],
): () => void {
  const prototype =
    AssistantMessageComponent.prototype as typeof AssistantMessageComponent.prototype & {
      [PATCH]?: Patch;
    };
  let patch = prototype[PATCH];
  if (patch && prototype.updateContent !== patch.update)
    throw new Error("Another extension replaced mirage's thinking adapter.");
  if (!patch) {
    const original = prototype.updateContent;
    if (typeof original !== "function") throw new Error("Pi's assistant renderer is unavailable.");
    const owners = new Set<Owner>();
    let warned = false;
    const update: Update = function (this: AssistantMessageComponent, message, streaming) {
      const component = this as unknown as NativeComponent;
      if (typeof component.hideThinkingBlock !== "boolean" || !("lastMessage" in component)) {
        for (const owner of owners) owner.visibility(false); // Native placeholders are boundaries.
        if (!warned) {
          warned = true;
          [...owners]
            .at(-1)
            ?.report(
              new Error(
                `Pi ${VERSION}: thinking adapter API changed; using native thinking blocks. Run npm run verify in ~/.pi/agent/extensions.`,
              ),
            );
        }
        return original.call(this, message, streaming);
      }
      for (const owner of owners) owner.visibility(component.hideThinkingBlock);
      if (!component.hideThinkingBlock || !message.content.some((part) => part.type === "thinking"))
        return original.call(this, message, streaming);
      try {
        return original.call(
          this,
          { ...message, content: message.content.filter((part) => part.type !== "thinking") },
          streaming,
        );
      } finally {
        component.lastMessage = message;
      }
    };
    patch = { original, update, owners };
    prototype[PATCH] = patch;
    prototype.updateContent = update;
  }
  const owner = { report, visibility };
  patch.owners.add(owner);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    patch.owners.delete(owner);
    if (!patch.owners.size && prototype.updateContent === patch.update) {
      prototype.updateContent = patch.original;
      delete prototype[PATCH];
    }
  };
}
