// Deleting a sample (owner decision 2, 2026-11-23): the file goes from the project folder into the project's trash,
// `.myco/trash/<n>/<path>` (a hidden folder, so the project no longer lists it), with its sidecar, and the toast's Undo
// moves both back. Samples are files (ground rules), so this acts on the disk through the project's own file system;
// the project then reads the paths again (`rereadFiles`), so it drops them and, on Undo, serves them again, and
// `Assets.onChanged` listeners (the audio runtime) hear both. Nothing that refers to the sample is rewritten, so Undo
// leaves the project as it was. What doesn't come back: the sample's edit history (its document is dropped with the
// file, as the editor's delete does); its edits themselves are in the restored sidecar.
//
// The trash keeps the newest `TRASH_KEPT` deletions; older ones are removed when a sample is deleted.
import { isSidecarPath, sidecarPath } from "../../../engine/scene/importSettings";
import { assetDocumentsDeleted } from "../../../editor/assetDocuments";
import { openScenePaths, whyNotDeletableAsset } from "../../../editor/assetDelete";
import { joinPath } from "../../../editor/projectPaths";
import type { EditorProject } from "../../../editor/projects";
import { docVersion } from "../../../editor/state";
import { nameOf } from "./sampleLibrary";
import { forgetAudio, forgetSession, sampleSession } from "./sampleSession";

/** The project's trash, under its per-machine folder. */
export const TRASH_FOLDER = ".myco/trash";
/** How many deletions the trash keeps. */
export const TRASH_KEPT = 20;

/** A deleted sample: where each of its files went. */
export interface TrashedSample {
  /** The sample's path. */
  readonly path: string;
  /** This deletion's folder in the trash (project-relative). */
  readonly folder: string;
  /** Each file (the sample, its sidecar) and where it is in the trash, project-relative. */
  readonly files: readonly { readonly path: string; readonly trashed: string }[];
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

function disk(project: EditorProject): { fs: NonNullable<EditorProject["fileSystem"]>; root: string } | null {
  return project.canSave && project.fileSystem && project.root ? { fs: project.fileSystem, root: project.root } : null;
}

/** Why `path` can't be deleted now (read-only, playing, gone, no project folder), or null. */
export function whyNotTrashable(project: EditorProject, path: string): string | null {
  const gate = whyNotDeletableAsset(project, path, openScenePaths());
  if (gate) return gate;
  if (!disk(project)) return "only a project folder has a trash";
  return null;
}

/** Move the sample `path` and its sidecar into the trash; the project stops listing them. */
export async function trashSample(project: EditorProject, path: string): Promise<{ trashed: TrashedSample } | { refused: string }> {
  const why = whyNotTrashable(project, path);
  const d = disk(project);
  if (why || !d) return { refused: why ?? "only a project folder has a trash" };
  const { fs, root } = d;
  // An edit still waiting to be written goes into the file first, so it comes back with it.
  await sampleSession(project, path).flush();
  const trash = joinPath(root, TRASH_FOLDER);
  await fs.mkdir(trash);
  const numbers = (await fs.list(trash).catch(() => [])).map((e) => Number(e.name)).filter((n) => Number.isInteger(n) && n > 0);
  const n = Math.max(0, ...numbers) + 1;
  for (const old of numbers) if (old <= n - TRASH_KEPT) await fs.remove(joinPath(trash, String(old)), { recursive: true }).catch(() => undefined);
  const folder = `${TRASH_FOLDER}/${n}`;
  const sidecar = sidecarPath(path);
  const paths = [path, ...(!isSidecarPath(path) && project.files.includes(sidecar) ? [sidecar] : [])];
  const files = paths.map((p) => ({ path: p, trashed: `${folder}/${p}` }));
  forgetAudio(project, path);
  for (const f of files) {
    await fs.mkdir(joinPath(root, dirOf(f.trashed)));
    await fs.rename(joinPath(root, f.path), joinPath(root, f.trashed));
  }
  await assetDocumentsDeleted(paths);
  forgetSession(project, path);
  await project.rereadFiles(paths);
  docVersion.value++;
  return { trashed: { path, folder, files } };
}

/** Undo a delete: move the sample and its sidecar back where they were. Refused when something has taken the name. */
export async function restoreSample(project: EditorProject, t: TrashedSample): Promise<{ restored: string } | { refused: string }> {
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
  return { restored: t.path };
}
