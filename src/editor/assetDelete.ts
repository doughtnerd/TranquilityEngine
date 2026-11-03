// Deleting assets and scripts from the Assets panel. The file goes from disk for good, so the
// editor asks first (unless told not to), listing what refers to it: scenes and prefabs (by
// `asset:` path or prefab path), scripts that mention it, the project settings (autoloads), and
// the open scene. Scenes, prefabs and project.json are then cleaned of it (assetCleanup.ts):
// files on disk are rewritten, and the open scene is edited as one undo step (save to keep it).
// Scripts can't be cleaned automatically and are listed as still referring to it.
import { fileName } from "./assetBrowser";
import { closeScript, openScripts } from "./code/codeState";
import { sceneWithoutAsset, settingsWithoutAsset } from "./assetCleanup";
import { ReplaceDocument, type SceneFile } from "./document";
import { errorStatus } from "./messages";
import { instancesOf } from "./prefabs";
import { writeSceneFile } from "./project";
import { askBeforeDeletingAssets } from "./preferences";
import { isWithin, type EditorProject } from "./projects";
import { reloadScripts } from "./session";
import { currentProject, docVersion, openScene, playState, scriptsVersion, status } from "./state";
import { confirmInEditor } from "./ui/ConfirmDialog";

const isSceneFile = (json: Record<string, unknown>): json is SceneFile & Record<string, unknown> =>
  typeof json.format === "string" && /^(myco|tranquility)\.scene@/.test(json.format) && Array.isArray(json.nodes);

/**
 * Take the deleted `path` out of the project's scenes, prefabs and settings: files on disk are
 * rewritten (keeping their layout), the open scene is edited as one undo step, and instances in
 * the open scene of a prefab that changed are rebuilt. Returns the files cleaned (the open scene
 * as "<path> (unsaved)").
 */
export async function removeReferences(project: EditorProject, path: string): Promise<string[]> {
  const scene = openScene.value;
  const cleaned: string[] = [];
  // Slice references (`"asset:images/sheet.png#walk_0"`, ADR 0040) count too.
  const mentions = (text: string | undefined) => !!text && [`"${path}"`, `"asset:${path}"`, `"${path}#`, `"asset:${path}#`].some((q) => text.includes(q));
  for (const file of project.files) {
    if (!file.endsWith(".json") || file === scene?.path || !mentions(project.textOf(file))) continue;
    const json = JSON.parse(project.textOf(file)!) as Record<string, unknown>;
    if (isSceneFile(json)) {
      // Scenes and prefabs share the format.
      const result = sceneWithoutAsset(json, path);
      if (!result.changed) continue;
      await writeSceneFile(project, file, result.file);
      cleaned.push(file);
      // Instances of a changed prefab in the open scene show its new contents.
      if (scene) scene.sync.apply(instancesOf(scene.doc, file).map((node) => ({ kind: "rebuild", node }) as const));
    } else if (file === "project.json") {
      const result = settingsWithoutAsset(json, path);
      if (!result.changed) continue;
      await project.writeText(file, `${JSON.stringify(result.settings, null, 2)}\n`);
      cleaned.push(file);
    }
  }
  if (scene) {
    const result = sceneWithoutAsset(scene.doc.toJSON(), path);
    if (result.changed) {
      scene.stack.execute(new ReplaceDocument(result.file, `Remove references to ${fileName(path)}`));
      cleaned.push(`${scene.path} (unsaved)`);
    }
  }
  return cleaned;
}

/** Why `path` can't be deleted from `project` right now, or null if it can. */
export function whyNotDeletableAsset(project: EditorProject, path: string, openPath: string | null): string | null {
  if (!project.canSave) return "this project is read-only";
  if (path === "project.json") return "project.json defines the project";
  if (path === openPath) return "it's the scene open now; open another scene first";
  if (playState.peek() !== "edit") return "stop playing first";
  if (!project.files.includes(path) && !project.scripts.has(path)) return "it's gone already";
  return null;
}

/**
 * The files that still refer to `path`: JSON files (scenes, prefabs, settings) and scripts whose
 * text contains it as a quoted path (`"images/a.png"`, `"asset:images/a.png"`), plus the open
 * scene's unsaved document, if it does.
 */
export function assetUsers(project: EditorProject, path: string, openDocument?: { path: string; text: string } | null): string[] {
  const quoted = [`"${path}"`, `"asset:${path}"`, `'${path}'`, `'asset:${path}'`, `"${path}#`, `"asset:${path}#`, `'${path}#`, `'asset:${path}#`]; // with slices (ADR 0040)
  const mentions = (text: string | undefined) => !!text && quoted.some((q) => text.includes(q));
  const users = project.files.filter((f) => f !== path && f.endsWith(".json") && mentions(project.textOf(f)));
  for (const [script, text] of project.scripts) if (script !== path && mentions(text)) users.push(script);
  if (openDocument && openDocument.path !== path && mentions(openDocument.text) && !users.includes(openDocument.path)) users.push(`${openDocument.path} (unsaved edits)`);
  return users;
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
export function whyNotDeletableFolder(project: EditorProject, path: string, openPath: string | null): string | null {
  if (!project.canSave) return "this project is read-only";
  if (path === "") return "it's the project folder";
  if (openPath && isWithin(openPath, path)) return `it holds the scene open now (${openPath}); open another scene first`;
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
    isFolderEntry(entry) ? whyNotDeletableFolder(project, entryPath(entry), scene?.path ?? null) : whyNotDeletableAsset(project, entry, scene?.path ?? null);
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
    docVersion.value++;
    return false;
  }
  const cleaned = new Set<string>();
  const stack = openScene.value?.stack;
  stack?.beginGroup(`Remove references to ${name}`);
  try {
    for (const path of deleting) for (const f of await removeReferences(project, path)) cleaned.add(f);
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
