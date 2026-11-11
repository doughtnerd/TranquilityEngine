// Ed3: dragging cues, region edges and tempo markers. Pointer positions are exact grid points at 100 px/s and 120 bpm
// 4/4 (a beat is 0.5 s = 50 px, a bar 2 s = 200 px, so bar N is at x = 200 (N - 1)); snap is "off" except where a case
// names the snap leaf, so the cases do not depend on it.
import { describe, expect, it } from "vitest";
import { compileSegmentGrid, positionTextToTicks } from "../../../../engine/audio/musicGrid";
import type { SegmentNode, TempoMarker } from "../../../../engine/audio/musicFormat";
import { beginDrag, dragLabel, type DragContext, type DragHandle } from "./segmentDrag";
import type { SnapMode } from "./segmentSnap";
import type { Viewport } from "./segmentViewModel";

const m = (at: string, bpm: number, beatsPerBar = 4, beatUnit = 4): TempoMarker => ({ at, bpm, beatsPerBar, beatUnit });
const view: Viewport = { startSeconds: 0, pxPerSecond: 100, widthPx: 4000 };

function seg(over: Partial<SegmentNode> = {}): SegmentNode {
  return {
    type: "segment", id: "s", volume: 1, pitch: 0, volumeRandom: [0, 0], pitchRandom: [0, 0], delay: 0, automation: [],
    gridOffset: 0, tempo: [m("1:1:0", 120)], cues: [{ name: "a", at: "2:1:0" }, { name: "b", at: "4:1:0" }],
    regions: [{ id: "loop", from: "2:1:0", to: "4:1:0", count: 0 }], tracks: [], plays: 1, ...over,
  } as unknown as SegmentNode;
}

const ctx = (segment: SegmentNode, snap: SnapMode = "off", endSeconds?: number): DragContext => ({
  segment, grid: compileSegmentGrid(segment, { endSeconds }), view, snap,
});
const still = { alt: false };
const ticks = (s: SegmentNode, text: string) => positionTextToTicks(compileSegmentGrid(s), text);

describe("cue drag", () => {
  const h: DragHandle = { kind: "cue", name: "a" }; // at 2:1:0 = x 200

  it("stores the dragged cue as a position on the grid and leaves the rest alone", () => {
    const base = seg();
    const d = beginDrag(h, ctx(base), 200)!;
    const p = d.move(550, still)!; // 5.5 s = beat 11 = bar 3 beat 4
    expect(p.text).toBe("3:4:0");
    expect(p.segment.cues).toEqual([{ name: "a", at: "3:4:0" }, { name: "b", at: "4:1:0" }]);
    expect(p.segment.regions).toBe(base.regions);
    expect(p.segment.tempo).toBe(base.tempo);
  });

  it("keeps the grab offset: a drag from beside the handle does not jump", () => {
    const d = beginDrag(h, ctx(seg()), 204)!;
    expect(d.move(254, still)!.text).toBe("2:2:0");
  });

  it("an off-grid drop is whole ticks of a position, not seconds", () => {
    const d = beginDrag(h, ctx(seg()), 200)!;
    expect(d.move(225, still)!.text).toBe("2:1:480");
  });

  it("never goes before 1:1:0; previews are rebuilt from the base, so returning gives the base itself", () => {
    const base = seg();
    const d = beginDrag(h, ctx(base), 200)!;
    expect(d.move(-300, still)!.text).toBe("1:1:0");
    expect(d.move(200, still)!.segment).toBe(base);
    expect(d.cancel()).toBe(base);
  });

  it("goes to \"end\" at the end of the audio and \"start\" in the pickup", () => {
    const d = beginDrag(h, ctx(seg({ gridOffset: 0.5 }), "off", 10), 250)!; // bar 2 is at 2.5 s
    expect(d.move(2000, still)!.text).toBe("end");
    expect(d.move(-20, still)!.text).toBe("start");
    expect(d.move(30, still)!.text).toBe("1:1:0"); // between the file start and 1:1:0 there is no position text
  });

  it("is not draggable when the cue does not exist", () => {
    expect(beginDrag({ kind: "cue", name: "zzz" }, ctx(seg()), 0)).toBeNull();
  });

  it("with the beat snap on lands on a beat, and Alt turns it off (needs L-Ed3a)", () => {
    const d = beginDrag(h, ctx(seg(), "beat"), 200)!;
    expect(d.move(222, still)!.text).toBe("2:1:0");
    expect(d.move(230, still)!.text).toBe("2:2:0");
    expect(d.move(230, { alt: true })!.text).not.toBe("2:2:0");
  });
});

describe("region drag", () => {
  it("moves each edge and keeps the edges in order", () => {
    const f = beginDrag({ kind: "region", id: "loop", edge: "from" }, ctx(seg()), 200)!;
    expect(f.move(0, still)!.segment.regions[0]).toMatchObject({ from: "1:1:0", to: "4:1:0" });
    expect(f.move(600, still)).toBeNull(); // onto the other edge
    expect(f.move(1000, still)).toBeNull(); // past it
    const t = beginDrag({ kind: "region", id: "loop", edge: "to" }, ctx(seg()), 600)!;
    expect(t.move(800, still)!.segment.regions[0]).toMatchObject({ from: "2:1:0", to: "5:1:0" });
    expect(t.move(200, still)).toBeNull();
  });

  it("\"to\" can be dragged onto the end of the audio and \"from\" onto the file start", () => {
    const t = beginDrag({ kind: "region", id: "loop", edge: "to" }, ctx(seg(), "off", 12), 600)!;
    expect(t.move(5000, still)!.segment.regions[0].to).toBe("end");
    const f = beginDrag({ kind: "region", id: "loop", edge: "from" }, ctx(seg({ gridOffset: 1 }), "off", 12), 300)!;
    expect(f.move(-50, still)!.segment.regions[0].from).toBe("start");
  });

  it("is not draggable when the region does not exist", () => {
    expect(beginDrag({ kind: "region", id: "x", edge: "to" }, ctx(seg()), 0)).toBeNull();
  });
});

describe("tempo marker drag", () => {
  /** 120 bpm to 3:1:0 (4 s, x 400), then 60 bpm 4/4 (a tempo-only marker). */
  const twoTempos = () => seg({
    tempo: [m("1:1:0", 120), m("3:1:0", 60)],
    cues: [{ name: "c", at: "4:2:0" }, { name: "d", at: "end" }],
    regions: [{ id: "loop", from: "3:1:0", to: "5:1:0", count: 0 }],
  });

  it("moves the marker by whole beats; later cues and regions keep their ticks, only their seconds change", () => {
    const base = twoTempos();
    const d = beginDrag({ kind: "tempo", index: 1 }, ctx(base), 400)!;
    const p = d.move(500, still)!; // 5 s = tick 9600 = 3:3:0
    expect(p.text).toBe("3:3:0");
    expect(p.segment.tempo[1]).toMatchObject({ at: "3:3:0", bpm: 60 });
    expect(p.segment.cues).toEqual(base.cues); // a tempo-only marker keeps the bar numbering
    expect(p.segment.regions).toEqual(base.regions);
    const a = compileSegmentGrid(base), b = compileSegmentGrid(p.segment);
    expect(b.startTick[1]).toBe(9600);
    expect(b.cueTicks[0]).toBe(a.cueTicks[0]);
    // The 120 bpm span grew by a beat, so what follows plays a beat's worth of seconds later.
    expect(b.startSeconds[1]).toBeCloseTo(a.startSeconds[1] + 1, 9);
  });

  it("after a moved metre change the later position text is rewritten so the cue stays on its beat", () => {
    // 4/4, then 3/4 from 3:1:0 (tick 7680); the cue is on tick 10560 = 4:1:0.
    const base = seg({ tempo: [m("1:1:0", 120), m("3:1:0", 120, 3)], cues: [{ name: "c", at: "4:1:0" }], regions: [] });
    const d = beginDrag({ kind: "tempo", index: 1 }, ctx(base), 400)!;
    const p = d.move(200, still)!; // the change moves to bar 2 (tick 3840)
    expect(p.text).toBe("2:1:0");
    const a = compileSegmentGrid(base), b = compileSegmentGrid(p.segment);
    expect(b.startTick[1]).toBe(3840);
    expect(p.segment.cues[0].at).toBe("4:2:0"); // 6720 ticks = 7 beats into 3/4 from bar 2
    expect(b.cueTicks[0]).toBe(a.cueTicks[0]);
    expect(ticks(p.segment, "4:2:0")).toBe(a.cueTicks[0]);
  });

  it("a metre change snaps to a bar line even with Alt held", () => {
    const base = seg({ tempo: [m("1:1:0", 120), m("3:1:0", 120, 3)], cues: [], regions: [] });
    const d = beginDrag({ kind: "tempo", index: 1 }, ctx(base), 400)!;
    expect(d.move(250, { alt: true })!.text).toBe("2:1:0");
  });

  it("stays strictly between its neighbours; marker 0 and unknown markers are not draggable", () => {
    const base = seg({ tempo: [m("1:1:0", 120), m("2:1:0", 120), m("3:1:0", 120)], cues: [], regions: [] });
    const d = beginDrag({ kind: "tempo", index: 1 }, ctx(base), 200)!;
    expect(d.move(0, still)).toBeNull(); // onto marker 0
    expect(d.move(400, still)).toBeNull(); // onto marker 2
    expect(d.move(250, still)!.text).toBe("2:2:0");
    expect(beginDrag({ kind: "tempo", index: 0 }, ctx(base), 0)).toBeNull();
    expect(beginDrag({ kind: "tempo", index: 3 }, ctx(base), 0)).toBeNull();
  });

  it("refuses a move that would strand a later metre change off its bar line", () => {
    // 4/4, 3/4 from 2:1:0 (tick 3840), 4/4 from tick 9600 (two 3/4 bars on). Moving the first change to bar 3 leaves the
    // second one on beat 3 of a 3/4 bar.
    const base = seg({ tempo: [m("1:1:0", 120), m("2:1:0", 120, 3), m("4:1:0", 120, 4)], cues: [], regions: [] });
    expect(compileSegmentGrid(base).startTick[2]).toBe(9600);
    const d = beginDrag({ kind: "tempo", index: 1 }, ctx(base), 200)!;
    expect(d.move(400, still)).toBeNull();
    expect(d.move(200, still)!.segment).toBe(base);
  });

  it("cancel returns the segment the drag began from", () => {
    const base = twoTempos();
    const d = beginDrag({ kind: "tempo", index: 1 }, ctx(base), 400)!;
    d.move(500, still);
    expect(d.cancel()).toBe(base);
  });
});

describe("dragLabel", () => {
  it("names each undo step", () => {
    expect(dragLabel({ kind: "cue", name: "a" })).toBe("Move cue a");
    expect(dragLabel({ kind: "region", id: "r", edge: "to" })).toBe("Move region r to");
    expect(dragLabel({ kind: "tempo", index: 1 })).toBe("Move tempo marker 2");
  });
});
