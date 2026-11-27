// New Action Set (ADR 0433), loaded when it's first used: writes a set with one button action under a free id
// (`game.New`, `game.New2`…) as `<last part>.actions.json` in the folder asked for, lists the file in project.json's
// `input.actionSets` (keeping the rest of the file's layout) so the boot defines it, and opens the Input dialog with
// the set's name selected for typing.
import type { ActionSetFile } from "../engine/input/actionAssets";
import { ACTION_SET_EXTENSION } from "../engine/input/actionAssets";
import { inputActionSets } from "../engine/editor";
import { actionSetFormat, newActionSet } from "./actionSetModel";
import { createProjectFile } from "./assetKindHost";
import { freeSetId } from "./inputDialogModel";
import { withMember } from "./jsonMember";
import { PROJECT_FILE } from "./projectPaths";
import { addActionSet, type SettingsDraft } from "./projectSettingsModel";
import type { EditorProject } from "./projects";
import { currentProject } from "./state";
import { openInputDialog } from "./ui/dialogState";
import { inputDialogRename } from "./ui/input/inputDialogIntent";

/** The ids of the sets the project's files define (whether listed or not). */
export function assetSetIds(project: EditorProject): string[] {
  return project.files.filter((f) => f.endsWith(ACTION_SET_EXTENSION)).flatMap((f) => {
    const v = project.assets.get(f) as Partial<ActionSetFile> | undefined;
    return typeof v?.id === "string" ? [v.id] : [];
  });
}

/** Add `path` to project.json's `input.actionSets` (no change when it's listed), keeping the rest of the file's layout. */
export async function listActionSet(project: EditorProject, path: string): Promise<void> {
  const text = project.textOf(PROJECT_FILE) ?? "{}\n";
  const json = JSON.parse(text) as SettingsDraft;
  const next = addActionSet({ input: json.input }, path);
  if (next.input === json.input) return;
  await project.writeText(PROJECT_FILE, withMember(text, "input", next.input));
}

/** The file name for a set id: its last part, lower-cased first letter (`game.New` → `new.actions.json`). */
export const actionSetFileName = (id: string): string => {
  const last = id.slice(id.lastIndexOf(".") + 1);
  return `${last[0].toLowerCase()}${last.slice(1)}${ACTION_SET_EXTENSION}`;
};

/** A free id for a new set: `base`, `base2`… that neither a file nor a defined set has. */
export function newSetId(project: EditorProject, base = "game.New"): string {
  return freeSetId([...assetSetIds(project), ...inputActionSets().map((s) => s.id)], base);
}

/**
 * Write a set file (default: a new set under a free id) in `folder`, named after its id, and list it in
 * `input.actionSets`. Its path, or null when nothing was written (read-only, a failed write).
 */
export async function writeActionSet(folder: string, value?: ActionSetFile): Promise<string | null> {
  const project = currentProject.peek();
  if (!project) return null;
  const set = value ?? newActionSet(newSetId(project));
  return createProjectFile({
    folder,
    name: actionSetFileName(set.id),
    what: "action sets",
    write: async (p, at) => {
      await p.writeText(at, actionSetFormat.format(set));
      await listActionSet(p, at);
    },
  });
}

/** New Action Set (see the file comment): the set written and listed, then shown in the Input dialog with its name selected. */
export async function createActionSet(folder: string): Promise<string | null> {
  const path = await writeActionSet(folder);
  if (!path) return null;
  inputDialogRename.value = path;
  openInputDialog(path);
  return path;
}

