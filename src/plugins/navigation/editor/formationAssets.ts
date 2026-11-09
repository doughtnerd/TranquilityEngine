// Formation assets in the editor (ADR 0065, Foxfire's NavFormation): creating `*.formation.json` files and reading
// them (the Assets panel and a NavGroup's inspector section use these). Editing goes through the formation's asset
// document (ADR 0134), made by the Navigation plugin's `formation` format (`src/plugins/navigation/editor/`).
import { defaultFormation, formatFormation, parseFormation, type NavFormationAsset } from "../../../engine/nav/formation";
import { editor, type EditorProject } from "../../../editor/sdk";

export interface ReadFormation {
  formation: NavFormationAsset;
  /** What's wrong with the file (bad values read as the defaults). */
  problems: string[];
}

/** A formation asset as the file holds it now. */
export function readFormation(project: EditorProject, path: string): ReadFormation {
  try {
    return parseFormation(project.assets.get(path), path);
  } catch (err) {
    return { formation: defaultFormation(), problems: [(err as Error).message] };
  }
}

/** Where New Formation goes by default: `navigation/` if the project has it, else the folder given. */
export function formationFolder(folder: string): string {
  return folder === "" && editor.project.current?.folders.includes("navigation") ? "navigation" : folder;
}

/**
 * Create `New Formation.formation.json` (or `… 2`) in `folder` (Create › Navigation › Formation): Foxfire's default,
 * a 16 × 16 mask with nothing painted, or `formation`. Returns its path, or null if the project is read-only or
 * writing failed.
 */
export async function createFormation(folder: string, formation: NavFormationAsset = defaultFormation(), name = "New Formation"): Promise<string | null> {
  return editor.project.createFile({ folder: formationFolder(folder), name: `${name}.formation.json`, what: "formations", write: (project, path) => project.writeText(path, formatFormation(formation)) });
}
