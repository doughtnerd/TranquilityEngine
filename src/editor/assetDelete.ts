// Deleting assets and scripts from the Assets panel. The file goes from disk for good, so the
// editor asks first (unless told not to), listing what refers to it: scenes and prefabs (by
// `asset:` path or prefab path), other JSON files, files whose kind reads them as naming it (an .mtl's textures,
// ADR 0302) and scripts that quote it, the project settings (autoloads), and
// the open scene. Scenes, prefabs and project.json are then cleaned of it (assetReferences.ts):
// files on disk are rewritten, and the open scene is edited as one undo step (save to keep it).
// Other files (scripts, asset and model files) keep their references and are listed as still referring to it.
// A deleted file's Code panel tab closes, and the question names unsaved text that goes with it (ADR 0308).
import { fileName } from "./assetBrowser";
import { entryPath, isFolderEntry } from "./assetEntry";
import { codeBuffersDeleted, unsavedWithin } from "./code/codeBuffers";
import { assetUsers, removeReferences } from "./assetReferences";
import { assetDocumentsDeleted } from "./assetDocuments";
import { errorStatus } from "./messages";
import { askBeforeDeletingAssets } from "./preferences";
import { isWithin, type EditorProject } from "./projects";
import { reloadScripts } from "./session";
import { currentProject, docVersion, openScene, openScenes, scriptsVersion, status } from "./state";
import { whyNotEdit } from "./editGate";
import { DEFAULT_CONTEXT_PATH } from "../engine/input/contexts";
import { confirmInEditor } from "./ui/ConfirmDialog";
import { beginUndoStep } from "./undoStep";

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

/** Why `path` is the project's default input context, which stays where it is (ADR 0417); null for any other path. */
const defaultContextReason = (path: string): string | null =>
  path === DEFAULT_CONTEXT_PATH ? `${DEFAULT_CONTEXT_PATH} is the project's default input context; it can't be moved, renamed or deleted` : null;

/** Why `path` can't be deleted from `project` right now, or null if it can. */
export function whyNotDeletableAsset(project: EditorProject, path: string, openPath: string | readonly string[] | null): string | null {
  const gate = whyNotEdit({ kind: "project-files", project, removes: true }, "delete files"); // read-only, play (ADR 0247)
  if (gate) return gate;
  if (path === "project.json") return "project.json defines the project";
  const fixed = defaultContextReason(path);
  if (fixed) return fixed;
  const [active, ...others] = openPaths(openPath);
  if (path === active) return "it's the scene open now; open another scene first";
  if (others.includes(path)) return "it's open in another scene tab; close that tab first";
  if (!project.files.includes(path) && !project.scripts.has(path)) return "it's gone already";
  return null;
}

/** The files (assets and scripts) in `folder`, at any depth. */
export function filesIn(project: EditorProject, folder: string): string[] {
  return [...project.files, ...project.scripts.keys()].filter((f) => isWithin(f, folder));
}

/** Why the folder `path` can't be deleted (or moved) right now, or null if it can. */
export function whyNotDeletableFolder(project: EditorProject, path: string, openPath: string | readonly string[] | null): string | null {
  const gate = whyNotEdit({ kind: "project-files", project, removes: true }, "delete files"); // read-only, play (ADR 0247)
  if (gate) return gate;
  if (path === "") return "it's the project folder";
  if (isWithin(DEFAULT_CONTEXT_PATH, path)) return `it holds ${DEFAULT_CONTEXT_PATH}, the project's default input context, which can't be moved, renamed or deleted`;
  const [active, ...others] = openPaths(openPath);
  if (active && isWithin(active, path)) return `it holds the scene open now (${active}); open another scene first`;
  const tab = others.find((p) => isWithin(p, path));
  if (tab) return `it holds a scene open in another tab (${tab}); close that tab first`;
  if (!project.folders.includes(path)) return "it's gone already";
  return null;
}

/**
 * Why the file and folder entries can't be deleted right now, or null if they can: the one rule
 * `deleteAssets` and the Assets panel's Delete use (ADR 0241). Every open scene tab is protected.
 * With several entries, the reason names the one refused.
 */
export function whyNotDeletable(project: EditorProject, entries: readonly string[]): string | null {
  if (entries.length === 0) return "select something first";
  const open = openScenePaths();
  for (const entry of entries) {
    const path = entryPath(entry);
    const reason = isFolderEntry(entry) ? whyNotDeletableFolder(project, path, open) : whyNotDeletableAsset(project, path, open);
    if (reason) return entries.length === 1 ? reason : `${fileName(path)}: ${reason}`;
  }
  return null;
}

/**
 * Delete files and folders (selection entries: folders end in "/"), asking first unless the user
 * turned that off; one question for all of them. References to the deleted files in scenes,
 * prefabs and project.json are removed, the open scene's as one undo step. Returns true if they
 * were deleted (once their saved edit histories are gone too).
 */
export async function deleteAssets(entries: readonly string[]): Promise<boolean> {
  const project = currentProject.value;
  if (!project || entries.length === 0) return false;
  const scene = openScene.value;
  const name = entries.length === 1 ? fileName(entryPath(entries[0])) : `${entries.length} items`;
  const refused = whyNotDeletable(project, entries);
  if (refused) {
    status.value = { kind: "info", text: `Can't delete ${name}: ${refused}.` };
    return false;
  }
  // Folders take their contents with them; a file inside a deleted folder needn't be deleted again.
  const folders = entries.filter(isFolderEntry).map(entryPath);
  const loose = entries.filter((e) => !isFolderEntry(e) && !folders.some((f) => isWithin(e, f)));
  const deleting = new Set([...loose, ...folders.flatMap((f) => filesIn(project, f))]);
  const open = scene && scene.stack.dirty ? { path: scene.path, text: JSON.stringify(scene.doc.toJSON()) } : null;
  const users = (await assetUsers(project, [...deleting], open)).filter((u) => !deleting.has(u));
  // Unsaved Code panel text exists nowhere else, so it is asked about even when asking is turned off.
  const unsaved = unsavedWithin([...loose, ...folders]);
  if (askBeforeDeletingAssets.value || unsaved.length > 0) {
    const contents = folders.length > 0 ? ` ${deleting.size === 1 ? "1 file" : `${deleting.size} files`} in all.` : "";
    const lost =
      unsaved.length === 0 ? "" : ` ${unsaved.join(", ")} ${unsaved.length === 1 ? "has" : "have"} unsaved changes in the Code panel, which are lost.`;
    const answer = await confirmInEditor({
      title: `Delete ${name}?`,
      message:
        users.length > 0
          ? `It's deleted from disk, which can't be undone.${contents}${lost} ${users.length === 1 ? "This file uses it" : `These ${users.length} files use it`}: references in scenes, prefabs and project settings are removed (instances of it are deleted); other files (scripts, asset and model files) keep theirs.`
          : `It's deleted from disk, which can't be undone.${contents}${lost} Nothing in the project uses it.`,
      items: users,
      confirmLabel: "Delete",
      ...(askBeforeDeletingAssets.value ? { optionLabel: "Don't ask again" } : {}),
    });
    if (!answer.ok) return false;
    if (answer.option) askBeforeDeletingAssets.value = false;
  }
  // Things may have changed while the dialog was open.
  if (currentProject.value !== project || whyNotDeletable(project, entries)) return false;
  const hadScript = [...deleting].some((p) => project.scripts.has(p));
  try {
    for (const folder of folders) await project.deleteFolder(folder);
    for (const path of loose) await project.deleteFile(path);
  } catch (err) {
    status.value = errorStatus(`Couldn't delete ${name}`, err);
    const histories = assetDocumentsDeleted([...deleting].filter((p) => !project.files.includes(p) && !project.scripts.has(p)));
    docVersion.value++;
    await histories;
    return false;
  }
  const histories = assetDocumentsDeleted([...loose, ...folders]); // open asset documents are dropped with their undo
  codeBuffersDeleted([...loose, ...folders]); // and Code panel tabs with their unsaved text
  const cleaned = new Set<string>();
  const stack = openScene.value?.stack;
  const step = stack ? beginUndoStep(stack, `Remove references to ${name}`) : null; // open across the file writes
  try {
    for (const path of deleting) for (const f of await removeReferences(project, path, `Remove references to ${fileName(path)}`)) cleaned.add(f);
  } catch (err) {
    status.value = errorStatus(`Deleted ${name}, but couldn't remove references to it`, err);
    await histories;
    return true;
  } finally {
    step?.end();
  }
  // What's left: scripts, mostly. (The open scene's file changes when it's saved.)
  const remaining = (await assetUsers(project, [...deleting])).filter((u) => u !== openScene.value?.path);
  docVersion.value++; // the Assets panel lists the project's files
  scriptsVersion.value++;
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
  await histories;
  return true;
}
