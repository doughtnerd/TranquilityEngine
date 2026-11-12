// Opening the segment view also shows its Segment Properties panel (the view goes in front).
import { afterEach, describe, expect, it, vi } from "vitest";
import { editor } from "../../../../editor/sdk";
import { openSegment, openSegmentView, SEGMENT_PANEL, SEGMENT_VIEW_PANEL } from "./index";

afterEach(() => { vi.restoreAllMocks(); openSegment.value = null; });

describe("openSegmentView", () => {
  it("shows the view and Segment Properties, ending with the view in front", () => {
    const shown: string[] = [];
    vi.spyOn(editor, "showPanel").mockImplementation((id) => void shown.push(id));
    openSegmentView("m.audioevent.json", "a");
    expect(openSegment.value).toEqual({ event: "m.audioevent.json", segmentId: "a" });
    expect(shown).toContain(SEGMENT_PANEL);
    expect(shown[0]).toBe(SEGMENT_VIEW_PANEL);
    expect(shown.at(-1)).toBe(SEGMENT_VIEW_PANEL);
  });
});
