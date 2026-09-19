import { isAbsolute } from "node:path";

// This directory has no extension entry point; both extensions import this contract.
export const OPEN_FILE_EVENT = "vim-files:open";
export type FileToolName = "read" | "edit" | "write";

export interface FileReference {
  /** Original tool argument, not a guessed or partially normalized filesystem path. */
  path: string;
  cwd: string;
  tool: FileToolName;
}

export interface OpenFileRequest extends FileReference {
  /** The opener acknowledges synchronously before starting asynchronous work. */
  accepted: boolean;
}

export function isOpenFileRequest(value: unknown): value is OpenFileRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<OpenFileRequest>;
  return (
    typeof request.path === "string" &&
    request.path.length > 0 &&
    typeof request.cwd === "string" &&
    isAbsolute(request.cwd) &&
    (request.tool === "read" || request.tool === "edit" || request.tool === "write") &&
    typeof request.accepted === "boolean"
  );
}
