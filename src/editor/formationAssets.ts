// Formation assets in the editor (ADR 0065, Foxfire's NavFormation): creating `*.formation.json` files, reading
// them, and writing edits from the Inspector's formation editor (ui/NavFormationInspector.tsx) one after another,
// each recorded in the formation's undo history for the session.
import { defaultFormation, formatFormation, parseFormation, type NavFormationAsset } from "../engine/nav/formation";
import { fileName } from "./assetBrowser";
import { freePath } from "./assetOps";
import { createGraphHistory } from "./graph/history";
import { errorStatus } from "./messages";
import type { EditorProject } from "./projects";
import { currentProject, docVersion, status } from "./state";

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

/** Each formation's writes in progress, so quick edits (a paint drag) apply one after another. */
const writing = new Map<string, Promise<unknown>>();

/** Write a formation asset after the writes before it. Throws for a read-only project. */
export function writeFormation(project: EditorProject, path: string, formation: NavFormationAsset): Promise<void> {
  const text = formatFormation(formation);
  const run = () => project.writeText(path, text);
  const result = (writing.get(path) ?? Promise.resolve()).then(run, run);
  const settled = result.catch(() => undefined);
  writing.set(path, settled);
  void settled.then(() => writing.get(path) === settled && writing.delete(path));
  return result;
}

const histories = createGraphHistory<NavFormationAsset>();

/** A formation's undo history this session. */
export const formationHistory = (path: string) => histories.get(path);

/**
 * Apply an edit: `next` is written (and shown at once through `docVersion`), and `before` becomes the state to undo
 * to. `record: false` writes without a new undo step (the rest of a paint drag, recorded at its start).
 */
export async function editFormation(project: EditorProject, path: string, before: NavFormationAsset, next: NavFormationAsset, record = true): Promise<void> {
  if (next === before) return;
  if (!project.canSave) {
    status.value = { kind: "info", text: `${project.name} is read-only. Open a project folder (or copy the sample) to edit formations.` };
    return;
  }
  if (record) histories.record(path, before);
  await save(project, path, next);
}

/** Undo the formation's last edit (false with nothing to undo). */
export async function undoFormation(project: EditorProject, path: string): Promise<boolean> {
  const prev = histories.undo(path, readFormation(project, path).formation);
  if (!prev) return false;
  await save(project, path, prev);
  return true;
}

/** Redo the formation's last undone edit (false with nothing to redo). */
export async function redoFormation(project: EditorProject, path: string): Promise<boolean> {
  const next = histories.redo(path, readFormation(project, path).formation);
  if (!next) return false;
  await save(project, path, next);
  return true;
}

async function save(project: EditorProject, path: string, formation: NavFormationAsset): Promise<void> {
  try {
    const write = writeFormation(project, path, formation);
    docVersion.value++;
    await write;
    docVersion.value++;
  } catch (err) {
    status.value = errorStatus(`Couldn't save ${fileName(path)}`, err);
  }
}

/** Where New Formation goes by default: `navigation/` if the project has it, else the folder given. */
export function formationFolder(folder: string): string {
  return folder === "" && currentProject.value?.folders.includes("navigation") ? "navigation" : folder;
}

/**
 * Create `New Formation.formation.json` (or `… 2`) in `folder` (Create › Navigation › Formation): Foxfire's default,
 * a 16 × 16 mask with nothing painted, or `formation`. Returns its path, or null if the project is read-only or
 * writing failed.
 */
export async function createFormation(folder: string, formation: NavFormationAsset = defaultFormation(), name = "New Formation"): Promise<string | null> {
  const project = currentProject.value;
  if (!project) return null;
  if (!project.canSave) {
    status.value = { kind: "info", text: `${project.name} is read-only. Open a project folder (or copy the sample) to add formations.` };
    return null;
  }
  const path = freePath(project, formationFolder(folder), `${name}.formation.json`);
  try {
    await writeFormation(project, path, formation);
  } catch (err) {
    status.value = errorStatus(`Couldn't create ${path}`, err);
    return null;
  }
  docVersion.value++;
  status.value = { kind: "info", text: `Created ${fileName(path)}.` };
  return path;
}
