// Viewport selection (ADR 0022, 0026). A plain left click picks the smallest collider containing
// the pointer (anywhere inside a collider counts), else the topmost renderer under it, and selects
// its document node; clicking the same spot again cycles through overlapping
// hits; clicking empty space clears. Shift+click adds the hit, Ctrl/Cmd+click toggles it. A left
// drag on empty space draws a selection box: every node lying inside it is selected (Shift adds,
// Ctrl/Cmd toggles), live as the box changes; Escape puts the selection back. Alt+click opens a
// list of every node near the pointer, occluded ones and their children included, to refine the
// selection. Colliders count as part of their node for the box and the list too. The selection is
// outlined in the viewport, and the scene camera's F key frames it.
import { effect } from "@preact/signals";
import type { Engine, GameObject } from "../engine";
import { gizmoActive, pick, pickUI, pointOnSpritePlane, screenBounds, setSelectionOutline, viewportCanvas, worldToCanvas, type ScreenRect } from "../engine/editor";
import type { UIComponentType } from "../engine/ui/components";
import { colliderShapes } from "./colliderGizmo";
import { pointInPolygon, polygonArea } from "./colliderMath";
import { pathKey, type NodePath } from "./document";
import type { OrbitCamera } from "./OrbitCamera";
import { isLocked } from "./nodeVisibility";
import { combineSelection, selectModeFor, withDescendants, type SelectMode } from "./selectionModel";
import { docVersion, openScene, refineList, select, selectedKeys, selectedNodes, selectedUIElement, selection } from "./state";
import { elementOfComponent, parseUIRefKey, refOfElement, selectUIElement, uiRefKey, type NodeLookup } from "./uiDocuments";
import { pressOnSelectedUI } from "./uiHandles";

/** Pointer travel (CSS pixels) under which a press and release count as a click, not a drag. */
export const CLICK_SLOP = 4;
/** How far (CSS pixels) from an Alt+click a node can be and still be listed. */
export const REFINE_RADIUS = 24;

export interface PointerSample {
  readonly x: number;
  readonly y: number;
  readonly button: number;
  /** Alt + left drag orbits the camera, so it never selects. */
  readonly alt?: boolean;
}

/** True if `down`…`up` is a plain left click: left button, no Alt, little movement. */
export function isPlainClick(down: PointerSample, up: PointerSample): boolean {
  return down.button === 0 && up.button === 0 && !down.alt && Math.hypot(up.x - down.x, up.y - down.y) < CLICK_SLOP;
}

/** Document ids for picked nodes, topmost first, without duplicates or unmapped nodes. */
export function hitIds(nodes: readonly GameObject[], idOf: (node: GameObject) => string | null): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const id = idOf(n);
    if (id !== null && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * What a click selects: nothing on empty space, the topmost hit, or (clicking the same spot
 * again while one of the hits is selected) the next hit down, wrapping around.
 */
export function chooseSelection(hits: readonly string[], current: string | null, sameSpot: boolean): string | null {
  if (hits.length === 0) return null;
  const index = sameSpot && current !== null ? hits.indexOf(current) : -1;
  return index < 0 ? hits[0] : hits[(index + 1) % hits.length];
}

/** The rectangle between two canvas points. */
export function boxBetween(a: { x: number; y: number }, b: { x: number; y: number }): ScreenRect {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
}

const union = (a: ScreenRect, b: ScreenRect): ScreenRect => ({
  left: Math.min(a.left, b.left),
  top: Math.min(a.top, b.top),
  right: Math.max(a.right, b.right),
  bottom: Math.max(a.bottom, b.bottom),
});
const inside = (r: ScreenRect, box: ScreenRect) => r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom;

/**
 * Document ids lying inside `box`: a node counts when everything it draws (its own renderers and
 * those of the nodes inside it, for a prefab instance), or its origin if it draws nothing, is
 * within the box. In the order the nodes were listed.
 */
export function idsInBox(bounds: readonly { node: GameObject; rect: ScreenRect }[], box: ScreenRect, idOf: (node: GameObject) => string | null): string[] {
  const extent = new Map<string, ScreenRect>();
  for (const { node, rect } of bounds) {
    const id = idOf(node);
    if (id === null) continue;
    const e = extent.get(id);
    extent.set(id, e ? union(e, rect) : rect);
  }
  return [...extent].filter(([, r]) => inside(r, box)).map(([id]) => id);
}

/**
 * Path keys of the nodes within `radius` of a canvas point, however deep: each node near it, and
 * for a node inside a prefab instance, the instance too. In the order the nodes were listed.
 */
export function keysNear(bounds: readonly { node: GameObject; rect: ScreenRect }[], x: number, y: number, radius: number, pathOf: (node: GameObject) => NodePath | null): string[] {
  const out = new Set<string>();
  for (const { node, rect } of bounds) {
    const dx = Math.max(rect.left - x, 0, x - rect.right), dy = Math.max(rect.top - y, 0, y - rect.bottom);
    if (Math.hypot(dx, dy) > radius) continue;
    const path = pathOf(node);
    if (!path) continue;
    out.add(path[0]);
    out.add(pathKey(path));
  }
  return [...out];
}

/**
 * Selection keys for the UI under a click (ADR 0077), topmost first: a UI document's element as its
 * `uiRefKey`, a hand-built UI node (ADR 0069) as its document node id. Elements outside the edited
 * scene, list rows and nodes `pickable` refuses (locked) are left out; duplicates too.
 */
export function uiHitKeys(comps: readonly UIComponentType[], lookup: NodeLookup & { nodeIdOf(node: GameObject): string | null }, pickable: (node: GameObject) => boolean): string[] {
  const out: string[] = [];
  for (const c of comps) {
    const el = elementOfComponent(c);
    let key: string | null = null;
    if (el) {
      const ref = el.document.node.isValid && pickable(el.document.node) ? refOfElement(lookup, el) : null;
      key = ref ? uiRefKey(ref) : null;
    } else if (pickable(c.owner)) key = lookup.nodeIdOf(c.owner);
    if (key !== null && !out.includes(key)) out.push(key);
  }
  return out;
}

/** Select what a plain click chose: a UI element's key (`ui:...`), a node id, or nothing. */
export function applyClickSelection(key: string | null): void {
  const ref = key ? parseUIRefKey(key) : null;
  if (ref) selectUIElement(ref);
  else selection.value = key;
}

type Shape = { node: GameObject; points: readonly (readonly number[])[] };

/**
 * Nodes whose collider outline contains the pointer, smallest collider first. `pointAt(z)` is
 * the world point under the pointer on the plane at depth z (each collider lies in its node's plane).
 */
export function colliderHits(shapes: readonly Shape[], pointAt: (z: number) => readonly number[] | null): GameObject[] {
  return shapes
    .filter((s) => {
      const p = s.points.length > 0 ? pointAt(s.points[0][2] ?? 0) : null;
      return p !== null && pointInPolygon(p as [number, number], s.points);
    })
    .sort((a, b) => polygonArea(a.points) - polygonArea(b.points))
    .map((s) => s.node);
}

/** Each collider's rectangle on the canvas, for the box and the Alt+click list; colliders partly behind the camera are left out. */
export function colliderBounds(shapes: readonly Shape[], project: (p: readonly number[]) => [number, number] | null): { node: GameObject; rect: ScreenRect }[] {
  const out: { node: GameObject; rect: ScreenRect }[] = [];
  for (const { node, points } of shapes) {
    const projected = points.map(project);
    if (projected.length === 0 || projected.some((p) => p === null)) continue;
    const xs = projected.map((p) => p![0]), ys = projected.map((p) => p![1]);
    out.push({ node, rect: { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) } });
  }
  return out;
}

/** Hook selection up to the viewport. Returns a function that removes it. */
export function installViewportSelection(engine: Engine, camera: OrbitCamera): () => void {
  const world = engine.world;
  camera.focusTarget = () => {
    const nodes = selectedNodes().filter((s) => s.node.isValid && s.node.transform);
    if (nodes.length === 0) return null;
    const sum = [0, 0, 0];
    for (const { node } of nodes) {
      const p = node.transform!.worldPosition;
      sum[0] += p.x;
      sum[1] += p.y;
      sum[2] += p.z;
    }
    return sum.map((v) => v / nodes.length);
  };

  // Outline the selection; re-run when it changes or the document is edited (nodes may be rebuilt).
  const stopOutline = effect(() => {
    docVersion.value;
    setSelectionOutline(
      world,
      selectedNodes().map((s) => s.node),
    );
  });

  const canvas = viewportCanvas(world);
  if (!canvas) return stopOutline;

  const local = (e: { clientX: number; clientY: number }) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const sample = (e: PointerEvent): PointerSample => ({ ...local(e), button: e.button, alt: e.altKey });

  /** The press; `ui` when it's on the selected UI element's box, where a drag moves the element (`uiHandles.ts`), not a selection box. */
  let down: (PointerSample & { pointerId: number; ui?: boolean }) | null = null;
  let lastClick: { x: number; y: number } | null = null;
  /** The selection box being dragged: the selection before it, and its element. */
  let box: { before: readonly string[]; element: HTMLDivElement } | null = null;

  /** Colliders of active nodes in the edited scene. */
  const shapes = () => colliderShapes(engine).filter((s) => s.node.activeInHierarchy);
  /** What each node covers on the canvas: its renderers or origin, and its colliders. */
  const boundsUnderScene = () => {
    const root = openScene.value?.sync.sceneNode;
    return root ? [...screenBounds(world, root), ...colliderBounds(shapes(), (p) => worldToCanvas(world, p))].filter((b) => pickable(b.node)) : [];
  };
  /** False for nodes locked in the hierarchy (by themselves or an ancestor): the viewport can't pick them. */
  const pickable = (node: GameObject) => {
    const scene = openScene.value, path = scene?.sync.pathOf(node);
    return !scene || !path || !isLocked(scene.doc, pathKey(path));
  };

  const updateBox = (e: PointerEvent) => {
    const scene = openScene.value;
    if (!box || !down || !scene) return;
    const p = local(e);
    const r = boxBetween(down, p);
    const c = canvas.getBoundingClientRect();
    Object.assign(box.element.style, { left: `${c.left + r.left}px`, top: `${c.top + r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px` });
    const ids = idsInBox(boundsUnderScene(), r, (n) => scene.sync.nodeIdOf(n));
    select(combineSelection(box.before, ids, selectModeFor(e)));
  };
  const endBox = (restore: boolean) => {
    if (!box) return;
    if (restore) select(box.before);
    box.element.remove();
    box = null;
    down = null;
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !box) return;
    e.preventDefault();
    e.stopPropagation();
    endBox(true);
  };

  const onDown = (e: PointerEvent) => {
    // Presses on a gizmo handle drag the gizmo; they never change the selection.
    const p = sample(e);
    down = e.button === 0 && !gizmoActive(world, p.x, p.y) ? { ...p, pointerId: e.pointerId, ui: !e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && pressOnSelectedUI(world, [p.x, p.y]) } : null;
  };
  const onMove = (e: PointerEvent) => {
    if (!down || down.alt || down.ui || !openScene.value) return;
    if (box) return updateBox(e);
    const p = local(e);
    if (Math.hypot(p.x - down.x, p.y - down.y) < CLICK_SLOP) return;
    // A left drag that didn't start on a gizmo handle: draw a selection box.
    canvas.setPointerCapture?.(down.pointerId);
    const element = document.createElement("div");
    element.className = "selection-box";
    document.body.appendChild(element);
    box = { before: selectedKeys.peek(), element };
    window.addEventListener("keydown", onKey, true);
    updateBox(e);
  };
  const onUp = (e: PointerEvent) => {
    if (box) {
      updateBox(e);
      return endBox(false);
    }
    const start = down;
    down = null;
    const scene = openScene.value;
    if (!start || !scene) return;
    const p = sample(e);
    if (start.alt && e.button === 0 && Math.hypot(p.x - start.x, p.y - start.y) < CLICK_SLOP) {
      // Alt+click: list everything near the pointer, with children, to refine the selection.
      const keys = keysNear(boundsUnderScene(), p.x, p.y, REFINE_RADIUS, (n) => scene.sync.pathOf(n));
      const entries = withDescendants(scene.doc, keys);
      if (entries.length > 0) refineList.value = { x: e.clientX, y: e.clientY, entries, before: selectedKeys.peek() };
      return;
    }
    if (!isPlainClick(start, p)) return;
    // UI under the pointer first (ADR 0077: drawn over the scene; its elements topmost first), then
    // colliders containing the pointer (smallest first), then renderers under it (topmost first).
    const inColliders = colliderHits(shapes(), (z) => pointOnSpritePlane(world, p.x, p.y, z));
    const hits = hitIds([...inColliders, ...pick(world, p.x, p.y)].filter(pickable), (n) => scene.sync.nodeIdOf(n));
    const mode: SelectMode = selectModeFor(e);
    if (mode === "replace") {
      const sameSpot = lastClick !== null && Math.hypot(p.x - lastClick.x, p.y - lastClick.y) < CLICK_SLOP;
      const ui = uiHitKeys(pickUI(world, p.x, p.y), scene.sync, pickable);
      const all = [...ui, ...hits.filter((h) => !ui.includes(h))];
      applyClickSelection(chooseSelection(all, selectedUIElement.peek() ?? selection.peek(), sameSpot));
    } else if (hits.length > 0) {
      select(combineSelection(selectedKeys.peek(), [hits[0]], mode));
    }
    lastClick = { x: p.x, y: p.y };
  };
  const onCancel = () => endBox(true);

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);
  return () => {
    endBox(false);
    stopOutline();
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointercancel", onCancel);
    camera.focusTarget = null;
  };
}
