// Dragging assets from the asset browser (ADR 0022): drop in the viewport to add them at the top
// level under the cursor, or in the hierarchy to add them under (or beside) a node, inside prefab
// instances too (where the Hierarchy drop says, ADR 0258); drop on a
// folder (in the folder tree, the grid or the path bar) to move them there. Several selected
// files drag together. Built on pointer events rather than HTML drag and drop, which Tauri's
// webview takes over on Windows for its own file drops.
import { signal } from "@preact/signals";
import { viewport } from "../engine/editor";
import type { SceneDocument } from "./document";
import { isInnerKey, parseKey } from "./nodeKey";
import { addAssets, whyNotAddAssets, type AssetAddTarget } from "./addAssets";
import { dropRowName, hierarchyDropAt, type HierarchyDrop } from "./hierarchyDrop";
import { whyNotInsert } from "./nodeInsertion";
import { fileName } from "./assetBrowser";
import { dropTargetFor, setDraggedAssets, type AssetDropPoint, type AssetDropTargetSpec } from "./assetDropTargets";
import { entryPath, isSliceEntry } from "./assetEntry";
import { moveAssetsTo, whyNotMovable, whyNotMoveTarget } from "./assetOps";
import { select } from "./inspectorTarget";
import { currentProject, openScene, playState, sceneCamera, status, viewMode } from "./state";
import { whyNotEdit } from "./editGate";
import { nodeAssetDrops } from "./sdk/contributions";
import { eventWindow } from "./windows/dom";
import { startPointerDrag } from "./pointerDrag";

/** Where a dragged asset would go. */
export type AssetDropTarget =
  | { kind: "viewport"; x: number; y: number }
  | { kind: "folder"; folder: string }
  // A plugin panel's target (assetDropTargets.ts): its label for this spot, and the release it takes.
  | { kind: "plugin"; spec: AssetDropTargetSpec; label: string; point: AssetDropPoint }
  | { kind: "hierarchy"; drop: HierarchyDrop };

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

/** The folder under a client point (folder tiles, tree items and path parts carry `data-drop-folder`), or null. */
function folderAt(clientX: number, clientY: number, doc: Document = document): string | null {
  const el = (doc.elementFromPoint(clientX, clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-drop-folder]");
  return el ? (el.dataset.dropFolder ?? null) : null;
}

/**
 * The plugin panel's target under a client point (registered with `registerAssetDropTarget`): a target taking the
 * drag with its label for the spot, or the problem when the panel doesn't take it there. Null outside registered panels.
 */
function dropTarget(paths: readonly string[], x: number, y: number, doc: Document = document): { spec: AssetDropTargetSpec; target: AssetDropTarget | null; problem: string } | null {
  const found = dropTargetFor(doc.elementFromPoint(x, y));
  if (!found) return null;
  const { spec } = found;
  if (!spec.accepts(paths)) return { spec, target: null, problem: "can't drop these here" };
  const point = { x, y };
  spec.over?.(paths, point);
  const label = spec.label(paths, point);
  return { spec, target: label === null ? null : { kind: "plugin", spec, label, point }, problem: "can't drop here" };
}

/** The drop target under a client point, found from the DOM (rows carry `data-key`). */
function targetAt(clientX: number, clientY: number, doc: Document = document): AssetDropTarget | null {
  const folder = folderAt(clientX, clientY, doc);
  if (folder !== null) return { kind: "folder", folder };
  const scene = openScene.value;
  const el = doc.elementFromPoint(clientX, clientY) as HTMLElement | null;
  if (!scene || !el) return null;
  const viewport = el.closest(".viewport-panel");
  if (viewport && playState.value === "edit") {
    const canvas = viewport.querySelector("#viewport canvas") as HTMLCanvasElement | null; // the Scene panel
    const r = (canvas ?? viewport).getBoundingClientRect();
    return { kind: "viewport", x: clientX - r.left, y: clientY - r.top };
  }
  const drop = hierarchyDropAt(scene.doc, clientX, clientY, doc);
  return drop ? { kind: "hierarchy", drop } : null;
}

/**
 * A plugin's drop on the middle of a node's Hierarchy row (`registerNodeAssetDrop`, ADR 0373: a clip on an Animator), as
 * a plugin target, or null when no contribution takes these files there (they're then added under the node as usual).
 */
function nodeDropTarget(paths: readonly string[], drop: HierarchyDrop, point: AssetDropPoint): AssetDropTarget | null {
  const scene = openScene.value;
  if (!scene || drop.mode !== "into" || drop.row === null) return null;
  const path = parseKey(drop.row);
  for (const c of nodeAssetDrops.list()) {
    const label = c.label(scene, path, paths);
    if (label !== null) return { kind: "plugin", spec: { accepts: () => true, label: () => label, drop: () => c.drop(scene, path, paths) }, label, point };
  }
  return null;
}

/**
 * Where a viewport drop lands: under the cursor on the plane sprites live on (2D view) or on the
 * ground (3D view, y = 0); the camera's focus if the ray misses it.
 */
function viewportDropPoint(x: number, y: number): [number, number, number] {
  const camera = sceneCamera.value;
  if (!camera) return [0, 0, 0];
  const hit = viewMode.value === "3d" ? viewport(camera._world).pointOnPlane(x, y, [0, 1, 0], [0, 0, 0]) : viewport(camera._world).pointOnPlane(x, y, [0, 0, 1], [0, 0, 0]);
  return hit ?? (camera.focusPoint.toArray() as [number, number, number]);
}

/** Where a scene drop adds the assets (`addAssets`, ADR 0149). */
function addTarget(target: Exclude<AssetDropTarget, { kind: "folder" | "plugin" }>, point: readonly [number, number, number]): AssetAddTarget {
  return target.kind === "viewport" ? { kind: "point", position: point } : { kind: "hierarchy", place: target.drop.insert };
}

/** Why the dragged entries can't go to `target`, or null if they can. */
function problemFor(paths: readonly string[], target: AssetDropTarget): string | null {
  if (target.kind === "plugin") return null; // its own `accepts` and `label` decided (pluginTargetAt)
  if (target.kind === "folder") {
    const project = currentProject.value;
    const gate = whyNotEdit({ kind: "project-files", project, removes: true }, "move files"); // read-only, play (ADR 0247)
    if (gate || !project) return gate ?? "open a project first";
    if (paths.some(isSliceEntry)) return "slices live in their image; move the image instead"; // ADR 0040
    return whyNotMoveTarget(paths, target.folder) ?? whyNotMovable(project, paths);
  }
  if (target.kind === "hierarchy") return whyNotInsert(openScene.value, { kind: "assets", paths }, target.drop.insert);
  return whyNotAddAssets(paths);
}

/**
 * Press on an asset tile: past the drag threshold (`pointerDrag.ts`) this drags `paths` (the selection). The ghost label
 * follows the pointer and says what will happen; releasing over a valid spot adds the assets to
 * the scene (`addAssets`: one undoable step, selecting them) or moves them to a folder; anywhere else, or
 * Escape, does nothing.
 */
export function startAssetDrag(e: PointerEvent, paths: readonly string[]): void {
  // The window the drag started in: a detached panel window's own (ADR 0174). Dragging between windows isn't supported.
  const win = eventWindow(e);
  /** The plugin target the pointer is over now, to tell it when the pointer leaves. */
  let over: AssetDropTargetSpec | null = null;
  const setOver = (spec: AssetDropTargetSpec | null) => {
    if (over && over !== spec) over.leave?.();
    over = spec;
  };
  startPointerDrag(e, {
    begin: () => {
      win.getSelection()?.removeAllRanges();
      setDraggedAssets(paths);
    },
    move: (m, doc) => {
      const plugin = dropTarget(paths, m.clientX, m.clientY, doc);
      setOver(plugin?.spec ?? null);
      if (plugin) {
        assetDrag.value = { paths, x: m.clientX, y: m.clientY, target: plugin.target, problem: plugin.target ? null : plugin.problem };
        return;
      }
      const found = targetAt(m.clientX, m.clientY, doc);
      const target = (found?.kind === "hierarchy" ? nodeDropTarget(paths, found.drop, { x: m.clientX, y: m.clientY }) : null) ?? found;
      const problem = target ? problemFor(paths, target) : (problemFor(paths, { kind: "viewport", x: 0, y: 0 }) ?? "drop it in the viewport, the hierarchy or a folder");
      assetDrag.value = { paths, x: m.clientX, y: m.clientY, target: problem ? null : target, problem };
    },
    end: (how) => {
      const state = assetDrag.value;
      assetDrag.value = null;
      setOver(null);
      setDraggedAssets(null);
      if (how !== "drop" || !state?.target) return;
      const target = state.target;
      if (target.kind === "plugin") {
        target.spec.drop(paths, target.point);
        return;
      }
      if (target.kind === "folder") {
        void moveAssetsTo(paths, target.folder);
        return;
      }
      const point = target.kind === "viewport" ? viewportDropPoint(target.x, target.y) : ([0, 0, 0] as const);
      // One operation (ADR 0149): prepares (a model's meshes), adds to the scene open now or to none, one undo step.
      void addAssets(paths, addTarget(target, point)).then(({ ids, message }) => {
        if (ids.length > 0) select(ids); // through the Inspector rule (ADR 0242): a selected UI element or asset gives way
        status.value = message;
      });
    },
  });
}

/** Text for the ghost label: what releasing here will do. */
export function dropDescription(drag: AssetDrag, doc: SceneDocument | null): string {
  const name = drag.paths.length === 1 ? fileName(entryPath(drag.paths[0])) : `${drag.paths.length} items`;
  if (drag.problem || !drag.target) return `${name}: ${drag.problem ?? "can't drop here"}`;
  const t = drag.target;
  if (t.kind === "plugin") return t.label;
  if (t.kind === "viewport") return `Add ${name} here`;
  if (t.kind === "folder") return `Move ${name} to ${t.folder || "the project folder"}`;
  const row = dropRowName(doc, t.drop.row);
  switch (t.drop.mode) {
    case "into": return `Add ${name} as a child of ${row}${t.drop.row !== null && isInnerKey(t.drop.row) ? " (an override of its prefab instance)" : ""}`;
    case "before": return `Add ${name} above ${row}`;
    case "after": return `Add ${name} below ${row}`;
    default: return `Add ${name} to the scene`;
  }
}
