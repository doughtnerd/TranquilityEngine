// The Scenes panel's tree (ADR 0347: test scenes carry `folder` paths for the Scenes tree; the prototype's scene file
// system): the project's `*.audioscene.json` files under the folders their `folder` names, search by name and folder,
// and the folder edits, which change scenes' `folder` fields (a folder exists while a scene is in it; one made in this
// session stays in the panel until something moves in, `extra`). The files themselves are renamed, duplicated and
// deleted through the engine's asset operations.
//
// Pure: no DOM, no signals.
import { AUDIO_SCENE_SUFFIX, type AudioTestScene } from "../../../engine/audio/spatial/testSceneTypes";
import { uniqueName } from "../../../engine/core/uniqueName";

/** A scene file and the folder it says it is in. */
export interface SceneEntry {
  readonly path: string;
  readonly folder: string;
  /** What it holds, for its row (`sceneNote`). */
  readonly note?: string;
}

export type SceneNode =
  | { readonly kind: "folder"; readonly path: string; readonly name: string; readonly children: readonly SceneNode[] }
  | { readonly kind: "scene"; readonly path: string; readonly name: string; readonly folder: string };

export const isScenePath = (path: string): boolean => path.toLowerCase().endsWith(AUDIO_SCENE_SUFFIX);

/** A scene's name: its file name without `.audioscene.json`. */
export function sceneName(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return isScenePath(file) ? file.slice(0, file.length - AUDIO_SCENE_SUFFIX.length) : file;
}

/**
 * A scene as the Move to… dialog takes it: by its name under the folder its `folder` field names (not its file's
 * folder), so the dialog's title names the scene and its folder shows as the one it's in now.
 */
export function sceneMoveItem(entry: SceneEntry): { readonly path: string; readonly folder: false } {
  const name = sceneName(entry.path);
  return { path: entry.folder ? `${entry.folder}/${name}` : name, folder: false };
}

const leaf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
/** A folder path tidied: no empty parts, no spaces round them. */
export const normFolder = (folder: string): string => folder.split("/").map((s) => s.trim()).filter((s) => s !== "").join("/");
const inside = (folder: string, path: string) => path === folder || path.startsWith(`${folder}/`);

/** Every folder: the scenes' folders, their parents and `extra`, A–Z. */
export function sceneFolders(entries: readonly SceneEntry[], extra: readonly string[] = []): string[] {
  const out = new Set<string>();
  for (const f of [...entries.map((e) => e.folder), ...extra]) {
    const parts = normFolder(f).split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** The tree: folders first (A–Z), then scenes by name. */
export function sceneTree(entries: readonly SceneEntry[], extra: readonly string[] = []): SceneNode[] {
  const folders = sceneFolders(entries, extra);
  const byName = [...entries].sort((a, b) => sceneName(a.path).localeCompare(sceneName(b.path), undefined, { numeric: true }));
  const build = (folder: string): SceneNode[] => [
    ...folders.filter((f) => parentOf(f) === folder).map((f): SceneNode => ({ kind: "folder", path: f, name: leaf(f), children: build(f) })),
    ...byName.filter((e) => normFolder(e.folder) === folder).map((e): SceneNode => ({ kind: "scene", path: e.path, name: sceneName(e.path), folder: normFolder(e.folder) })),
  ];
  return build("");
}

/** The scenes in the tree's order, top to bottom (every folder open). */
function treeOrder(entries: readonly SceneEntry[]): string[] {
  const out: string[] = [];
  const walk = (nodes: readonly SceneNode[]) => {
    for (const n of nodes) {
      if (n.kind === "scene") out.push(n.path);
      else walk(n.children);
    }
  };
  walk(sceneTree(entries));
  return out;
}

/** The scene to open after `removed` go (the open one deleted): the next in the tree, else the one before; null when none is left. */
export function sceneAfter(entries: readonly SceneEntry[], removed: readonly string[]): string | null {
  const order = treeOrder(entries);
  const gone = new Set(removed);
  const at = order.findIndex((p) => gone.has(p));
  if (at < 0) return null;
  return order.slice(at + 1).find((p) => !gone.has(p)) ?? [...order.slice(0, at)].reverse().find((p) => !gone.has(p)) ?? null;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A scene row's muted note: "Game scene · canyon" over a game scene, "Blank" with only a listener, else what it holds. */
export function sceneNote(scene: AudioTestScene): string {
  if (scene.base) return `Game scene · ${sceneName(scene.base).replace(/\.scene\.json$/i, "")}`;
  const zones = scene.reverbZones.length + scene.audioZones.length;
  const parts = [
    scene.emitters.length ? count(scene.emitters.length, "emitter") : "",
    scene.obstacles.length ? count(scene.obstacles.length, "obstacle") : "",
    zones ? count(zones, "zone") : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Blank";
}

/** Scenes matching every word of `query` in their name or folder, with "folder › name" for display. */
export function searchScenes(entries: readonly SceneEntry[], query: string): { path: string; label: string }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return entries
    .filter((e) => words.every((w) => `${normFolder(e.folder)}/${sceneName(e.path)}`.toLowerCase().includes(w)))
    .sort((a, b) => sceneName(a.path).localeCompare(sceneName(b.path)))
    .map((e) => ({ path: e.path, label: normFolder(e.folder) ? `${normFolder(e.folder).split("/").join(" › ")} › ${sceneName(e.path)}` : sceneName(e.path) }));
}

/** A folder change for one scene file. */
export interface FolderChange {
  readonly path: string;
  readonly folder: string;
}

/** Folder `from` renamed (its last part) to `name`: the scenes inside move with it. */
export function renameSceneFolder(entries: readonly SceneEntry[], from: string, name: string, extra: readonly string[] = []): { changes: FolderChange[]; to: string } | { refused: string } {
  const clean = name.trim();
  if (clean === "" || clean.includes("/")) return { refused: "a folder name can't be empty or hold a /" };
  const to = parentOf(from) ? `${parentOf(from)}/${clean}` : clean;
  if (to === from) return { changes: [], to };
  if (sceneFolders(entries, extra).includes(to)) return { refused: `there's already a folder "${to}"` };
  return { to, changes: entries.filter((e) => inside(from, normFolder(e.folder))).map((e) => ({ path: e.path, folder: to + normFolder(e.folder).slice(from.length) })) };
}

/** Folder `folder` moved into `into`; refused into itself or a folder inside it. */
export function moveSceneFolder(entries: readonly SceneEntry[], folder: string, into: string): { changes: FolderChange[]; to: string } | { refused: string } {
  const target = normFolder(into);
  if (inside(folder, target)) return { refused: "a folder can't move into itself" };
  if (parentOf(folder) === target) return { refused: `${leaf(folder)} is already there` };
  const to = target ? `${target}/${leaf(folder)}` : leaf(folder);
  return { to, changes: entries.filter((e) => inside(folder, normFolder(e.folder))).map((e) => ({ path: e.path, folder: to + normFolder(e.folder).slice(folder.length) })) };
}

/** Folder `folder` deleted: the scenes in it move up to its parent (the files stay). */
export function deleteSceneFolder(entries: readonly SceneEntry[], folder: string): FolderChange[] {
  const up = parentOf(folder);
  return entries
    .filter((e) => inside(folder, normFolder(e.folder)))
    .map((e) => ({ path: e.path, folder: [up, normFolder(e.folder).slice(folder.length).replace(/^\//, "")].filter((x) => x !== "").join("/") }));
}

/** A fresh folder path under `parent` ("New folder", numbered). */
export function newSceneFolder(entries: readonly SceneEntry[], parent: string, extra: readonly string[] = []): string {
  const p = normFolder(parent);
  const taken = sceneFolders(entries, extra).filter((f) => parentOf(f) === p).map(leaf);
  const name = uniqueName("New folder", taken);
  return p ? `${p}/${name}` : name;
}

/** Why a scene can't be renamed `name` (null when it can): empty, a slash, or another scene file beside it has it. */
export function whyNotRenameScene(files: readonly string[], path: string, name: string): string | null {
  const clean = name.trim();
  if (clean === "") return "a name can't be empty";
  if (/[\\/:*?"<>|]/.test(clean)) return "a name can't hold \\ / : * ? \" < > |";
  const dir = parentOf(path);
  const next = `${dir ? `${dir}/` : ""}${clean}${AUDIO_SCENE_SUFFIX}`;
  if (next !== path && files.some((f) => f.toLowerCase() === next.toLowerCase())) return `there's already a scene named ${clean}`;
  return null;
}
