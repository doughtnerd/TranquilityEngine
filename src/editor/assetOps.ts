// File operations in the Assets panel: renaming, moving (dragging onto a folder, or cut and
// paste), duplicating and copying, and new folders. Renames and moves update what refers to the
// files: scenes, prefabs and project.json are rewritten (the open scene as one undo step, kept
// when it's saved), and instances of a changed prefab in the open scene are rebuilt. Scripts
// aren't edited, so ones that mention a moved file are listed. Deleting is in assetDelete.ts.
// A file's import settings sidecar (`<file>.meta.json`, ADR 0040) moves, copies and deletes with
// it (projects.ts), and references to its slices (`<file>#<slice>`) are updated like the file's.
import { signal } from "@preact/signals";
import { isSidecarPath, sidecarAsset } from "../engine/scene/importSettings";
import { fileName, folderOf } from "./assetBrowser";
import { withMovedAssets } from "./assetCleanup";
import { assetDocumentsMoved } from "./assetDocuments";
import { assetUsers, entryPath, filesIn, isFolderEntry, openScenePaths, whyNotDeletableAsset, whyNotDeletableFolder } from "./assetDelete";
import { activeScript, dirtyScripts, openScripts } from "./code/codeState";
import { ReplaceDocument, type SceneFile } from "./document";
import { errorStatus } from "./messages";
import { instancesOf } from "./prefabs";
import { writeSceneFile } from "./project";
import { isWithin, type EditorProject } from "./projects";
import { isScriptPath } from "./scriptLoader";
import { reloadScripts } from "./session";
import { currentProject, docVersion, openScene, scriptsVersion, status } from "./state";
import { freePath, taken } from "./freePath";

export { freePath, splitExtension } from "./freePath";

/** Files and folders copied or cut in the Assets panel (selection entries: folders end in "/"). */
export const assetClipboard = signal<{ entries: string[]; cut: boolean } | null>(null);

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/** Why `name` can't be a file or folder name, or null if it can. */
export function whyNotValidName(name: string): string | null {
  if (name.trim() === "") return "a name can't be empty";
  if (name !== name.trim()) return "a name can't start or end with a space";
  if (/[\\/:*?"<>|]/.test(name)) return 'a name can\'t contain \\ / : * ? " < > |';
  if (name === "." || name === "..") return `"${name}" isn't a name`;
  return null;
}

/** Why `entry` can't be moved or renamed right now, or null if it can. */
function whyNotMovable(project: EditorProject, entry: string): string | null {
  const openPath = openScenePaths();
  const path = entryPath(entry);
  const reason = isFolderEntry(entry) ? whyNotDeletableFolder(project, path, openPath) : whyNotDeletableAsset(project, path, openPath);
  if (reason) return reason.replace("open another scene first", "open another scene to move it");
  const unsaved = [...dirtyScripts.value].find((p) => isWithin(p, path));
  if (unsaved) return `${unsaved} has unsaved changes in the Code panel; save or close it first`;
  return null;
}

/** Why moving the scripts in `moves` would take one out of scripts/, or null. */
function whyNotScriptMove(project: EditorProject, moves: readonly (readonly [string, string])[]): string | null {
  for (const [from, to] of moves) {
    for (const script of project.scripts.keys()) {
      if (!isWithin(script, from)) continue;
      if (!isScriptPath(to + script.slice(from.length))) return `${script} is a script, and scripts live under scripts/`;
    }
  }
  return null;
}

/**
 * Rename or move files and folders: each pair is a project path and its new path (a folder moves
 * with everything in it). Checks them all first, then moves them on disk and updates references.
 * Returns true if they moved.
 */
export async function moveAssets(moves: readonly (readonly [string, string])[], verb = "Moved"): Promise<boolean> {
  const project = currentProject.value;
  moves = moves.filter(([from, to]) => from !== to);
  if (!project || moves.length === 0) return false;
  const fail = (text: string) => {
    status.value = { kind: "info", text };
    return false;
  };
  for (const [from, to] of moves) {
    const reason = whyNotMovable(project, project.folders.includes(from) ? `${from}/` : from);
    if (reason) return fail(`Can't move ${fileName(from)}: ${reason}.`);
    if (isWithin(to, from)) return fail(`Can't move ${fileName(from)} into itself.`);
    if (taken(project, to)) return fail(`Can't move ${fileName(from)}: ${to} already exists.`);
  }
  const scriptProblem = whyNotScriptMove(project, moves);
  if (scriptProblem) return fail(`Can't move: ${scriptProblem}.`);

  const movedScripts = moves.some(([from]) => [...project.scripts.keys()].some((s) => isWithin(s, from)));
  const done: [string, string][] = [];
  try {
    for (const [from, to] of moves) {
      await project.move(from, to);
      done.push([from, to]);
    }
  } catch (err) {
    status.value = errorStatus(`Couldn't move ${fileName(moves[done.length][0])}`, err);
    assetDocumentsMoved(done);
    if (done.length > 0) await updateReferences(project, done);
    docVersion.value++;
    return false;
  }
  assetDocumentsMoved(done); // open asset documents and their undo follow their files
  const { cleaned, scriptUsers } = await updateReferences(project, done);
  // Open Code tabs follow their files.
  const rename = renamer(done);
  if (openScripts.value.some((p) => rename(p) !== null)) {
    openScripts.value = openScripts.value.map((p) => rename(p) ?? p);
    if (activeScript.value) activeScript.value = rename(activeScript.value) ?? activeScript.value;
  }
  docVersion.value++;
  scriptsVersion.value++;
  if (movedScripts) await reloadScripts();
  const label = done.length === 1 ? `${done[0][0]} to ${done[0][1]}` : `${done.length} items`;
  const parts = [
    cleaned.length > 0 ? ` Updated references in ${cleaned.join(", ")}.` : "",
    scriptUsers.length > 0 ? ` Scripts that mention the old path weren't changed: ${scriptUsers.join(", ")}.` : "",
  ];
  status.value = {
    kind: "info",
    text: `${verb} ${label}.${parts.join("")}`,
    ...(done.length > 1 || cleaned.length > 0
      ? { detail: [...done.map(([f, t]) => `${f} → ${t}`), ...cleaned.map((f) => `updated: ${f}`)].join("\n") }
      : {}),
  };
  return true;
}

/** A path's new path under `moves` (folders move what's in them), or null if it didn't move. */
function renamer(moves: readonly (readonly [string, string])[]): (path: string) => string | null {
  return (path) => {
    for (const [from, to] of moves) if (isWithin(path, from)) return to + path.slice(from.length);
    return null;
  };
}

/**
 * Point references at the moved files' new paths: scene and prefab files and project.json on
 * disk, and the open scene (one undo step). Returns the files updated and the scripts that still
 * mention an old path.
 */
async function updateReferences(project: EditorProject, moves: readonly (readonly [string, string])[]): Promise<{ cleaned: string[]; scriptUsers: string[] }> {
  const rename = renamer(moves);
  const scene = openScene.value;
  const cleaned: string[] = [];
  const mentions = (text: string) => moves.some(([from]) => text.includes(`"${from}`) || text.includes(`"asset:${from}`));
  for (const file of project.files) {
    const text = file.endsWith(".json") && file !== scene?.path ? project.textOf(file) : undefined;
    if (text === undefined || !mentions(text)) continue;
    const json = JSON.parse(text) as Record<string, unknown>;
    const result = withMovedAssets(json, rename);
    if (!result.changed) continue;
    if (typeof json.format === "string" && /^(myco|tranquility)\.scene@/.test(json.format)) {
      await writeSceneFile(project, file, result.value as unknown as SceneFile);
      if (scene) scene.sync.apply(instancesOf(scene.doc, file).map((node) => ({ kind: "rebuild", node }) as const));
    } else {
      await project.writeText(file, `${JSON.stringify(result.value, null, 2)}\n`);
    }
    cleaned.push(file);
  }
  if (scene) {
    const result = withMovedAssets(scene.doc.toJSON(), rename);
    if (result.changed) {
      scene.stack.execute(new ReplaceDocument(result.value, `Update references to ${moves.length === 1 ? fileName(moves[0][1]) : `${moves.length} moved files`}`));
      cleaned.push(`${scene.path} (unsaved)`);
    }
  }
  const scriptUsers = [...new Set(moves.flatMap(([from]) => assetUsers(project, from)))].filter((u) => project.scripts.has(u));
  return { cleaned, scriptUsers };
}

/**
 * Point references to renamed slices of `image` (ADR 0040) at their new names: each pair is an
 * old and a new slice name. Like a file move: scenes, prefabs and project.json are rewritten and
 * the open scene changes as one undo step. Returns the files updated.
 */
export async function renameSliceReferences(project: EditorProject, image: string, renames: readonly (readonly [string, string])[]): Promise<string[]> {
  const moves = renames.filter(([a, b]) => a !== b).map(([a, b]) => [`${image}#${a}`, `${image}#${b}`] as const);
  if (moves.length === 0) return [];
  const { cleaned } = await updateReferences(project, moves);
  docVersion.value++;
  return cleaned;
}

/** Rename a file or folder (a selection entry) to `name` in the same folder. */
export async function renameAsset(entry: string, name: string): Promise<boolean> {
  const path = entryPath(entry);
  if (name === fileName(path)) return false;
  const reason = whyNotValidName(name);
  if (reason) {
    status.value = { kind: "info", text: `Can't rename ${fileName(path)}: ${reason}.` };
    return false;
  }
  return moveAssets([[path, join(folderOf(path), name)]], "Renamed");
}

/** Move selection entries into `folder` (project-relative, "" = the root). */
export function moveAssetsTo(entries: readonly string[], folder: string): Promise<boolean> {
  // Entries inside another moved folder go with it.
  const paths = entries.map(entryPath);
  const top = paths.filter((p) => !paths.some((q) => q !== p && isWithin(p, q)));
  return moveAssets(top.filter((p) => folderOf(p) !== folder).map((p) => [p, join(folder, fileName(p))] as const));
}

/** Why `folder` can't be a drop target for `entries`, or null if it can. */
export function whyNotMoveTarget(entries: readonly string[], folder: string): string | null {
  for (const entry of entries) {
    const path = entryPath(entry);
    if (isFolderEntry(entry) && isWithin(folder, path)) return `${fileName(path)} can't go inside itself`;
  }
  if (entries.every((e) => folderOf(entryPath(e)) === folder)) return "they're in that folder already";
  return null;
}

/** Create a folder named "New Folder" (or "New Folder 2"…) in `parent`. Returns its path. */
export async function newFolder(parent: string): Promise<string | null> {
  const project = currentProject.value;
  if (!project?.canSave) return null;
  const path = freePath(project, parent, "New Folder");
  try {
    await project.createFolder(path);
  } catch (err) {
    status.value = errorStatus(`Couldn't create ${path}`, err);
    return null;
  }
  docVersion.value++;
  status.value = { kind: "info", text: `Created ${path}.` };
  return path;
}

/**
 * Copy selection entries into `folder` (a folder copies everything in it); names that are taken
 * get " copy" (and a number). Returns the new entries.
 */
export async function copyAssets(entries: readonly string[], folder: string): Promise<string[]> {
  const project = currentProject.value;
  if (!project?.canSave || entries.length === 0) return [];
  const made: string[] = [];
  try {
    for (const entry of entries) {
      const path = entryPath(entry);
      if (isFolderEntry(entry)) {
        if (isWithin(folder, path)) throw new Error(`can't copy ${fileName(path)} into itself`);
        const target = freePath(project, folder, fileName(path), true);
        // Sidecars come with their files (ADR 0040); only strays are copied on their own.
        const all = filesIn(project, path);
        const inside = all.filter((f) => !isSidecarPath(f) || !all.includes(sidecarAsset(f)));
        await project.createFolder(target);
        for (const f of project.folders.filter((d) => isWithin(d, path) && d !== path)) await project.createFolder(target + f.slice(path.length));
        for (const f of inside) await project.copyFile(f, target + f.slice(path.length));
        made.push(`${target}/`);
      } else {
        const target = freePath(project, folder, fileName(path), true);
        if (project.scripts.has(path) && !isScriptPath(target)) throw new Error(`${path} is a script, and scripts live under scripts/`);
        await project.copyFile(path, target);
        made.push(target);
      }
    }
  } catch (err) {
    status.value = errorStatus(`Couldn't copy ${made.length === 0 ? fileName(entryPath(entries[0])) : "everything"}`, err);
  }
  docVersion.value++;
  scriptsVersion.value++;
  if (made.some((e) => [...project.scripts.keys()].some((s) => isWithin(s, entryPath(e))))) await reloadScripts();
  if (made.length > 0 && status.value?.kind !== "error") {
    status.value = { kind: "info", text: made.length === 1 ? `Copied to ${entryPath(made[0])}.` : `Copied ${made.length} items to ${folder || "the project folder"}.` };
  }
  return made;
}

/** Duplicate selection entries beside themselves. Returns the new entries. */
export async function duplicateAssets(entries: readonly string[]): Promise<string[]> {
  const made: string[] = [];
  for (const entry of entries) made.push(...(await copyAssets([entry], folderOf(entryPath(entry)))));
  return made;
}

/** Paste the clipboard into `folder`: copies, or moves after a cut. Returns the pasted entries. */
export async function pasteAssets(folder: string): Promise<string[]> {
  const clip = assetClipboard.value;
  const project = currentProject.value;
  if (!clip || !project) return [];
  if (!clip.cut) return copyAssets(clip.entries, folder);
  const reason = whyNotMoveTarget(clip.entries, folder);
  if (reason) {
    status.value = { kind: "info", text: `Can't paste here: ${reason}.` };
    return [];
  }
  if (!(await moveAssetsTo(clip.entries, folder))) return [];
  assetClipboard.value = null;
  return clip.entries.map((e) => `${join(folder, fileName(entryPath(e)))}${isFolderEntry(e) ? "/" : ""}`);
}
