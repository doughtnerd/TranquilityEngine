// Ed3 (api-and-models §7, contract H6): dragging cues, region edges and tempo markers in the segment view, with snapping
// (`segmentSnap.ts`) and undo. `SegmentView.tsx`'s drag hook calls `beginDrag` on a pointer-down over a handle, `move` on
// each pointer move (it applies the preview through the asset document with `coalesce: true`, so one drag is one undo step)
// and `cancel` on Escape. Ed2's skeleton: `beginDrag` returns null (nothing draggable) until Ed3 fills it.
import type { SegmentGrid } from "../../../../engine/audio/musicGrid";
import type { SegmentNode } from "../../../../engine/audio/musicFormat";
import type { SnapMode } from "./segmentSnap";
import type { Viewport } from "./segmentViewModel";

/** Something the view draws that can be dragged. */
export type DragHandle =
  | { readonly kind: "cue"; /** `MusicCue.name` */ readonly name: string }
  | { readonly kind: "region"; /** `MusicRegion.id` */ readonly id: string; readonly edge: "from" | "to" }
  | { readonly kind: "tempo"; /** index in `SegmentNode.tempo`; marker 0 is not draggable */ readonly index: number };

/** What a drag works from; the view builds it at pointer-down and the session keeps it. */
export interface DragContext {
  /** The segment as it is at pointer-down: the session's base, and what `cancel` restores. */
  readonly segment: SegmentNode;
  /** `compileSegmentGrid(segment, ...)` of that segment. */
  readonly grid: SegmentGrid;
  /** The viewport at pointer-down (the view does not rescale during a drag). */
  readonly view: Viewport;
  /** The snap mode chosen in the toolbar; the session uses `"off"` while `modifiers.alt` is held. */
  readonly snap: SnapMode;
}

/** The result of a pointer move. */
export interface DragPreview {
  /** The whole segment with the handle moved (positions stay canonical `bar:beat:tick` text). */
  readonly segment: SegmentNode;
  /** The position text the handle now sits at, for the readout next to the pointer (`"12:3:0"`). */
  readonly text: string;
}

export interface DragModifiers {
  readonly alt: boolean;
}

export interface DragSession {
  /** Pointer at x (CSS px, the same origin as the viewport). Null when the position is not allowed (the view keeps the last preview). */
  move(x: number, modifiers: DragModifiers): DragPreview | null;
  /** The segment to restore: `context.segment`. */
  cancel(): SegmentNode;
}

/** The undo step's label for a drag of `handle`. */
export function dragLabel(handle: DragHandle): string {
  switch (handle.kind) {
    case "cue": return `Move cue ${handle.name}`;
    case "region": return `Move region ${handle.id} ${handle.edge}`;
    case "tempo": return `Move tempo marker ${handle.index + 1}`;
  }
}

/** Ed3 fills this. Skeleton: nothing is draggable, so the view's drag hook never starts a session. */
export function beginDrag(handle: DragHandle, context: DragContext, startX: number): DragSession | null {
  void handle; void context; void startX;
  return null;
}
