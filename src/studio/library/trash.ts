// The project's trash (owner decision 2, 2026-11-23; spec §4.5.2 "Delete … Undo"), the Studio asset library's delete
// (ADR 0445): a deleted file and the files that go with it (a take's notes, any import settings sidecar) move from the
// project folder into `.myco/trash/<n>/<path>`, a hidden folder, so the project no longer lists them; Undo moves them
// back. The project then reads the paths again (`rereadFiles`), so it drops them and, on Undo, serves them again, and
// `Assets.onChanged` listeners (the audio runtime) hear both. Nothing that refers to the files is rewritten, so Undo
// leaves the project as it was; their open documents are dropped with them, as the editor's delete does. The trash
// keeps the newest `TRASH_KEPT` deletions; older ones go when another is made.
import { isSidecarPath, sidecarPath } from "../../engine/scene/importSettings";
import { assetDocumentsDeleted } from "../../editor/assetDocuments";
import { openScenePaths, whyNotDeletableAsset } from "../../editor/assetDelete";
import { joinPath } from "../../editor/projectPaths";
import type { EditorProject } from "../../editor/projects";
import { docVersion } from "../../editor/state";

/** The project's trash, under its per-machine folder. */
const TRASH_FOLDER = ".myco/trash";
/** How many deletions the trash keeps. */
const TRASH_KEPT = 20;

/** A deletion: where each file went. */
export interface TrashedFiles {
  /** This deletion's folder in the trash (project-relative). */
  readonly folder: string;
  /** Each file and where it is in the trash, project-relative. */
  readonly files: readonly { readonly path: string; readonly trashed: string }[];
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

function disk(project: EditorProject): { fs: NonNullable<EditorProject["fileSystem"]>; root: string } | null {
  return project.canSave && project.fileSystem && project.root ? { fs: project.fileSystem, root: project.root } : null;
}

/** `paths` with each one's import settings sidecar after it, where the project has one. */
export function withSidecars(project: EditorProject, paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (!out.includes(p)) out.push(p);
    const side = sidecarPath(p);
    if (!isSidecarPath(p) && project.files.includes(side) && !out.includes(side)) out.push(side);
  }
  return out;
}

/** Why `paths` can't go to the trash now (read-only, playing, gone, no project folder), or null. */
export function whyNotTrashable(project: EditorProject, paths: readonly string[]): string | null {
  const why = paths.map((p) => whyNotDeletableAsset(project, p, openScenePaths())).find((w) => w !== null);
  if (why) return why;
  return disk(project) ? null : "only a project folder has a trash";
}

/** Move `paths` (the first is the one the user deleted) into the trash; the project stops listing them. */
export async function trashFiles(project: EditorProject, paths: readonly string[]): Promise<{ trashed: TrashedFiles } | { refused: string }> {
  const why = whyNotTrashable(project, paths);
  const d = disk(project);
  if (why || !d) return { refused: why ?? "only a project folder has a trash" };
  const { fs, root } = d;
  const trash = joinPath(root, TRASH_FOLDER);
  await fs.mkdir(trash);
  const numbers = (await fs.list(trash).catch(() => [])).map((e) => Number(e.name)).filter((n) => Number.isInteger(n) && n > 0);
  const n = Math.max(0, ...numbers) + 1;
  for (const old of numbers) if (old <= n - TRASH_KEPT) await fs.remove(joinPath(trash, String(old)), { recursive: true }).catch(() => undefined);
  const folder = `${TRASH_FOLDER}/${n}`;
  const files = paths.map((p) => ({ path: p, trashed: `${folder}/${p}` }));
  for (const f of files) {
    await fs.mkdir(joinPath(root, dirOf(f.trashed)));
    await fs.rename(joinPath(root, f.path), joinPath(root, f.trashed));
  }
  await assetDocumentsDeleted(paths);
  await project.rereadFiles(paths);
  docVersion.value++;
  return { trashed: { folder, files } };
}

/** Undo a delete: move the files back where they were. Refused when something has taken a name meanwhile. */
export async function restoreFiles(project: EditorProject, t: TrashedFiles): Promise<{ restored: string } | { refused: string }> {
  const d = disk(project);
  if (!d) return { refused: "the project can't be saved to" };
  const { fs, root } = d;
  for (const f of t.files) {
    if (project.files.includes(f.path) || (await fs.exists(joinPath(root, f.path)))) return { refused: `${nameOf(f.path)} is there again` };
    if (!(await fs.exists(joinPath(root, f.trashed)))) return { refused: `${nameOf(f.path)} is no longer in the trash` };
  }
  for (const f of t.files) {
    const folder = dirOf(f.path);
    if (folder) await fs.mkdir(joinPath(root, folder));
    await fs.rename(joinPath(root, f.trashed), joinPath(root, f.path));
  }
  await fs.remove(joinPath(root, t.folder), { recursive: true }).catch(() => undefined);
  await project.rereadFiles(t.files.map((f) => f.path));
  docVersion.value++;
  return { restored: t.files[0]!.path };
}
