import { describe, expect, it } from "vitest";
import { lintPlaylist } from "../../../../engine/audio/playlist/lint";
import { clipChips, clipFollows, clipLoops, clipMarkers, clipPlan, clipToSource, drawnLoopBand, loopBand, wavePieces } from "./clipGeometry";
import { fixtureBody, fixtureSequence, fixtureSource } from "./sequenceFixture";
import { beatSeconds, beatsPerBar, DEFAULT_SNAP, keepTaps, nudgeStep, snapSpan, snapTime, tapTempo } from "./sequenceGrid";
import { clipLength, findClip, nextId, onSequence, sequenceLength } from "./sequenceModel";
import { warningLines } from "./sequenceLints";
import { clickClip, clickPoint, EMPTY_SELECTION, marqueeSelect, pressClip, pruneSelection, selectAll, selectLoop } from "./sequenceSelection";
import { clampTimeline, fitTimeline, followView, rowAt, snapEdges, thumbOf, trackIndexAt, trackRows, viewFromThumb, zoomTimeline } from "./timelineLayout";
import { DEFAULT_TRANSPORT, estimatePlayhead, hasHeldLoop, playRange, restingPlayhead, spaceAction } from "./transportModel";

const seq = fixtureSequence();
const c = (id: string) => findClip(seq, id)!.clip;

describe("sequence model", () => {
  it("resolves a 0 length to the end of the source, and the sequence's to its longest clip", () => {
    expect(clipLength({ ...c("c2"), length: 0 }, fixtureSource(c("c2")))).toBe(4);
    expect(clipLength({ ...c("c2"), length: 0, offset: 1 }, fixtureSource(c("c2")))).toBe(3);
    expect(clipLength({ ...c("c4"), length: 0 }, null)).toBe(2);
    expect(sequenceLength(seq, fixtureSource)).toBe(6);
    expect(sequenceLength({ ...seq, length: 0 }, fixtureSource)).toBe(4.5);
    expect(sequenceLength({ ...seq, length: 0, tracks: [] }, fixtureSource)).toBe(4);
  });

  it("makes fresh ids and lifts sequence edits into body edits", () => {
    expect(nextId("c", ["c1", "c2", "c4"])).toBe("c3");
    const body = fixtureBody();
    const same = onSequence((s) => ({ next: s }))(body);
    expect("next" in same && same.next).toBe(body);
    const changed = onSequence((s) => ({ next: { ...s, length: 9 } }))(body);
    expect("next" in changed && changed.next.sequence!.length).toBe(9);
    expect("refused" in onSequence((s) => ({ next: s }))({ ...body, sequence: null })).toBe(true);
  });
});

describe("grid and snapping", () => {
  it("has a beat of 0.5 s without a tempo and the meter's beats per bar", () => {
    expect(beatSeconds(null)).toBe(0.5);
    expect(beatSeconds({ bpm: 90, meter: "3/4" })).toBeCloseTo(2 / 3);
    expect(beatsPerBar({ bpm: 90, meter: "3/4" })).toBe(3);
    // The nudge step is the grid's (10 ms with the grid off).
    expect(nudgeStep({ ...DEFAULT_SNAP, mode: "bar" }, { bpm: 120, meter: "4/4" })).toBe(2);
    expect(nudgeStep({ ...DEFAULT_SNAP, mode: "1000smp" }, null)).toBeCloseTo(1000 / 48000);
    expect(nudgeStep({ ...DEFAULT_SNAP, mode: "custom", custom: 0.3 }, null)).toBe(0.3);
    expect(nudgeStep({ ...DEFAULT_SNAP, mode: "off" }, null)).toBe(0.01);
    expect(snapTime(0.333, { snap: { ...DEFAULT_SNAP, mode: "off", edges: false }, tempo: null, span: 10, edges: [] })).toBe(0.333);
  });

  it("snaps to an edge within 0.8 % of the visible span, else to the grid", () => {
    const tempo = { bpm: 120, meter: "4/4" };
    expect(snapTime(0.26, { snap: DEFAULT_SNAP, tempo, span: 10, edges: [] })).toBe(0.5);
    expect(snapTime(0.26, { snap: { ...DEFAULT_SNAP, mode: "quarter" }, tempo, span: 10, edges: [] })).toBe(0.25);
    expect(snapTime(1.0, { snap: DEFAULT_SNAP, tempo, span: 10, edges: [1.07] })).toBe(1.07);
    expect(snapTime(1.0, { snap: DEFAULT_SNAP, tempo, span: 10, edges: [1.09] })).toBe(1);
    expect(snapTime(1.13, { snap: DEFAULT_SNAP, tempo, span: 10, edges: [], free: true })).toBe(1.13);
    expect(snapTime(-1, { snap: DEFAULT_SNAP, tempo, span: 10, edges: [] })).toBe(0);
    // A moved clip snaps its end to an edge too.
    expect(snapSpan(0.97, 1, { snap: DEFAULT_SNAP, tempo, span: 10, edges: [2] })).toBe(1);
  });

  it("taps a tempo from the last intervals, starting again after a pause", () => {
    expect(tapTempo([0, 500, 1000, 1500])).toBe(120);
    expect(tapTempo([0, 500, 5000, 5400])).toBe(150);
    expect(tapTempo([0])).toBeNull();
    expect(keepTaps([0, 500], 4000)).toEqual([4000]);
  });
});

describe("clip geometry", () => {
  const c1 = c("c1");
  const src = fixtureSource(c1);
  const plan = clipPlan(c1, src);

  it("applies the clip's loop override over the sample's loop", () => {
    const [l] = clipLoops(c1, src);
    expect(l).toMatchObject({ id: "L1", start: 0.4, end: 0.9, active: "parameter", reentry: "reenter", exit: "finish", overridden: true });
    expect(clipLoops(c("c2"), fixtureSource(c("c2")))[0]!.overridden).toBe(false);
  });

  it("maps clip time to sample time as pickup and first pass, extra passes, then the tail", () => {
    expect(plan).toMatchObject({ pre: 0.9, avail: 1, length: 3 });
    expect(clipToSource(plan, 0.3)).toBeCloseTo(0.3);
    expect(clipToSource(plan, 1.0)).toBeCloseTo(0.5);
    expect(clipToSource(plan, 2.0)).toBeCloseTo(1.0);
    expect(clipToSource(plan, 2.95)).toBeCloseTo(1.95);
    // Past the sample: silent.
    expect(clipToSource(clipPlan({ ...c1, loops: {} }, { ...src!, loops: [] }), 2.5)).toBeNull();
  });

  it("draws the passes as waveform pieces with dividers, and a zero-length loop as a hold", () => {
    expect(wavePieces(plan).map((p) => [p.at, +p.length.toFixed(3), p.src])).toEqual([[0, 0.9, 0], [0.9, 0.5, 0.4], [1.4, 0.5, 0.4], [1.9, 1.1, 0.9]]);
    expect(loopBand(plan)).toMatchObject({ start: 0.4, end: 1.9, dividers: [0.9, 1.4], hold: false, active: "parameter" });
    const hold = clipPlan(c1, { ...src!, loops: [{ ...src!.loops[0]!, start: 0.5, end: 0.5 }] });
    expect(loopBand(hold)).toMatchObject({ hold: true });
    expect(wavePieces(hold).some((p) => p.hold)).toBe(true);
  });

  it("ADR 0362: draws a reversed clip's loop band and markers mirrored, where they are heard", () => {
    // Forward: band 0.4–1.9 with passes from 0.9 and 1.4 on a 3 s clip; reversed clip time u plays the map at 3 − u.
    const band = drawnLoopBand(plan, true)!;
    expect([band.start, band.end].map((x) => +x.toFixed(3))).toEqual([1.1, 2.6]);
    expect(band.dividers.map((x) => +x.toFixed(3))).toEqual([1.6, 2.1]);
    expect(drawnLoopBand(plan, false)).toEqual(loopBand(plan));
    const ms = clipMarkers({ ...c1, reverse: true }, src, plan);
    expect(ms.map((m) => [m.id, +m.at.toFixed(3)])).toEqual([["k1", 0.8], ["k2", 2.8]]);
  });

  it("places sample markers on the first pass or the tail, flagging hidden ones", () => {
    const ms = clipMarkers({ ...c1, hiddenMarkers: ["k2"] }, src, plan);
    expect(ms.map((m) => [m.id, +m.at.toFixed(3), m.hidden])).toEqual([["k1", 2.2, false], ["k2", 0.2, true]]);
  });

  it("shows the activation, binding, effects, playlist pick and follows chips", () => {
    expect(clipChips(c1, src, { follows: false }).map((x) => x.text)).toEqual(["P", "P brake > 0.10", "FX 1"]);
    const unbound = { ...c1, loops: { L1: { active: "parameter" as const } } };
    expect(clipChips(unbound, src, { follows: false }).map((x) => x.kind)).toContain("unbound");
    expect(clipChips(c("c4"), null, { follows: false, playlistName: "stingers" }).map((x) => x.text)).toEqual(["→ stingers"]);
  });

  it("follows only a sync clip it's chained over on its own track, never one on a parallel track (decision 4)", () => {
    // c3 (Music B) overlaps c2 (Music) on a parallel track: both are Sync to the sequence clock.
    expect(clipFollows(seq, "c3", fixtureSource)).toBeNull();
    expect(clipFollows(seq, "c2", fixtureSource)).toBeNull();
    // Stems: every track's clip starts at 0, all Sync.
    const stem = (t: number) => ({ ...seq.tracks[1]!, id: `s${t}`, name: `Stem ${t}`, clips: [{ ...c("c2"), id: `k${t}`, at: 0 }] });
    const stems = { ...seq, tracks: [stem(1), stem(2), stem(3)] };
    expect(["k1", "k2", "k3"].map((id) => clipFollows(stems, id, fixtureSource))).toEqual([null, null, null]);
    // Chained on one track: c5 overlaps the end of c2 and follows it; c6 starts where c2 ends and doesn't.
    const music = { ...seq.tracks[1]!, clips: [c("c2"), { ...c("c2"), id: "c5", at: 4, length: 2 }, { ...c("c2"), id: "c6", at: 6, length: 2 }] };
    const chained = { ...seq, tracks: [music] };
    expect(clipFollows(chained, "c5", fixtureSource)?.id).toBe("c2");
    expect(clipFollows(chained, "c6", fixtureSource)).toBeNull();
    expect(clipFollows(chained, "c2", fixtureSource)).toBeNull();
    // An Async clip never follows.
    const async = { ...seq, tracks: [{ ...music, clips: [c("c2"), { ...c("c2"), id: "c5", at: 4, sync: false }] }] };
    expect(clipFollows(async, "c5", fixtureSource)).toBeNull();
  });

  it("lists warnings without the stems' overlap or the timeline's own, naming clips instead of their ids", () => {
    const stems = { ...seq, tracks: [seq.tracks[1]!, { ...seq.tracks[2]!, clips: [{ ...c("c3"), at: 0.5 }] }] };
    const body = fixtureBody(stems);
    const lints = lintPlaylist(body, { sampleTempo: () => ({ bpm: 90 }) });
    expect(lints.map((l) => l.code)).not.toContain("overlappingSyncLoops");
    const lines = warningLines(lints, body);
    expect(lines.some((l) => l.includes("overlap"))).toBe(false);
    expect(lines).toContain("Sync clip music_loop plays a sample at 90 BPM in a 120 BPM sequence; it isn't stretched.");
    expect(lines.join(" ")).not.toMatch(/"c\d"/);
    const unbound = fixtureBody({ ...seq, loops: [{ ...seq.loops[0]!, active: "parameter" }] });
    expect(warningLines(lintPlaylist(unbound), unbound).some((l) => l.includes("names none"))).toBe(false);
  });
});

describe("selection", () => {
  it("selects, toggles with Shift/Ctrl, keeps a pressed group, and selects all", () => {
    let sel = clickClip(EMPTY_SELECTION, "c1", "t1");
    expect(sel).toMatchObject({ focus: "clips", clips: ["c1"], track: "t1" });
    sel = clickClip(sel, "c2", "t2", { shift: true });
    expect(sel.clips).toEqual(["c1", "c2"]);
    expect(pressClip(sel, "c1", "t1").clips).toEqual(["c1", "c2"]);
    expect(clickClip(sel, "c1", "t1", { ctrl: true }).clips).toEqual(["c2"]);
    expect(selectAll(seq, sel).clips).toEqual(["c1", "c2", "c3", "c4"]);
  });

  it("marquees the clips a box touches", () => {
    expect(marqueeSelect(seq, fixtureSource, EMPTY_SELECTION, 1.5, 2.2, 1, 3).clips).toEqual(["c2", "c3"]);
    expect(marqueeSelect(seq, fixtureSource, clickClip(EMPTY_SELECTION, "c1", "t1"), 1.5, 2.2, 1, 1, true).clips).toEqual(["c1", "c2"]);
  });

  it("selects points per lane and drops what an edit removed", () => {
    let sel = clickPoint(EMPTY_SELECTION, { clip: "c1" }, "a1", 1);
    sel = clickPoint(sel, { clip: "c1" }, "a1", 2, { shift: true });
    expect(sel.points!.keys).toEqual([1, 2]);
    expect(sel.focus).toBe("points");
    const fewer = { ...seq, tracks: seq.tracks.map((t) => (t.id === "t1" ? { ...t, clips: t.clips.map((x) => ({ ...x, automation: [{ ...x.automation[0]!, curve: x.automation[0]!.curve.slice(0, 2) }] })) } : t)) };
    expect(pruneSelection(fewer, sel).points!.keys).toEqual([1]);
    expect(pruneSelection({ ...seq, loops: [] }, selectLoop(sel, "l1")).focus).toBe("sequence");
    const keep = clickClip(EMPTY_SELECTION, "c1", "t1");
    expect(pruneSelection(seq, keep)).toBe(keep);
  });
});

describe("timeline layout", () => {
  it("stacks tracks and their open lanes and says what a y is over", () => {
    const { rows, height } = trackRows(seq, new Set(["t1"]));
    expect(rows.map((r) => [r.y, r.lanes.length])).toEqual([[0, 1], [122, 0], [190, 0], [258, 0]]); // proto: 68 px tracks, 54 px lanes
    expect(height).toBe(326);
    expect(rowAt(rows, 10)).toEqual({ kind: "track", ti: 0 });
    expect(rowAt(rows, 70)).toEqual({ kind: "lane", ti: 0, automation: "a1" });
    expect(rowAt(rows, 400)).toEqual({ kind: "below" });
    expect(trackIndexAt(rows, 400)).toBe(3);
  });

  it("fits, zooms about a time, follows the playhead and works the scrollbar thumb", () => {
    expect(fitTimeline(10)).toEqual({ start: 0, end: 10.8 });
    const z = zoomTimeline({ start: 0, end: 10 }, 2, 5, 20);
    expect(z.start).toBeCloseTo(2.5);
    expect(z.end).toBeCloseTo(7.5);
    expect(clampTimeline({ start: -3, end: 2 }, 20)).toEqual({ start: 0, end: 5 });
    expect(followView({ start: 0, end: 4 }, 5, 20).start).toBeCloseTo(4.6);
    expect(thumbOf({ start: 5, end: 10 }, 20)).toEqual({ left: 0.25, width: 0.25 });
    expect(viewFromThumb(0.25, 0.5, 20)).toEqual({ start: 5, end: 15 });
  });

  it("collects the edges snapping looks for, without the dragged clips", () => {
    const edges = snapEdges(seq, fixtureSource, 6, { exclude: ["c1"], playhead: 1.25 });
    expect(edges).toContain(4.5);
    expect(edges).toContain(1.6);
    expect(edges).toContain(1.25);
    expect(edges).not.toContain(3);
  });
});

describe("transport", () => {
  it("plays the selection, a loop, from a marker, from the playhead or from the start, with pre-roll", () => {
    const sel = clickClip(EMPTY_SELECTION, "c3", "t3");
    expect(playRange(seq, sel, 0, DEFAULT_TRANSPORT, fixtureSource)).toEqual({ start: 2, from: 2, to: 4, selection: true });
    expect(playRange(seq, sel, 0, { ...DEFAULT_TRANSPORT, preRoll: true }, fixtureSource).start).toBe(1);
    expect(playRange(seq, selectLoop(EMPTY_SELECTION, "l1"), 0, DEFAULT_TRANSPORT, fixtureSource)).toMatchObject({ from: 1.6, to: 6, selection: false });
    expect(playRange(seq, EMPTY_SELECTION, 2.5, { ...DEFAULT_TRANSPORT, mode: "playhead" }, fixtureSource)).toMatchObject({ from: 2.5, to: 6 });
    expect(playRange(seq, sel, 2.5, { ...DEFAULT_TRANSPORT, mode: "start" }, fixtureSource)).toMatchObject({ from: 0, to: 6 });
  });

  it("wraps Play to the start when the playhead is at or past the sequence end", () => {
    expect(playRange(seq, EMPTY_SELECTION, 6, { ...DEFAULT_TRANSPORT, mode: "playhead" }, fixtureSource)).toMatchObject({ start: 0, from: 0, to: 6 });
    expect(playRange(seq, EMPTY_SELECTION, 9, DEFAULT_TRANSPORT, fixtureSource)).toMatchObject({ from: 0, to: 6 });
    expect(playRange(seq, EMPTY_SELECTION, 5.5, { ...DEFAULT_TRANSPORT, mode: "playhead" }, fixtureSource)).toMatchObject({ from: 5.5, to: 6 });
  });

  it("releases with Space while a held loop waits, else stops", () => {
    expect(hasHeldLoop(seq, fixtureSource)).toBe(true);
    expect(hasHeldLoop({ ...seq, loops: [], tracks: [] }, fixtureSource)).toBe(false);
    expect(spaceAction(false, true, false)).toBe("play");
    expect(spaceAction(true, true, false)).toBe("release");
    expect(spaceAction(true, true, true)).toBe("stop");
    expect(spaceAction(true, false, false)).toBe("stop");
  });

  it("estimates the playhead and where it rests", () => {
    const r = { start: 1, from: 2, to: 4, selection: true };
    expect(estimatePlayhead(r, 1.5, "oneShot")).toBe(2.5);
    expect(estimatePlayhead(r, 9, "untilStopped")).toBe(4);
    expect(estimatePlayhead({ ...r, selection: false }, 9, "untilStopped")).toBe(10);
    expect(restingPlayhead(r, { ...DEFAULT_TRANSPORT, returnToStart: true }, 4)).toBe(2);
    expect(restingPlayhead(r, DEFAULT_TRANSPORT, 4)).toBe(4);
  });
});
