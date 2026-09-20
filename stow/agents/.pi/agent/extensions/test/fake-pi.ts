// Minimal fakes checked against Pi's declarations: if Pi renames or removes a
// member a fake provides, typecheck fails at the fake instead of tests passing
// against a stale API.
import type { EventBus, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { core } from "./pi.ts";

/** Any registered tool, as Pi itself stores them (its internal AnyToolDefinition). */
// biome-ignore lint/suspicious/noExplicitAny: schema-specific definitions are only assignable to any.
export type Tool = ToolDefinition<any, any, any>;
type Handler = (event: unknown, ctx: unknown) => unknown;

/** Recursive partial that keeps functions whole and rejects unknown members. */
export type Fake<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? T
    : T extends object
      ? { [K in keyof T]?: Fake<T[K]> }
      : T;

/** Build a partial fake of a Pi type. Unused members are simply absent at runtime. */
export function fake<T>(value: Fake<T>): T {
  return value as T;
}

export interface FakePi {
  /** What extensions receive: only on/registerTool/events are implemented. */
  readonly api: ExtensionAPI;
  readonly tools: Map<string, Tool>;
  readonly events: EventBus;
  /** Await each handler in registration order, as Pi does for lifecycle events. */
  event(name: string, value?: unknown, ctx?: unknown): Promise<void>;
  /** Invoke handlers synchronously, ignoring returned promises. */
  emit(name: string, value?: unknown, ctx?: unknown): void;
}

export function fakePi(): FakePi {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Tool>();
  const events = core.createEventBus();
  const api = {
    events,
    on(name: string, handler: (...args: never[]) => unknown) {
      const list = handlers.get(name) ?? [];
      const entry = handler as Handler;
      list.push(entry);
      handlers.set(name, list);
      return () => {
        const index = list.indexOf(entry);
        if (index >= 0) list.splice(index, 1);
      };
    },
    registerTool(tool: Tool) {
      tools.set(tool.name, tool);
    },
  } satisfies Pick<ExtensionAPI, "events" | "on" | "registerTool">;
  const current = (name: string) => [...(handlers.get(name) ?? [])];
  return {
    api: api as unknown as ExtensionAPI,
    tools,
    events,
    async event(name, value, ctx) {
      for (const handler of current(name)) await handler(value, ctx);
    },
    emit(name, value, ctx) {
      for (const handler of current(name)) void handler(value, ctx);
    },
  };
}
