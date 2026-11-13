import { AssistantMessageComponent, VERSION } from "@earendil-works/pi-coding-agent";
import { installPatch } from "../shared/patch.ts";

type Update = AssistantMessageComponent["updateContent"];
interface NativeComponent {
  hideThinkingBlock: boolean;
  lastMessage?: Parameters<Update>[0];
}
interface Owner {
  report(error: Error): void;
  visibility(hidden: boolean): void;
}
// Pi declares these fields private, so its type shares none with this view of them. The patched
// method checks both before it reads either.
const internals = (component: AssistantMessageComponent) => component as unknown as NativeComponent;

/**
 * Hidden thinking takes no rows. Project only the render input, retaining the original message
 * for native toggles and invalidation. No session, provider, or event message is edited.
 *
 * Since Pi 1.5.0 a hidden block with an empty label takes no rows natively, and
 * `ctx.ui.setHiddenThinkingLabel("")` would ask for that. It is not used: Pi puts its own label
 * back and draws a frame before every /reload and session switch, long before session_start can
 * empty it again, so each hidden block would flash a label row.
 */
export function installNativeThinking(
  report: Owner["report"],
  visibility: Owner["visibility"],
): () => void {
  return installPatch<Owner, undefined>({
    key: "mirage.native-thinking.patch.v2",
    name: "mirage's thinking adapter",
    sites: [{ target: AssistantMessageComponent.prototype, name: "updateContent" }],
    owner: { report, visibility },
    build(originals, owners) {
      const original: Update = originals[0];
      let warned = false;
      const update: Update = function (this: AssistantMessageComponent, message, streaming) {
        const component = internals(this);
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
        if (
          !component.hideThinkingBlock ||
          !message.content.some((part) => part.type === "thinking")
        )
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
      return { methods: [update], state: undefined };
    },
  }).release;
}
