// The default input context file (ADR 0417): every project has `input/default.input.json`. It holds each action's
// everyday controls and is on for every player at priority 0, beside the code sets' inline defaults. New projects
// are made with it; a project opened without it gets one, so the Input dialog always has a default to show.
import { DEFAULT_CONTEXT, DEFAULT_CONTEXT_PATH } from "../engine/input/contexts";
import type { FileSystem } from "../engine/platform/FileSystem";
import { joinPath } from "./projectPaths";

/** The default context file's text as a new project gets it. */
export const DEFAULT_CONTEXT_TEXT = `${JSON.stringify({ name: DEFAULT_CONTEXT, mappings: [] }, null, 2)}\n`;

/** Write `input/default.input.json` in project `root` when it's missing; true if it was written. */
export async function ensureDefaultInputContext(fs: FileSystem, root: string): Promise<boolean> {
  if (!fs.canWrite) return false;
  const path = joinPath(root, DEFAULT_CONTEXT_PATH);
  if (await fs.exists(path)) return false;
  await fs.mkdir(joinPath(root, "input"));
  await fs.writeText(path, DEFAULT_CONTEXT_TEXT);
  return true;
}
