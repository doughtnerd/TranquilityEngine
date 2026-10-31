// Viewport selection (ADR 0022, 0026): a plain left click picks the topmost renderer under the
// pointer and selects its document node; clicking the same spot again cycles through overlapping
// hits; clicking empty space clears. The selection is outlined in the viewport, and the scene
// camera's F key frames it.
import { effect } from "@preact/signals";
import type { Engine, GameObject } from "../engine";
import { gizmoActive, pick, setSelectionOutline, viewportCanvas } from "../engine/editor";
import type { OrbitCamera } from "./OrbitCamera";
import { docVersion, openScene, selectedWorldNode, selection } from "./state";

/** Pointer travel (CSS pixels) under which a press and release count as a click, not a drag. */
export const CLICK_SLOP = 4;

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

/** Hook selection up to the viewport. Returns a function that removes it. */
export function installViewportSelection(engine: Engine, camera: OrbitCamera): () => void {
  const world = engine.world;
  camera.focusTarget = () => {
    const node = selectedWorldNode();
    return node?.isValid && node.transform ? node.transform.worldPosition : null;
  };

  // Outline the selection; re-run when it changes or the document is edited (nodes may be rebuilt).
  const stopOutline = effect(() => {
    docVersion.value;
    const node = selectedWorldNode();
    setSelectionOutline(world, node ? [node] : []);
  });

  const canvas = viewportCanvas(world);
  if (!canvas) return stopOutline;

  let down: PointerSample | null = null;
  let lastClick: { x: number; y: number } | null = null;
  const sample = (e: PointerEvent): PointerSample => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, button: e.button, alt: e.altKey };
  };
  const onDown = (e: PointerEvent) => {
    // Presses on a gizmo handle drag the gizmo; they never change the selection.
    const p = sample(e);
    down = e.button === 0 && !gizmoActive(world, p.x, p.y) ? p : null;
  };
  const onUp = (e: PointerEvent) => {
    const start = down;
    down = null;
    const scene = openScene.value;
    if (!start || !scene) return;
    const p = sample(e);
    if (!isPlainClick(start, p)) return;
    const hits = hitIds(pick(world, p.x, p.y), (n) => scene.sync.nodeIdOf(n));
    const sameSpot = lastClick !== null && Math.hypot(p.x - lastClick.x, p.y - lastClick.y) < CLICK_SLOP;
    selection.value = chooseSelection(hits, selection.value, sameSpot);
    lastClick = { x: p.x, y: p.y };
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  return () => {
    stopOutline();
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointerup", onUp);
    camera.focusTarget = null;
  };
}
