// Deleting assets and scripts from the Assets panel. The file goes from disk for good, so the
// editor asks first (unless told not to), listing what still refers to it: scenes and prefabs
// (by `asset:` path or prefab path), scripts that mention it, the project settings (autoloads),
// and the open scene's unsaved edits. Those show the asset as missing afterwards.
import { fileName } from "./assetBrowser";
import { closeScript, openScripts } from "./code/codeState";
import { errorStatus } from "./messages";
import { askBeforeDeletingAssets } from "./preferences";
import type { EditorProject } from "./projects";
import { reloadScripts } from "./session";
import { currentProject, docVersion, openScene, playState, scriptsVersion, status } from "./state";
import { confirmInEditor } from "./ui/ConfirmDialog";

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
          ? `It's deleted from disk, which can't be undone. ${users.length === 1 ? "This file still uses it" : `These ${users.length} files still use it`}, and will show it as missing:`
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
  docVersion.value++; // the Assets panel lists the project's files
  scriptsVersion.value++;
  if (openScripts.value.includes(path)) closeScript(path);
  if (wasScript) await reloadScripts();
  status.value = {
    kind: "info",
    text: `Deleted ${path}.${users.length > 0 ? ` ${users.length === 1 ? "1 file still refers" : `${users.length} files still refer`} to it: ${users.join(", ")}.` : ""}`,
    ...(users.length > 0 ? { detail: users.join("\n") } : {}),
    ...(askBeforeDeletingAssets.value
      ? {}
      : { action: { label: "Ask before deleting", run: () => (askBeforeDeletingAssets.value = true), done: "You'll be asked before an asset is deleted." } }),
  };
  return true;
}
