// Dragging assets from the asset browser (ADR 0022): drop in the viewport to add them at the top
// level under the cursor, or in the hierarchy to add them under (or beside) a node; drop on a
// folder (in the folder tree, the grid or the path bar) to move them there. Several selected
// files drag together. Built on pointer events rather than HTML drag and drop, which Tauri's
// webview takes over on Windows for its own file drops.
import { errorStatus } from "./messages";
import { signal } from "@preact/signals";
import { viewport } from "../engine/editor";
import type { SceneDocument } from "./document";
import { addAsset, fileName, prepareAssets, whyNotAddable } from "./assetBrowser";
import { entryPath, isFolderEntry } from "./assetDelete";
import { moveAssetsTo, whyNotMoveTarget } from "./assetOps";
import { currentProject, openScene, playState, sceneCamera, selectedKeys, status, viewMode } from "./state";

/** Pointer travel (CSS px) before pressing an asset tile becomes a drag. */
const DRAG_THRESHOLD = 5;

/** Where a dragged asset would go. */
export type AssetDropTarget =
  | { kind: "viewport"; x: number; y: number }
  | { kind: "folder"; folder: string }
  | { kind: "hierarchy"; mode: "into" | "before" | "after" | "root"; row: string | null; parent: string | null; index?: number };

export interface AssetDrag {
  /** What's dragged: Assets panel entries (folders end in "/"). */
  paths: readonly string[];
  /** Pointer position in client pixels, for the ghost label. */
  x: number;
  y: number;
  target: AssetDropTarget | null;
  /** Why the current spot doesn't accept the asset (null when it does). */
  problem: string | null;
}

export const assetDrag = signal<AssetDrag | null>(null);

/**
 * The hierarchy drop for a pointer over the row `rowKey` at `fraction` of its height (0 = top):
 * the top quarter puts the asset before the node as a sibling, the bottom quarter after it, the
 * middle makes the node its parent. A null row (empty space, the scene's own header) means the
 * scene's top level. Rows inside prefab instances don't take children: null.
 */
export function hierarchyDrop(doc: SceneDocument, rowKey: string | null, fraction: number): AssetDropTarget | null {
  if (rowKey === null) return { kind: "hierarchy", mode: "root", row: null, parent: null };
  if (rowKey.includes("/") || !doc.has(rowKey)) return null; // inside a prefab instance, or gone
  if (fraction < 0.25 || fraction > 0.75) {
    const parent = doc.parentOf(rowKey);
    const at = doc.children(parent).indexOf(rowKey);
    return fraction < 0.25 ? { kind: "hierarchy", mode: "before", row: rowKey, parent, index: at } : { kind: "hierarchy", mode: "after", row: rowKey, parent, index: at + 1 };
  }
  return { kind: "hierarchy", mode: "into", row: rowKey, parent: rowKey };
}

/** The folder under a client point (folder tiles, tree items and path parts carry `data-drop-folder`), or null. */
function folderAt(clientX: number, clientY: number): string | null {
  const el = (document.elementFromPoint(clientX, clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-drop-folder]");
  return el ? (el.dataset.dropFolder ?? null) : null;
}

/** The drop target under a client point, found from the DOM (rows carry `data-key`). */
function targetAt(clientX: number, clientY: number): AssetDropTarget | null {
  const folder = folderAt(clientX, clientY);
  if (folder !== null) return { kind: "folder", folder };
  const scene = openScene.value;
  const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
  if (!scene || !el) return null;
  const viewport = el.closest(".viewport-panel");
  if (viewport && playState.value === "edit") {
    const canvas = viewport.querySelector("#viewport canvas") as HTMLCanvasElement | null; // the Scene panel
    const r = (canvas ?? viewport).getBoundingClientRect();
    return { kind: "viewport", x: clientX - r.left, y: clientY - r.top };
  }
  return hierarchyTargetAt(clientX, clientY);
}

/** True if the client point is over a hierarchy row inside a prefab instance (those don't take children). */
export function overPrefabInsides(clientX: number, clientY: number): boolean {
  return !!(document.elementFromPoint(clientX, clientY) as HTMLElement | null)?.closest(".tree .row.inner");
}

const PREFAB_INSIDES = "nodes inside a prefab can't take children here";

/** The hierarchy drop target under a client point (rows carry `data-key`), or null outside the hierarchy. */
export function hierarchyTargetAt(clientX: number, clientY: number): AssetDropTarget | null {
  const scene = openScene.value;
  const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
  if (!scene || !el?.closest(".panel.hierarchy")) return null;
  const row = el.closest(".tree .row") as HTMLElement | null;
  if (!row) return hierarchyDrop(scene.doc, null, 0);
  const r = row.getBoundingClientRect();
  return hierarchyDrop(scene.doc, row.dataset.key ?? null, r.height > 0 ? (clientY - r.top) / r.height : 0.5);
}

/**
 * Where a viewport drop lands: under the cursor on the plane sprites live on (2D view) or on the
 * ground (3D view, y = 0); the camera's focus if the ray misses it.
 */
export function viewportDropPoint(x: number, y: number): [number, number, number] {
  const camera = sceneCamera.value;
  if (!camera) return [0, 0, 0];
  const hit = viewMode.value === "3d" ? viewport(camera._world).pointOnPlane(x, y, [0, 1, 0], [0, 0, 0]) : viewport(camera._world).pointOnPlane(x, y, [0, 0, 1], [0, 0, 0]);
  return hit ?? (camera.focusPoint.toArray() as [number, number, number]);
}

/** Add the dragged assets at `target` (one undo step). Returns the new nodes' ids. */
function drop(paths: readonly string[], target: Exclude<AssetDropTarget, { kind: "folder" }>, point: [number, number, number]): string[] {
  const scene = openScene.value!;
  const ids: string[] = [];
  scene.stack.beginGroup(paths.length === 1 ? `Add ${fileName(paths[0])}` : `Add ${paths.length} assets`);
  try {
    if (target.kind === "viewport") {
      for (const path of paths) ids.push(addAsset(scene, path, { parent: null, position: point, placeInstances: true }));
    } else {
      paths.forEach((path, i) => ids.push(addAsset(scene, path, { parent: target.parent, index: target.index === undefined ? undefined : target.index + i })));
    }
  } finally {
    scene.stack.endGroup();
  }
  return ids;
}

/** Why the dragged entries can't go to `target`, or null if they can. */
function problemFor(paths: readonly string[], target: AssetDropTarget): string | null {
  if (target.kind === "folder") {
    if (!currentProject.value?.canSave) return "this project is read-only";
    if (playState.value !== "edit") return "stop playing to move files";
    if (paths.some((p) => p.includes("#"))) return "slices live in their image; move the image instead"; // ADR 0040
    return whyNotMoveTarget(paths, target.folder);
  }
  const scene = openScene.value;
  if (!scene) return "Open a scene first";
  if (playState.value !== "edit") return "Stop playing to add assets";
  if (paths.some(isFolderEntry)) return "folders can't be added to a scene";
  for (const path of paths) {
    const reason = whyNotAddable(scene.doc, path);
    if (reason) return paths.length === 1 ? reason : `${fileName(path)}: ${reason}`;
  }
  return null;
}

/**
 * Press on an asset tile: past the threshold this drags `paths` (the selection). The ghost label
 * follows the pointer and says what will happen; releasing over a valid spot adds the assets to
 * the scene (one undoable step, selecting them) or moves them to a folder; anywhere else, or
 * Escape, does nothing.
 */
export function startAssetDrag(e: PointerEvent, paths: readonly string[]): void {
  if (e.button !== 0) return;
  const startX = e.clientX, startY = e.clientY;
  let active = false;

  const update = (m: PointerEvent) => {
    if (!active && Math.hypot(m.clientX - startX, m.clientY - startY) < DRAG_THRESHOLD) return;
    if (!active) {
      active = true;
      window.getSelection()?.removeAllRanges();
    }
    const target = targetAt(m.clientX, m.clientY);
    const problem = target
      ? problemFor(paths, target)
      : overPrefabInsides(m.clientX, m.clientY)
        ? PREFAB_INSIDES
        : (problemFor(paths, { kind: "viewport", x: 0, y: 0 }) ?? "drop it in the viewport, the hierarchy or a folder");
    assetDrag.value = { paths, x: m.clientX, y: m.clientY, target: problem ? null : target, problem };
  };
  const finish = (apply: boolean) => {
    window.removeEventListener("pointermove", update);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, true);
    const state = assetDrag.value;
    assetDrag.value = null;
    if (!apply || !active || !state?.target) return;
    const target = state.target;
    if (target.kind === "folder") {
      void moveAssetsTo(paths, target.folder);
      return;
    }
    const name = paths.length === 1 ? fileName(paths[0]) : `${paths.length} assets`;
    const point = target.kind === "viewport" ? viewportDropPoint(target.x, target.y) : ([0, 0, 0] as [number, number, number]);
    const scene = openScene.value;
    // Models load first, to know their meshes (ADR 0044).
    void prepareAssets(paths).then(() => {
      if (openScene.value !== scene || !scene) return;
      try {
        selectedKeys.value = drop(paths, target, point);
        status.value = { kind: "info", text: `Added ${name}` };
      } catch (err) {
        status.value = errorStatus(`Couldn't add ${name}`, err);
      }
    });
  };
  const up = (m: PointerEvent) => {
    if (active) update(m);
    finish(true);
  };
  const cancel = () => finish(false);
  const key = (k: KeyboardEvent) => {
    if (k.key !== "Escape" || !active) return;
    k.preventDefault();
    k.stopPropagation();
    finish(false);
  };
  window.addEventListener("pointermove", update);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, true);
}

/** Text for the ghost label: what releasing here will do. */
export function dropDescription(drag: AssetDrag, doc: SceneDocument | null): string {
  const name = drag.paths.length === 1 ? fileName(entryPath(drag.paths[0])) : `${drag.paths.length} items`;
  if (drag.problem || !drag.target) return `${name}: ${drag.problem ?? "can't drop here"}`;
  const t = drag.target;
  if (t.kind === "viewport") return `Add ${name} here`;
  if (t.kind === "folder") return `Move ${name} to ${t.folder || "the project folder"}`;
  const label = (id: string | null) => (id && doc?.has(id) ? doc.node(id).name ?? id : "the scene");
  switch (t.mode) {
    case "into": return `Add ${name} as a child of ${label(t.row)}`;
    case "before": return `Add ${name} above ${label(t.row)}`;
    case "after": return `Add ${name} below ${label(t.row)}`;
    default: return `Add ${name} to the scene`;
  }
}
