// Deleting assets and scripts from the Assets panel. The file goes from disk for good, so the
// editor asks first (unless told not to), listing what refers to it: scenes and prefabs (by
// `asset:` path or prefab path), other JSON files and scripts that quote it, the project settings (autoloads), and
// the open scene. Scenes, prefabs and project.json are then cleaned of it (assetReferences.ts):
// files on disk are rewritten, and the open scene is edited as one undo step (save to keep it).
// Scripts can't be cleaned automatically and are listed as still referring to it.
import { fileName } from "./assetBrowser";
import { closeScript, openScripts } from "./code/codeState";
import { assetUsers, removeReferences } from "./assetReferences";
import { assetDocumentsDeleted } from "./assetDocuments";
import { errorStatus } from "./messages";
import { askBeforeDeletingAssets } from "./preferences";
import { isWithin, type EditorProject } from "./projects";
import { reloadScripts } from "./session";
import { currentProject, docVersion, openScene, openScenes, playState, scriptsVersion, status } from "./state";
import { confirmInEditor } from "./ui/ConfirmDialog";

/** The scenes open in tabs, the active one first: none of them may be deleted or moved out from under the editor. */
export function openScenePaths(): string[] {
  const active = openScene.peek()?.path ?? null;
  const others = openScenes.peek().map((s) => s.path).filter((p) => p !== active);
  return active ? [active, ...others] : others;
}

/** `openPath` as a list, the active scene first (a single path is the active scene; no active scene: an empty first entry). */
function openPaths(openPath: string | readonly string[] | null): string[] {
  if (openPath === null) return [];
  return typeof openPath === "string" ? [openPath] : [...openPath];
}

/** Why `path` can't be deleted from `project` right now, or null if it can. */
export function whyNotDeletableAsset(project: EditorProject, path: string, openPath: string | readonly string[] | null): string | null {
  if (!project.canSave) return "this project is read-only";
  if (path === "project.json") return "project.json defines the project";
  const [active, ...others] = openPaths(openPath);
  if (path === active) return "it's the scene open now; open another scene first";
  if (others.includes(path)) return "it's open in another scene tab; close that tab first";
  if (playState.peek() !== "edit") return "stop playing first";
  if (!project.files.includes(path) && !project.scripts.has(path)) return "it's gone already";
  return null;
}

/** Folder entries in an asset selection end in "/" (`images/`); files don't. */
export const isFolderEntry = (entry: string) => entry.endsWith("/");
/** The project path of a selection entry: `images/` → `images`. */
export const entryPath = (entry: string) => (isFolderEntry(entry) ? entry.slice(0, -1) : entry);

/** The files (assets and scripts) in `folder`, at any depth. */
export function filesIn(project: EditorProject, folder: string): string[] {
  return [...project.files, ...project.scripts.keys()].filter((f) => isWithin(f, folder));
}

/** Why the folder `path` can't be deleted (or moved) right now, or null if it can. */
export function whyNotDeletableFolder(project: EditorProject, path: string, openPath: string | readonly string[] | null): string | null {
  if (!project.canSave) return "this project is read-only";
  if (path === "") return "it's the project folder";
  const [active, ...others] = openPaths(openPath);
  if (active && isWithin(active, path)) return `it holds the scene open now (${active}); open another scene first`;
  const tab = others.find((p) => isWithin(p, path));
  if (tab) return `it holds a scene open in another tab (${tab}); close that tab first`;
  if (playState.peek() !== "edit") return "stop playing first";
  if (!project.folders.includes(path)) return "it's gone already";
  return null;
}

/**
 * Delete an asset or script, asking first unless the user turned that off. Returns true if it was
 * deleted.
 */
export function deleteAsset(path: string): Promise<boolean> {
  return deleteAssets([path]);
}

/**
 * Delete files and folders (selection entries: folders end in "/"), asking first unless the user
 * turned that off; one question for all of them. References to the deleted files in scenes,
 * prefabs and project.json are removed, the open scene's as one undo step. Returns true if they
 * were deleted.
 */
export async function deleteAssets(entries: readonly string[]): Promise<boolean> {
  const project = currentProject.value;
  if (!project || entries.length === 0) return false;
  const scene = openScene.value;
  const why = (entry: string) =>
    isFolderEntry(entry) ? whyNotDeletableFolder(project, entryPath(entry), openScenePaths()) : whyNotDeletableAsset(project, entry, openScenePaths());
  for (const entry of entries) {
    const reason = why(entry);
    if (reason) {
      status.value = { kind: "info", text: `Can't delete ${fileName(entryPath(entry))}: ${reason}.` };
      return false;
    }
  }
  // Folders take their contents with them; a file inside a deleted folder needn't be deleted again.
  const folders = entries.filter(isFolderEntry).map(entryPath);
  const loose = entries.filter((e) => !isFolderEntry(e) && !folders.some((f) => isWithin(e, f)));
  const deleting = new Set([...loose, ...folders.flatMap((f) => filesIn(project, f))]);
  const open = scene && scene.stack.dirty ? { path: scene.path, text: JSON.stringify(scene.doc.toJSON()) } : null;
  const users = [...new Set([...deleting].flatMap((path) => assetUsers(project, path, open)))].filter((u) => !deleting.has(u));
  const name = entries.length === 1 ? fileName(entryPath(entries[0])) : `${entries.length} items`;
  if (askBeforeDeletingAssets.value) {
    const contents = folders.length > 0 ? ` ${deleting.size === 1 ? "1 file" : `${deleting.size} files`} in all.` : "";
    const answer = await confirmInEditor({
      title: `Delete ${name}?`,
      message:
        users.length > 0
          ? `It's deleted from disk, which can't be undone.${contents} ${users.length === 1 ? "This file uses it" : `These ${users.length} files use it`}: references in scenes, prefabs and project settings are removed (instances of it are deleted); scripts keep theirs.`
          : `It's deleted from disk, which can't be undone.${contents} Nothing in the project uses it.`,
      items: users,
      confirmLabel: "Delete",
      optionLabel: "Don't ask again",
    });
    if (!answer.ok) return false;
    if (answer.option) askBeforeDeletingAssets.value = false;
  }
  // Things may have changed while the dialog was open.
  if (currentProject.value !== project || entries.some((e) => why(e))) return false;
  const hadScript = [...deleting].some((p) => project.scripts.has(p));
  try {
    for (const folder of folders) await project.deleteFolder(folder);
    for (const path of loose) await project.deleteFile(path);
  } catch (err) {
    status.value = errorStatus(`Couldn't delete ${name}`, err);
    assetDocumentsDeleted([...deleting].filter((p) => !project.files.includes(p) && !project.scripts.has(p)));
    docVersion.value++;
    return false;
  }
  assetDocumentsDeleted([...loose, ...folders]); // open asset documents are dropped with their undo
  const cleaned = new Set<string>();
  const stack = openScene.value?.stack;
  stack?.beginGroup(`Remove references to ${name}`);
  try {
    for (const path of deleting) for (const f of await removeReferences(project, path, `Remove references to ${fileName(path)}`)) cleaned.add(f);
  } catch (err) {
    status.value = errorStatus(`Deleted ${name}, but couldn't remove references to it`, err);
    return true;
  } finally {
    stack?.endGroup();
  }
  // What's left: scripts, mostly. (The open scene's file changes when it's saved.)
  const remaining = [...new Set([...deleting].flatMap((path) => assetUsers(project, path)))].filter((u) => u !== openScene.value?.path);
  docVersion.value++; // the Assets panel lists the project's files
  scriptsVersion.value++;
  for (const path of deleting) if (openScripts.value.includes(path)) closeScript(path);
  if (hadScript) await reloadScripts();
  const label = entries.length === 1 ? entryPath(entries[0]) : `${entries.length} items`;
  const parts = [
    cleaned.size > 0 ? ` Removed references from ${[...cleaned].join(", ")}.` : "",
    remaining.length > 0 ? ` Still referred to by ${remaining.join(", ")}.` : "",
  ];
  status.value = {
    kind: "info",
    text: `Deleted ${label}.${parts.join("")}`,
    ...(entries.length > 1 || cleaned.size + remaining.length > 0
      ? {
          detail: [
            ...(entries.length > 1 ? entries.map((e) => `deleted: ${entryPath(e)}`) : []),
            ...[...cleaned].map((f) => `cleaned: ${f}`),
            ...remaining.map((f) => `still refers to it: ${f}`),
          ].join("\n"),
        }
      : {}),
    ...(askBeforeDeletingAssets.value
      ? {}
      : { action: { label: "Ask before deleting", run: () => (askBeforeDeletingAssets.value = true), done: "You'll be asked before an asset is deleted." } }),
  };
  return true;
}
