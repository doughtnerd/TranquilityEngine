// Dragging assets from the asset browser into the scene (ADR 0022): drop in the viewport to add
// the asset at the top level under the cursor, or in the hierarchy to add it under (or beside)
// a node. Built on pointer events rather than HTML drag and drop, which Tauri's webview takes
// over on Windows for its own file drops.
import { signal } from "@preact/signals";
import { pointOnSpritePlane } from "../engine/editor";
import type { SceneDocument } from "./document";
import { addAsset, fileName, whyNotAddable } from "./assetBrowser";
import { openScene, playState, sceneCamera, selection, status } from "./state";

/** Pointer travel (CSS px) before pressing an asset tile becomes a drag. */
const DRAG_THRESHOLD = 5;

/** Where a dragged asset would go. */
export type AssetDropTarget =
  | { kind: "viewport"; x: number; y: number }
  | { kind: "hierarchy"; mode: "into" | "before" | "after" | "root"; row: string | null; parent: string | null; index?: number };

export interface AssetDrag {
  path: string;
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

/** The drop target under a client point, found from the DOM (rows carry `data-key`). */
function targetAt(clientX: number, clientY: number): AssetDropTarget | null {
  const scene = openScene.value;
  const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
  if (!scene || !el) return null;
  const viewport = el.closest(".viewport-panel");
  if (viewport && playState.value === "edit") {
    const canvas = viewport.querySelector("#viewport canvas") as HTMLCanvasElement | null;
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

/** Add the dragged asset at `target`. Returns the new node's id. */
function drop(path: string, target: AssetDropTarget): string {
  const scene = openScene.value!;
  if (target.kind === "viewport") {
    // Under the cursor on the plane sprites live on; the camera's focus if the ray misses it.
    const camera = sceneCamera.value;
    const point = (camera && pointOnSpritePlane(camera.world, target.x, target.y)) ?? (camera ? camera.focusPoint.toArray() : [0, 0, 0]);
    return addAsset(scene, path, { parent: null, position: point as [number, number, number], placeInstances: true });
  }
  return addAsset(scene, path, { parent: target.parent, index: target.index });
}

/**
 * Press on an asset tile: past the threshold this drags the asset. The ghost label follows the
 * pointer and says what will happen; releasing over a valid spot adds the asset (one undoable
 * step) and selects it; anywhere else, or Escape, does nothing.
 */
export function startAssetDrag(e: PointerEvent, path: string): void {
  if (e.button !== 0) return;
  const startX = e.clientX, startY = e.clientY;
  let active = false;

  const update = (m: PointerEvent) => {
    if (!active && Math.hypot(m.clientX - startX, m.clientY - startY) < DRAG_THRESHOLD) return;
    if (!active) {
      active = true;
      window.getSelection()?.removeAllRanges();
    }
    const scene = openScene.value;
    const target = targetAt(m.clientX, m.clientY);
    const problem =
      !scene ? "Open a scene first"
      : playState.value !== "edit" ? "Stop playing to add assets"
      : whyNotAddable(scene.doc, path) ?? (target ? null : overPrefabInsides(m.clientX, m.clientY) ? PREFAB_INSIDES : "drop it in the viewport or the hierarchy");
    assetDrag.value = { path, x: m.clientX, y: m.clientY, target: problem ? null : target, problem };
  };
  const finish = (apply: boolean) => {
    window.removeEventListener("pointermove", update);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, true);
    const state = assetDrag.value;
    assetDrag.value = null;
    if (!apply || !active || !state?.target) return;
    try {
      const id = drop(path, state.target);
      selection.value = id;
      status.value = { kind: "info", text: `Added ${fileName(path)}` };
    } catch (err) {
      status.value = { kind: "error", text: `Couldn't add ${fileName(path)}: ${err instanceof Error ? err.message : String(err)}` };
    }
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
  const name = fileName(drag.path);
  if (drag.problem || !drag.target) return `${name}: ${drag.problem ?? "can't drop here"}`;
  const t = drag.target;
  if (t.kind === "viewport") return `Add ${name} here`;
  const label = (id: string | null) => (id && doc?.has(id) ? doc.node(id).name ?? id : "the scene");
  switch (t.mode) {
    case "into": return `Add ${name} as a child of ${label(t.row)}`;
    case "before": return `Add ${name} above ${label(t.row)}`;
    case "after": return `Add ${name} below ${label(t.row)}`;
    default: return `Add ${name} to the scene`;
  }
}
