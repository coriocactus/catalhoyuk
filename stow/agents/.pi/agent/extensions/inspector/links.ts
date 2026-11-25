// Links to files in Markdown. In fullscreen, Pi opens a clicked link itself, with the system's
// opener: on macOS, `open`, which gives a Markdown file to TextEdit. Inspector takes a link to a
// text file and opens it in the editor instead, at the line its fragment names, as it opens a
// call's filename. Every other link, and a file that is not text, still goes to Pi's opener.
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { installPatch, patchRecord } from "../shared/patch.ts";

/** A clicked link to a local file: its path, and the line its fragment names (`#L120`). */
export interface FileLink {
  path: string;
  line?: number;
}

/** A local file a `file:` URL names, or nothing for any other link. */
export function fileLink(url: string): FileLink | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "file:" || (parsed.host && parsed.host !== "localhost")) return undefined;
  // `#L120`, `#120`, and ranges such as `#L120-L130`, which open at their first line.
  const line = Number(/^#L?(\d+)/i.exec(parsed.hash)?.[1] ?? 0);
  parsed.hash = "";
  parsed.search = "";
  try {
    return { path: fileURLToPath(parsed), ...(line > 0 ? { line } : {}) };
  } catch {
    return undefined;
  }
}

/** How much of a file tells text from binary: as much as git reads. */
const SNIFF_BYTES = 8000;

/**
 * Whether a file reads as text: no NUL byte in its first bytes, and those bytes valid UTF-8. A
 * character cut where the reading stops is still text. An empty file is text.
 */
export async function isTextFile(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) return false;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
        stream: bytesRead === SNIFF_BYTES,
      });
      return true;
    } catch {
      return false;
    }
  } finally {
    await handle.close();
  }
}

/** Opens a link the system's way: Pi's own opener. */
export type Opener = (url: string) => void;

/** Who takes a clicked link: true once it has, false to leave the link to Pi's opener. */
interface Owner {
  take(url: string, fallback: Opener): boolean;
  report(message: string): void;
}

const KEY = "inspector.links.patch.v1";
/** Pi's own opener of a screen whose opener inspector wrapped. */
const ORIGINAL = Symbol.for("inspector.links.original");

/** The fullscreen screen as inspector reads it: Pi sets its opener from its options. */
interface Screen {
  openUrl?: Opener;
  [ORIGINAL]?: Opener;
}

/**
 * Pi's fullscreen screen opens a clicked link with `openUrl`, a field its options set, so no
 * method of its class can be replaced to reach it. Before the screen handles a mouse event, its
 * opener is wrapped, once. The wrapper asks the owners of the patch installed when the link is
 * clicked, so a reloaded inspector takes the links of a screen an earlier one wrapped, and with
 * none, every link goes to Pi's opener.
 */
function wrap(screen: Screen, report: (message: string) => void): void {
  if (screen[ORIGINAL]) return;
  const original = screen.openUrl;
  if (typeof original !== "function") {
    report("Pi's link opener changed: links open as Pi opens them.");
    screen[ORIGINAL] = () => {};
    return;
  }
  screen[ORIGINAL] = original;
  screen.openUrl = (url) => {
    const owner = [
      ...(patchRecord<Owner, undefined>(KEY, TuiAltScreen.prototype)?.owners ?? []),
    ].at(-1);
    if (!owner?.take(url, original)) original(url);
  };
}

/**
 * Takes clicked links before Pi opens them. `take` returns true for a link it opens, and calls
 * `fallback` to hand one back to Pi's opener later. Throws when Pi lacks the screen's mouse
 * handling, or another extension replaced it.
 */
export function installLinkOpener(
  take: Owner["take"],
  report: Owner["report"],
): { release(): void } {
  // Warn once per copy, not once per screen.
  let warned = false;
  const owner: Owner = {
    take,
    report(message) {
      if (warned) return;
      warned = true;
      report(message);
    },
  };
  const patch = installPatch<Owner, undefined>({
    key: KEY,
    name: "inspector's link opener",
    sites: [{ target: TuiAltScreen.prototype, name: "handleSelectionMouseEvent" }],
    owner,
    build: ([original], owners) => ({
      methods: [
        function (this: Screen, ...args: unknown[]) {
          const current = [...owners].at(-1);
          if (current) wrap(this, (message) => current.report(message));
          return original.apply(this, args);
        },
      ],
      state: undefined,
    }),
  });
  return { release: patch.release };
}
