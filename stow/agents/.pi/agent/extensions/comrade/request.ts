// Turn the model's comrade arguments into a run request, rejecting what the comrade
// could not use before it starts.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import type { Request } from "./run.ts";

export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING)[number];
/** Read-only built-ins: enough to find and read files, nothing that changes them. */
export const READ_ONLY = ["read", "grep", "find", "ls"];
/** This extension's own tools, which comrades never get. */
const OWN = ["comrade", "comrades"];

/** The tools a comrade gets when the caller names none: the read-only ones active here. */
export function defaultTools(active: string[]): string[] {
  return READ_ONLY.filter((name) => active.includes(name));
}

/**
 * What comrade's tools parameter tells the calling model. Pi's grep, find and ls are off unless
 * enabled, so the default names only the read-only tools active here: naming the others would
 * have the model ask for tools a comrade cannot have. Without a session yet, no list at all.
 */
export function toolsDescription(active?: string[]): string {
  const rest =
    'Add "edit" and "write" to change files, "bash" to run commands. [] for none. Only tools ' +
    "active here.";
  if (!active) return `Default: the read-only tools active here, or the comrade's with to. ${rest}`;
  const tools = defaultTools(active);
  const list = tools.length
    ? `read-only, [${tools.map((name) => `"${name}"`).join(", ")}]`
    : "none, as no read-only tool is active here";
  return `Default: ${list}, or the comrade's with to. ${rest}`;
}

export interface Arguments {
  /** A few words naming the job, which its row shows. */
  title?: string;
  task: string;
  model?: string;
  thinking?: Thinking;
  tools?: string[];
  files?: string[];
  output?: string;
  cwd?: string;
  /** Seconds. */
  timeout?: number;
}

/** A path as the caller wrote it, from the working directory, with `~` as the home directory. */
export function absolute(path: string, cwd: string): string {
  const home = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
  return resolve(cwd, home);
}

/** Files to attach. Pi would exit on a missing one, and cannot attach a directory. */
export function resolveFiles(requested: string[] | undefined, cwd: string): string[] {
  const files = (requested ?? []).map((name) => {
    const file = absolute(name, cwd);
    const stats = statSync(file, { throwIfNoEntry: false });
    if (!stats) throw new Error(`File "${name}" for comrade does not exist: ${file}.`);
    if (!stats.isFile())
      throw new Error(`"${name}" is not a file. Pass comrade files, not directories.`);
    return file;
  });
  return [...new Set(files)];
}

/** The thinking level a `model:level` name carries, as `pi --model` reads it. */
export function thinkingSuffix(model: string): Thinking | undefined {
  const suffix = model.slice(model.lastIndexOf(":") + 1) as Thinking;
  return model.includes(":") && THINKING.includes(suffix) ? suffix : undefined;
}

/**
 * Tool names and `*` patterns, checked against the tools a comrade can have: those active
 * here. The caller's tool set is the ceiling, so a Pi started with `--tools read` cannot hand
 * a comrade `bash`. The default is the read-only set, less any tool not active here.
 */
export function resolveTools(requested: string[] | undefined, pi: ExtensionAPI): string[] {
  const active = pi.getActiveTools().filter((name) => !OWN.includes(name));
  if (requested === undefined) return defaultTools(active);
  const tools = [...new Set(requested)];
  if (tools.some((tool) => OWN.includes(tool))) throw new Error("A comrade cannot start comrades.");
  const all = pi.getAllTools().map((tool) => tool.name);
  for (const tool of tools) {
    const pattern = new RegExp(
      `^${tool.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`,
    );
    const valid = /^[\w.*:-]+$/.test(tool) && !tool.startsWith("-");
    if (valid && active.some((name) => pattern.test(name))) continue;
    const available = active.length ? active.join(", ") : "none";
    // Pi silently ignores unknown names, which would leave the comrade without the tool.
    if (valid && all.some((name) => pattern.test(name)))
      throw new Error(
        `Tool "${tool}" is not active here, so a comrade cannot have it. Active: ${available}.`,
      );
    throw new Error(`Unknown tool "${tool}" for comrade. Active: ${available}.`);
  }
  return tools;
}

/**
 * The models a comrade may use, the same set Pi's own model picker offers: the session's
 * scoped models (`enabledModels` or `--models`), or with no scope, every model with credentials.
 */
export function enabledModels(ctx: Pick<ExtensionContext, "modelRegistry" | "scopedModels">) {
  const scoped = ctx.scopedModels.length > 0;
  const models = scoped
    ? ctx.scopedModels.map((entry) => entry.model)
    : ctx.modelRegistry.getAvailable();
  return { scoped, models, names: models.map((model) => `${model.provider}/${model.id}`) };
}

/**
 * What comrade's model parameter tells the calling model: every enabled model by name, or with
 * no scope, which could be hundreds, the caller's own as the example. Without a session yet,
 * no names at all.
 */
export function modelDescription(
  ctx?: Pick<ExtensionContext, "model" | "modelRegistry" | "scopedModels">,
): string {
  const fallback = "Default: your model, or the comrade's with to.";
  if (!ctx)
    return `provider/id of a model enabled in this Pi, exactly as Pi lists it, optionally with :thinking. Bare names are refused. ${fallback}`;
  const { scoped, names } = enabledModels(ctx);
  if (scoped) return `One of: ${names.join(", ")}. Optionally with :thinking. ${fallback}`;
  const example = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : names[0];
  return `provider/id of a model with credentials in this Pi, exactly as Pi lists it${example ? `, such as ${example}` : ""}, optionally with :thinking. Bare names are refused. ${fallback}`;
}

/**
 * A model as `provider/id`, with an optional `:thinking` suffix, that must be one of the
 * enabled models. Bare names are refused: `anthropic/claude-fable-5-1` alone can name
 * Anthropic's model or OpenRouter's id of the same text.
 */
export function resolveModel(
  name: string,
  ctx: Pick<ExtensionToolContext, "modelRegistry" | "scopedModels">,
): { provider: string; model: string; thinking?: Thinking } {
  const { scoped, models: enabled, names } = enabledModels(ctx);
  const pick = (text: string) => {
    const model = enabled[names.indexOf(text)];
    return model && { provider: model.provider, model: model.id };
  };
  const wanted = name.trim();
  const suffix = thinkingSuffix(wanted);
  const base = suffix ? wanted.slice(0, wanted.lastIndexOf(":")) : undefined;
  // An id may itself contain a colon, as OpenRouter's `:batch` variants do.
  const found = pick(wanted);
  if (found) return found;
  const leveled = base === undefined ? undefined : pick(base);
  if (leveled) return { ...leveled, thinking: suffix };
  // Try each slash as the end of the provider, so provider ids containing one still work.
  const registered = (text: string) => {
    for (let slash = text.indexOf("/"); slash > 0; slash = text.indexOf("/", slash + 1))
      if (ctx.modelRegistry.find(text.slice(0, slash), text.slice(slash + 1))) return true;
    return false;
  };
  const list = names.join(", ") || "none";
  if (registered(wanted) || (base !== undefined && registered(base)))
    throw new Error(
      `Model "${name}" is not ${scoped ? "enabled" : "available"} here, so a comrade cannot use it. ${scoped ? "Enabled" : "Available"}: ${list}.`,
    );
  throw new Error(`Unknown model "${name}". Pass comrade's model as provider/id, such as ${list}.`);
}

/** Where to write the answer. Its directory is created when the answer is written. */
function resolveOutput(requested: string | undefined, cwd: string): string | undefined {
  if (requested === undefined) return undefined;
  if (!requested.trim()) throw new Error("comrade's output needs a file path.");
  const file = absolute(requested, cwd);
  if (statSync(file, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`comrade's output "${requested}" is a directory. Pass a file path.`);
  return file;
}

/** The directory the comrade runs in, which must exist. */
function resolveCwd(requested: string | undefined, cwd: string): string {
  if (requested === undefined) return cwd;
  if (!requested.trim()) throw new Error("comrade's cwd needs a directory path.");
  const directory = absolute(requested, cwd);
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`comrade's cwd "${requested}" is not a directory: ${directory}.`);
  return directory;
}

/** The longest title a row keeps: a few words naming the job. */
export const TITLE_MAX = 60;

// biome-ignore lint/suspicious/noControlCharactersInRegex: a title is one plain line.
const CONTROLS = /[\x00-\x1f\x7f]+/g;

/** A title on one line, at most TITLE_MAX characters. */
export function cleanTitle(title: string | undefined): string | undefined {
  const line = title?.replace(CONTROLS, " ").replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/** Whether `path` is `root` or inside it. */
export function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** How a comrade ran, which its follow-ups keep unless they say otherwise. */
export interface Previous {
  title?: string;
  provider: string;
  model: string;
  thinking?: string;
  tools?: string[];
  cwd?: string;
}

/**
 * The comrade runs exactly the model named, under its own provider. A follow-up keeps the
 * comrade's own model, thinking level and tools, not the caller's.
 */
export function prepare(
  args: Arguments,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  previous?: Previous,
): Omit<Request, "session" | "followUp"> {
  if (!args.task.trim()) throw new Error("comrade needs a task.");
  const chosen = args.model
    ? resolveModel(args.model, ctx)
    : previous
      ? { provider: previous.provider, model: previous.model, thinking: undefined }
      : ctx.model && { provider: ctx.model.provider, model: ctx.model.id, thinking: undefined };
  if (!chosen) throw new Error("No model is selected: pass comrade a model as provider/id.");
  const cwd = resolveCwd(args.cwd ?? previous?.cwd, ctx.cwd);
  return {
    task: args.task,
    provider: chosen.provider,
    model: chosen.model,
    thinking:
      args.thinking ??
      chosen.thinking ??
      previous?.thinking ??
      ctx.thinkingLevel ??
      pi.getThinkingLevel(),
    tools: resolveTools(args.tools ?? previous?.tools, pi),
    files: resolveFiles(args.files, ctx.cwd),
    output: resolveOutput(args.output, ctx.cwd),
    timeoutMs: args.timeout === undefined ? undefined : args.timeout * 1000,
    cwd,
    origin: ctx.cwd,
    // The caller's trust covers its own project. Elsewhere, Pi loads no project-local files.
    trusted: ctx.isProjectTrusted() && within(cwd, ctx.cwd),
  };
}
