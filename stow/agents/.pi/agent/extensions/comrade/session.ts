// What every part of the extension knows of the session Pi has open.
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export interface Session {
  /** Pi's UI, while a session is open. */
  ui?: ExtensionContext["ui"];
  /** The open session's id. */
  id?: string;
  /**
   * The open session's entries, which tell whether a saved answer has been delivered, and its
   * current branch, which rows look their comrade's runs up in.
   */
  entries?: () => SessionEntry[];
  branch?: () => SessionEntry[];
  /** Whether Pi runs in the terminal: only there are a widget and an Esc to see. */
  terminal: boolean;
  /** The directory comrades run in unless told otherwise. */
  home: string;
}
