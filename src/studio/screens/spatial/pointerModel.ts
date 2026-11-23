// What a press in the Scene view grabs and what dragging it does (the prototype's select/move, S:873-895, 1525-1546): the
// selected box's rotate knob and edge handles first, then the path being edited (its waypoints and "+" midpoints), then
// listeners and emitters near the pointer, then the smallest box under it. A drag keeps the grab offset (the object
// doesn't jump to the pointer); locked objects select but don't move; a moving emitter dragged slides along its path.
// Each drag edit carries its undo label (the prototype's: "Move listener", "Edit emitter", "Edit obstacle", …); the
// screen coalesces one drag into one step.
//
// Pure: no DOM, no signals.
import type { AudioTestScene, SceneBox } from "../../../engine/audio/spatial/testSceneTypes";
import { boxContains, boxEdges, planDistance, resizeFromEdge, rotateKnob, rotateToward, routeMidpoints, type P2 } from "./geometry";
import { shownInPlan } from "./outline";
import { allObjects, boxOf, findObject, moveObjectTo, moveRoutePoint, positionOf, setBox, type EditResult, type ObjectKind, type SceneObject } from "./sceneEdits";

/** How far beyond the north edge the rotate knob sits, in pixels (turned into metres by the view's zoom). */
export const KNOB_PX = 22;
/** How close a press must be to a point or handle, in pixels. */
export const GRAB_PX = 10;

export type Hit =
  | { readonly kind: "knob"; readonly id: string }
  | { readonly kind: "edge"; readonly id: string; readonly index: number }
  | { readonly kind: "waypoint"; readonly id: string; readonly index: number }
  | { readonly kind: "midpoint"; readonly id: string; readonly index: number }
  | { readonly kind: "object"; readonly id: string }
  | { readonly kind: "none" };

export interface HitContext {
  /** Metres per pixel at the current zoom. */
  readonly mpp: number;
  readonly selected: string | null;
  readonly pathEdit: string | null;
  /** Whether an object is in the elevation slab (objects outside it are dimmed but still pickable). */
  readonly visible?: (o: SceneObject) => boolean;
}

/** What a press at `p` grabs. */
export function hitTest(scene: AudioTestScene, p: P2, ctx: HitContext): Hit {
  const grab = GRAB_PX * ctx.mpp;
  const near = (q: P2) => planDistance(p, q) <= grab;
  const sel = ctx.selected ? findObject(scene, ctx.selected) : null;
  const selBox = sel && boxOf(sel);
  if (sel && selBox && !sel.obj.locked) {
    if (near(rotateKnob(selBox, KNOB_PX * ctx.mpp))) return { kind: "knob", id: sel.obj.id };
    const edge = boxEdges(selBox).findIndex(near);
    if (edge >= 0) return { kind: "edge", id: sel.obj.id, index: edge };
  }
  if (ctx.pathEdit) {
    const e = findObject(scene, ctx.pathEdit);
    if (e && e.kind === "emitter" && e.obj.kind === "moving") {
      const wp = e.obj.route.findIndex((q) => near(q));
      if (wp >= 0) return { kind: "waypoint", id: e.obj.id, index: wp };
      const mid = routeMidpoints(e.obj.route).findIndex(near);
      if (mid >= 0) return { kind: "midpoint", id: e.obj.id, index: mid };
    }
  }
  const shown = allObjects(scene).filter((o) => shownInPlan(scene, o) && (ctx.visible?.(o) ?? true));
  // Points: the nearest within reach (listeners and emitters sit over boxes).
  let best: { id: string; d: number } | null = null;
  for (const o of shown) {
    if (boxOf(o)) continue;
    const q = positionOf(o);
    if (!q) continue;
    const d = planDistance(p, q);
    if (d <= grab * 1.4 && (!best || d < best.d)) best = { id: o.obj.id, d };
  }
  if (best) return { kind: "object", id: best.id };
  // Boxes: the smallest under the pointer (a crate inside a zone picks the crate).
  const boxes = shown.map((o) => ({ o, b: boxOf(o) })).filter((x): x is { o: SceneObject; b: SceneBox } => !!x.b && boxContains(x.b, p));
  boxes.sort((a, b) => a.b.width * a.b.depth - b.b.width * b.b.depth);
  return boxes[0] ? { kind: "object", id: boxes[0].o.obj.id } : { kind: "none" };
}

/** A drag in progress. */
export type Drag =
  | { readonly kind: "move"; readonly id: string; /** The object's anchor minus the press point. */ readonly offset: P2 }
  | { readonly kind: "edge"; readonly id: string; readonly index: number }
  | { readonly kind: "knob"; readonly id: string }
  | { readonly kind: "waypoint"; readonly id: string; readonly index: number };

/** The drag a hit starts at `p`, or null (nothing to drag, a locked object, a 2D sound, a "+" press). */
export function beginDrag(scene: AudioTestScene, hit: Hit, p: P2): Drag | null {
  if (hit.kind === "none" || hit.kind === "midpoint") return null;
  const o = findObject(scene, hit.id);
  if (!o || o.obj.locked) return null;
  if (hit.kind === "knob") return { kind: "knob", id: hit.id };
  if (hit.kind === "edge") return { kind: "edge", id: hit.id, index: hit.index };
  if (hit.kind === "waypoint") return { kind: "waypoint", id: hit.id, index: hit.index };
  // A moving emitter slides along its path: it follows the pointer itself (projected), no offset.
  if (o.kind === "emitter" && o.obj.kind === "moving") return { kind: "move", id: hit.id, offset: { x: 0, z: 0 } };
  const anchor = positionOf(o);
  if (!anchor) return null;
  return { kind: "move", id: hit.id, offset: { x: anchor.x - p.x, z: anchor.z - p.z } };
}

/** The undo label of editing an object of `kind` (the prototype's history words). */
export function editLabel(kind: ObjectKind, move = false): string {
  switch (kind) {
    case "listener":
      return "Move listener";
    case "emitter":
      return move ? "Move emitter" : "Edit emitter";
    case "obstacle":
      return "Edit obstacle";
    case "reverbZone":
      return "Edit reverb zone";
    case "audioZone":
      return "Edit audio zone";
    case "sound2d":
      return "Edit 2D sound";
  }
}

/** The scene with the drag at `p`, and its undo label. */
export function dragTo(scene: AudioTestScene, drag: Drag, p: P2): { result: EditResult<AudioTestScene>; label: string } {
  const o = findObject(scene, drag.id);
  if (!o) return { result: { refused: "it isn't in the scene any more" }, label: "Edit" };
  switch (drag.kind) {
    case "move":
      return { result: moveObjectTo(scene, drag.id, { x: p.x + drag.offset.x, z: p.z + drag.offset.z }), label: editLabel(o.kind, true) };
    case "edge":
    case "knob": {
      const b = boxOf(o);
      if (!b) return { result: { refused: "it has no box" }, label: editLabel(o.kind) };
      return { result: setBox(scene, drag.id, drag.kind === "edge" ? resizeFromEdge(b, drag.index, p) : rotateToward(b, p)), label: editLabel(o.kind) };
    }
    case "waypoint":
      return { result: moveRoutePoint(scene, drag.id, drag.index, p), label: "Edit path" };
  }
}

/** What has the keyboard focus, as far as the plan's hover cares (an `Element` fits it). */
export interface FocusHolder {
  readonly tagName: string;
  readonly isContentEditable?: boolean;
  readonly type?: string;
  closest?(selector: string): unknown;
}

const TYPING_INPUTS = new Set(["", "text", "search", "number", "email", "password", "tel", "url"]);

/**
 * Whether the pointer entering the plan takes the keyboard focus to it (D27, the prototype's S:1524), so Space pans,
 * +/−/0 zoom and the arrows pan while the pointer is over the plan, rather than Space playing the scene. It doesn't take
 * focus from a field being typed in, an open menu or a dialog.
 */
export function hoverTakesFocus(active: FocusHolder | null): boolean {
  if (!active) return true;
  const tag = active.tagName.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT" || active.isContentEditable) return false;
  if (tag === "INPUT" && TYPING_INPUTS.has((active.type ?? "").toLowerCase())) return false;
  return !active.closest?.('[role="dialog"], [role="menu"], [role="listbox"]');
}
