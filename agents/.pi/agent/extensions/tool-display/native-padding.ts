import {
  InteractiveMode,
  type ToolExecutionComponent,
  VERSION,
} from "@earendil-works/pi-coding-agent";

const OWNER = Symbol.for("tool-display.native-padding.owner.v1");
const SOURCE = Symbol.for("tool-display.native-padding.source.v1");
const PATCH = Symbol.for("tool-display.native-padding.patch.v1");
type Renderers = NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]>;
type PaddingState = { [SOURCE]?: () => number };
interface NativeHost {
  outputPad: number;
  getRegisteredToolDefinition(name: string): Renderers | undefined;
}
type Lookup = NativeHost["getRegisteredToolDefinition"];
interface Patch {
  original: Lookup;
  lookup: Lookup;
  users: number;
  reports: ((error: Error) => void)[];
}

export function ownOutputPadding<T extends object>(definition: T): T {
  return { ...definition, [OWNER]: true };
}

/** No outer padding when a renderer is used outside Pi's interactive host. */
export function outputPadding(state: object): number {
  return (state as PaddingState)[SOURCE]?.() ?? 0;
}

/**
 * Pi omits outputPad from tool render contexts. Bind our definitions to
 * their host's live value, including archived rows and changes while streaming.
 * This is the only private padding boundary; no settings I/O during rendering.
 */
export function installNativeOutputPadding(
  report: (error: Error) => void = (error) => {
    throw error;
  },
): () => void {
  const prototype = InteractiveMode.prototype as unknown as NativeHost & { [PATCH]?: Patch };
  let patch = prototype[PATCH];
  if (patch && prototype.getRegisteredToolDefinition !== patch.lookup)
    throw new Error("Another extension replaced tool-display's padding adapter.");
  if (!patch) {
    const original = prototype.getRegisteredToolDefinition;
    if (typeof original !== "function") throw new Error("Pi's tool renderer lookup changed.");
    const reports: Patch["reports"] = [];
    let warned = false;
    const lookup: Lookup = function (this: NativeHost, name) {
      const definition = original.call(this, name);
      if (!(definition as { [OWNER]?: boolean } | undefined)?.[OWNER] || !definition?.renderCall)
        return definition;
      const call = definition.renderCall;
      const padding = () => {
        if (Number.isSafeInteger(this.outputPad) && this.outputPad >= 0) return this.outputPad;
        if (!warned) {
          warned = true;
          reports.at(-1)?.(
            new Error(
              `Pi ${VERSION}: output padding API changed; tool rows will use no outer padding. Run npm run verify in ~/.pi/agent/extensions.`,
            ),
          );
        }
        return 0;
      };
      return {
        ...definition,
        renderCall(...args: Parameters<NonNullable<Renderers["renderCall"]>>) {
          (args[2].state as PaddingState)[SOURCE] = padding;
          return call(args[0], args[1], args[2]);
        },
      };
    };
    patch = { original, lookup, users: 0, reports };
    prototype[PATCH] = patch;
    prototype.getRegisteredToolDefinition = lookup;
  }
  patch.users++;
  patch.reports.push(report);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    patch.reports.splice(patch.reports.lastIndexOf(report), 1);
    if (--patch.users !== 0) return;
    if (prototype.getRegisteredToolDefinition === patch.lookup) {
      prototype.getRegisteredToolDefinition = patch.original;
      delete prototype[PATCH];
    }
  };
}
