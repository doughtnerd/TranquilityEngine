// Ed2 (api-and-models §7, contract H6): the segment view. Skeleton: the panel wrapper, the props, and the drag hook that
// calls `segmentDrag.ts` (Ed3 fills that). The lanes, ruler, tempo lane, zoom, scroll and playhead are Ed2's next commits.
import { useEffect, useMemo, useRef } from "preact/hooks";
import { editor, openAssetDocument } from "../../../../editor/sdk";
import type { AudioEventAsset } from "../../../../engine/audio/eventFormat";
import type { SegmentNode } from "../../../../engine/audio/musicFormat";
import { compileSegmentGrid } from "../../../../engine/audio/musicGrid";
import { openSegment } from "./index";
import { beginDrag, dragLabel, type DragHandle, type DragSession } from "./segmentDrag";
import type { SnapMode } from "./segmentSnap";
import { findSegment, replaceSegment, type Viewport } from "./segmentViewModel";
import type { PeaksService } from "./peaks";

/** How the view changes its segment: `drag` merges a drag's quick changes into one undo step. */
export type SegmentChange = (next: SegmentNode, options: { label: string; drag?: boolean }) => void;

export interface SegmentViewProps {
  readonly segment: SegmentNode;
  /** Length of the longest stem in seconds when known (the grid's `"end"`); NaN or absent: unknown. */
  readonly endSeconds?: number;
  /** The peaks service for the stem lanes; absent: lanes draw empty. */
  readonly peaks?: Pick<PeaksService, "get" | "peek">;
  /** File seconds of the playhead, or absent when nothing plays. */
  readonly playheadSeconds?: number;
  readonly snap?: SnapMode;
  readonly readOnly?: boolean;
  readonly onChange?: SegmentChange;
}

/**
 * The drag hook (H6): pointer-down on a handle starts `beginDrag`; moves apply the preview through `onChange` with
 * `drag: true`; Escape cancels and restores the segment the drag began from. Ed3 fills `beginDrag`; until then it returns
 * null and no session starts.
 */
export function useSegmentDrag(props: SegmentViewProps, view: Viewport) {
  const session = useRef<{ drag: DragSession; handle: DragHandle } | null>(null);
  const latest = useRef({ props, view });
  latest.current = { props, view };

  const start = (handle: DragHandle, x: number): boolean => {
    const { props: p, view: v } = latest.current;
    if (p.readOnly || !p.onChange) return false;
    const grid = compileSegmentGrid(p.segment, { endSeconds: p.endSeconds });
    const drag = beginDrag(handle, { segment: p.segment, grid, view: v, snap: p.snap ?? "beat" }, x);
    if (!drag) return false;
    session.current = { drag, handle };
    return true;
  };
  const move = (x: number, alt: boolean) => {
    const s = session.current;
    if (!s) return;
    const preview = s.drag.move(x, { alt });
    if (preview) latest.current.props.onChange?.(preview.segment, { label: dragLabel(s.handle), drag: true });
  };
  const end = () => void (session.current = null);
  const cancel = () => {
    const s = session.current;
    if (!s) return;
    session.current = null;
    latest.current.props.onChange?.(s.drag.cancel(), { label: dragLabel(s.handle), drag: true });
  };
  return { start, move, end, cancel, active: () => session.current !== null };
}

export function SegmentView(props: SegmentViewProps) {
  const root = useRef<HTMLDivElement>(null);
  const view: Viewport = { startSeconds: 0, pxPerSecond: 100, widthPx: 1 };
  const drag = useSegmentDrag(props, view);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && drag.active() && drag.cancel();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  return <div class="segment-view" ref={root} />;
}

/** The registered panel: the segment named by `openSegment`, edited through its event's asset document. */
export function SegmentViewPanel() {
  const open = openSegment.value;
  const project = editor.project.current;
  editor.project.version; // the file list changes with it
  if (!project || !open) return <p class="empty">Open a segment from the Event editor.</p>;
  if (!project.files.includes(open.event)) return <p class="empty">{open.event} isn't in the project any more.</p>;
  return <OpenSegment key={`${open.event}#${open.segmentId}`} path={open.event} segmentId={open.segmentId} />;
}

function OpenSegment({ path, segmentId }: { path: string; segmentId: string }) {
  const project = editor.project.current!;
  const doc = openAssetDocument<AudioEventAsset>(project, path, "audioEvent");
  useEffect(() => () => void doc.flush(), [doc]);
  const event = doc.value.value;
  const segment = useMemo(() => findSegment(event.musicRoot, segmentId), [event.musicRoot, segmentId]);
  if (!segment) return <p class="empty">{path} has no segment “{segmentId}”.</p>;
  const onChange: SegmentChange = (next, o) => {
    if (!event.musicRoot) return;
    doc.edit({ ...event, musicRoot: replaceSegment(event.musicRoot, segmentId, next) }, o.drag ? { coalesce: true, label: o.label } : { label: o.label });
  };
  return <SegmentView segment={segment} readOnly={doc.readOnly} onChange={onChange} />;
}
