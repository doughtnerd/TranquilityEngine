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
import type { EditorProject } from "./projects";
import { reloadScripts } from "./session";
import { currentProject, docVersion, openScene, playState, scriptsVersion, status } from "./state";
import { confirmInEditor } from "./ui/ConfirmDialog";

const isSceneFile = (json: Record<string, unknown>): json is SceneFile & Record<string, unknown> =>
  typeof json.format === "string" && json.format.startsWith("tranquility.scene@") && Array.isArray(json.nodes);

/**
 * Take the deleted `path` out of the project's scenes, prefabs and settings: files on disk are
 * rewritten (keeping their layout), the open scene is edited as one undo step, and instances in
 * the open scene of a prefab that changed are rebuilt. Returns the files cleaned (the open scene
 * as "<path> (unsaved)").
 */
export async function removeReferences(project: EditorProject, path: string): Promise<string[]> {
  const scene = openScene.value;
  const cleaned: string[] = [];
  const mentions = (text: string | undefined) => !!text && (text.includes(`"${path}"`) || text.includes(`"asset:${path}"`));
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
  const quoted = [`"${path}"`, `"asset:${path}"`, `'${path}'`, `'asset:${path}'`];
  const mentions = (text: string | undefined) => !!text && quoted.some((q) => text.includes(q));
  const users = project.files.filter((f) => f !== path && f.endsWith(".json") && mentions(project.textOf(f)));
  for (const [script, text] of project.scripts) if (script !== path && mentions(text)) users.push(script);
  if (openDocument && openDocument.path !== path && mentions(openDocument.text) && !users.includes(openDocument.path)) users.push(`${openDocument.path} (unsaved edits)`);
  return users;
}

/**
 * Delete an asset or script, asking first unless the user turned that off. Returns true if it was
 * deleted.
 */
export async function deleteAsset(path: string): Promise<boolean> {
  const project = currentProject.value;
  if (!project) return false;
  const scene = openScene.value;
  const reason = whyNotDeletableAsset(project, path, scene?.path ?? null);
  if (reason) {
    status.value = { kind: "info", text: `Can't delete ${fileName(path)}: ${reason}.` };
    return false;
  }
  const open = scene && scene.stack.dirty ? { path: scene.path, text: JSON.stringify(scene.doc.toJSON()) } : null;
  const users = assetUsers(project, path, open);
  if (askBeforeDeletingAssets.value) {
    const answer = await confirmInEditor({
      title: `Delete ${fileName(path)}?`,
      message:
        users.length > 0
          ? `It's deleted from disk, which can't be undone. ${users.length === 1 ? "This file uses it" : `These ${users.length} files use it`}: references in scenes, prefabs and project settings are removed (instances of it are deleted); scripts keep theirs.`
          : "It's deleted from disk, which can't be undone. Nothing in the project uses it.",
      items: users,
      confirmLabel: "Delete",
      optionLabel: "Don't ask again",
    });
    if (!answer.ok) return false;
    if (answer.option) askBeforeDeletingAssets.value = false;
  }
  // Things may have changed while the dialog was open.
  if (currentProject.value !== project || whyNotDeletableAsset(project, path, openScene.value?.path ?? null)) return false;
  const wasScript = project.scripts.has(path);
  try {
    await project.deleteFile(path);
  } catch (err) {
    status.value = errorStatus(`Couldn't delete ${path}`, err);
    return false;
  }
  let cleaned: string[] = [];
  try {
    cleaned = await removeReferences(project, path);
  } catch (err) {
    status.value = errorStatus(`Deleted ${path}, but couldn't remove references to it`, err);
    return true;
  }
  // What's left: scripts, mostly. (The open scene's file changes when it's saved.)
  const remaining = assetUsers(project, path).filter((u) => u !== openScene.value?.path);
  docVersion.value++; // the Assets panel lists the project's files
  scriptsVersion.value++;
  if (openScripts.value.includes(path)) closeScript(path);
  if (wasScript) await reloadScripts();
  const parts = [
    cleaned.length > 0 ? ` Removed references from ${cleaned.join(", ")}.` : "",
    remaining.length > 0 ? ` Still referred to by ${remaining.join(", ")}.` : "",
  ];
  status.value = {
    kind: "info",
    text: `Deleted ${path}.${parts.join("")}`,
    ...(cleaned.length + remaining.length > 0
      ? { detail: [...cleaned.map((f) => `cleaned: ${f}`), ...remaining.map((f) => `still refers to it: ${f}`)].join("\n") }
      : {}),
    ...(askBeforeDeletingAssets.value
      ? {}
      : { action: { label: "Ask before deleting", run: () => (askBeforeDeletingAssets.value = true), done: "You'll be asked before an asset is deleted." } }),
  };
  return true;
}
