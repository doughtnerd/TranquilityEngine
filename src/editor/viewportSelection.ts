// Viewport selection (ADR 0022, 0026). A plain left click picks the smallest selectable outline (the Physics plugin's
// 2D colliders, ADR 0142) containing the pointer, else the topmost renderer under it, and selects
// its document node; clicking the same spot again cycles through overlapping
// hits; clicking empty space clears. Shift+click adds the hit, Ctrl/Cmd+click toggles it. A left
// drag on empty space draws a selection box: every node lying inside it is selected (Shift adds,
// Ctrl/Cmd toggles), live as the box changes; Escape puts the selection back. Alt+click opens a
// list of every node near the pointer, occluded ones and their children included, to refine the
// selection. Colliders count as part of their node for the box and the list too. The selection is
// outlined in the viewport, and the scene camera's F key frames it.
import { effect } from "@preact/signals";
import type { Engine, GameObject } from "../engine";
import { viewport, viewportCanvas } from "../engine/editor";
import type { UIComponentType } from "../engine/ui/components";
import { selectableOutlines } from "./viewportTools";
import { pathKey } from "./document";
import type { OrbitCamera } from "./OrbitCamera";
import { isLocked } from "./nodeVisibility";
import { combineSelection, selectModeFor, withDescendants, type SelectMode } from "./selectionModel";
import { docVersion, openScene, refineList, selectedKeys, selectedNodes, selectedUIElement, selection } from "./state";
import { select, selectUIElement } from "./inspectorTarget";
import { elementOfComponent, parseUIRefKey, refOfElement, uiRefKey, type NodeLookup } from "./uiDocuments";
import { parseUIViewRefKey, refOfViewElement, uiViewRefKey, viewElementOfComponent } from "./uiViews";
import { uiHostElementOf } from "../engine/ui/host/UIHost";
import { pressOnSelectedUI } from "./uiHandles";
import { orderClickHits, partitionUIHits } from "./uiPicking";
import { boxBetween, chooseSelection, colliderBounds, colliderHits, hitIds, idsInBox, isPlainClick, keysNear, type PointerSample } from "./viewportPicks";

/** Pointer travel (CSS pixels) under which a press and release count as a click, not a drag. */
const CLICK_SLOP = 4;
/** How far (CSS pixels) from an Alt+click a node can be and still be listed. */
const REFINE_RADIUS = 24;

/**
 * Selection keys for the UI under a click (ADR 0077), topmost first: a UI document's element as its
 * `uiRefKey`, an element a UIView rendered (ADR 0419 wave C) as its `uiViewRefKey` (a button's label picks the
 * button), a hand-built UI node (ADR 0069) as its document node id. Elements outside the edited
 * scene, list rows and nodes `pickable` refuses (locked) are left out; duplicates too.
 */
function uiHitKeys(comps: readonly UIComponentType[], lookup: NodeLookup & { nodeIdOf(node: GameObject): string | null }, pickable: (node: GameObject) => boolean): string[] {
  const out: string[] = [];
  for (const c of comps) {
    const el = elementOfComponent(c);
    let key: string | null = null;
    const hosted = el ? null : viewElementOfComponent(c);
    if (el) {
      const ref = el.document.node.isValid && pickable(el.document.node) ? refOfElement(lookup, el) : null;
      key = ref ? uiRefKey(ref) : null;
    } else if (hosted) {
      const viewNode = hosted.tree.root.node.parent;
      const ref = viewNode && pickable(viewNode) ? refOfViewElement(lookup, hosted) : null;
      key = ref ? uiViewRefKey(ref) : null;
    } else if (uiHostElementOf(c)) {
      // A view's canvas (it has no template location): the view's node.
      const viewNode = uiHostElementOf(c)!.tree.root.node.parent;
      key = viewNode && pickable(viewNode) ? lookup.nodeIdOf(viewNode) : null;
    } else if (pickable(c.owner)) key = lookup.nodeIdOf(c.owner);
    if (key !== null && !out.includes(key)) out.push(key);
  }
  return out;
}

/** Select what a plain click chose: a UI element's key (`ui:...`, or a view's `uiv:...`), a node id, or nothing. */
function applyClickSelection(key: string | null): void {
  const ref = key ? (parseUIRefKey(key) ?? parseUIViewRefKey(key)) : null;
  if (ref) selectUIElement(ref);
  else select(key === null ? [] : [key]);
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
    viewport(world).setSelection(selectedNodes().map((s) => s.node));
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

  /** Outlines viewport tools mark selectable (ADR 0142: the Physics plugin's 2D colliders) of active nodes. */
  const shapes = () => selectableOutlines(world).filter((s) => s.node.activeInHierarchy);
  /** What each node covers on the canvas: its renderers or origin, and its colliders. */
  const boundsUnderScene = () => {
    const root = openScene.value?.sync.sceneNode;
    return root ? [...viewport(world).screenBounds(root), ...colliderBounds(shapes(), (p) => viewport(world).worldToCanvas(p))].filter((b) => pickable(b.node)) : [];
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
    down = e.button === 0 && !viewport(world).gizmoActiveAt(p.x, p.y) ? { ...p, pointerId: e.pointerId, ui: !e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && pressOnSelectedUI(world, [p.x, p.y]) } : null;
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
    const inColliders = colliderHits(shapes(), (z) => viewport(world).pointOnPlane(p.x, p.y, [0, 0, 1], [0, 0, z]));
    const hits = hitIds([...inColliders, ...viewport(world).pick(p.x, p.y)].filter(pickable), (n) => scene.sync.nodeIdOf(n));
    const mode: SelectMode = selectModeFor(e);
    if (mode === "replace") {
      const sameSpot = lastClick !== null && Math.hypot(p.x - lastClick.x, p.y - lastClick.y) < CLICK_SLOP;
      const { painted, bare } = partitionUIHits(viewport(world).pickUI(p.x, p.y));
      const all = orderClickHits(uiHitKeys(painted, scene.sync, pickable), hits, uiHitKeys([...bare, ...viewport(world).pickUICanvases(p.x, p.y)], scene.sync, pickable)); // canvases last (ADR 0117)
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
