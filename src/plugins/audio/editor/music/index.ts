// The music panels of the Audio plugin's editor half (api-and-models §7, contract H6). `editor/index.ts` calls
// `registerMusicPanels` once; later tasks add their panels here and nowhere else:
//   Ed2: the segment view (`SegmentView.tsx`);  Ed4: `SegmentPanel.tsx` (beside the view);  Ed6: `RulesTable.tsx`.
import { signal } from "@preact/signals";
import { editor, type EditorPluginContext } from "../../../../editor/sdk";

/** The segment open in the segment view: the event asset and the segment's id in it, or null. */
export const openSegment = signal<{ readonly event: string; readonly segmentId: string } | null>(null);

/** The music container (playlist or music switch) whose rules the Rules panel shows: event path and node id, or null. */
export const openRules = signal<{ readonly event: string; readonly nodeId: string } | null>(null);

export const SEGMENT_VIEW_PANEL = "audiosegment";
export const SEGMENT_PANEL = "audiosegmentpanel";
export const RULES_PANEL = "audiorules";

/** Open segment `segmentId` of the event `event` in the segment view, bring it forward and show its Segment Properties beside it. */
export function openSegmentView(event: string, segmentId: string): void {
  openSegment.value = { event, segmentId };
  // Properties joins the view's dock when first shown (`beside`), so the view goes first; the view ends in front.
  editor.showPanel(SEGMENT_VIEW_PANEL);
  editor.showPanel(SEGMENT_PANEL);
  editor.showPanel(SEGMENT_VIEW_PANEL);
}

/** Open the Rules panel on the music container `nodeId` of `event`. */
export function openRulesTable(event: string, nodeId: string): void {
  openRules.value = { event, nodeId };
  editor.showPanel(RULES_PANEL);
}

/** Register the music panels. All three are on demand: they open from a music node in the Event editor. */
export function registerMusicPanels(context: EditorPluginContext): void {
  context.registerPanel({
    id: SEGMENT_VIEW_PANEL,
    title: "Segment",
    onDemand: true,
    view: () => import("./SegmentView").then((m) => m.SegmentViewPanel),
  });
  context.registerPanel({
    id: SEGMENT_PANEL,
    title: "Segment Properties",
    beside: SEGMENT_VIEW_PANEL,
    onDemand: true,
    view: () => import("./SegmentPanel").then((m) => m.SegmentPanel),
  });
  context.registerPanel({
    id: RULES_PANEL,
    title: "Transition Rules",
    onDemand: true,
    view: () => import("./RulesTable").then((m) => m.RulesTable),
  });
}
