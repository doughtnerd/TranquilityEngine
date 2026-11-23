// ADR 0350 in the Playlists screen: the fade-shape picker's model, the 1D region handles and their drags, the 2D influence
// map, weight curves through the curve editor's result, quantise and loop-tail edits, change patches and the timeline's
// tail shading. Every view draws from these, so they are tested through their own interfaces.
import { describe, expect, it } from "vitest";
import { emptyPlaylistBody, defaultEntryUse } from "../../../engine/audio/playlist/format";
import type { Entry, PlaylistBody, SequenceSettings } from "../../../engine/audio/playlist/types";
import type { ParameterDef } from "../../../engine/audio/parameters";
import { FADE_SHAPE_OPTIONS, fadeShapePath, narrowWeightCurve, weightCurvePreset } from "../../components/fadeShapeModel";
import { dragRegion, handleAt, influenceGrid, laneCurves, liveWeights, nudgeRegion, regionsOf, shownRegion } from "./blendViewModel";
import { applyWeightCurveResult, weightCurveDialog, WEIGHT_LANE } from "./weightCurves";
import { setEntryUse, setOnChange, setRule } from "./playlistEdits";
import { setAutomation, QUANTIZE_CHOICES, quantizeChoice } from "./sequence/automationEdits";
import { setLoopMusic } from "./sequence/loopMarkerEdits";
import { sequenceTails } from "./sequence/sequenceModel";

const ok = <T,>(r: { next: T } | { refused: string }): T => {
  if ("refused" in r) throw new Error(r.refused);
  return r.next;
};
const clip = (x: number, extra: Partial<Entry> = {}): Entry => ({ kind: "embedded", embedded: { ...emptyPlaylistBody("clip"), entries: [] }, ...defaultEntryUse(), x, ...extra } as Entry);
const RPM: ParameterDef[] = [{ name: "rpm", min: 0, max: 10, default: 0, seekSpeed: 0 }];
const blend1D = (entries: Entry[], extra: Partial<NonNullable<PlaylistBody["blend"]>> = {}): PlaylistBody => ({
  ...emptyPlaylistBody("blend"), entries,
  blend: { ...emptyPlaylistBody("blend").blend!, axes: [{ parameter: "rpm" }], fade: "crossfade", curve: "linear", follow: { glideMs: 0 }, ...extra },
});

describe("fade shape picker model", () => {
  it("offers every engine shape with a name, and draws each one's fade from 0 to 1 (in) or 1 to 0 (out)", () => {
    expect(FADE_SHAPE_OPTIONS.map((o) => o.value)).toEqual(["linear", "equalPower", "sCurve", "invSCurve", "log1", "log2", "log3", "exp1", "exp2", "exp3"]);
    expect(fadeShapePath("linear", false, 24, 12, 2)).toBe("M0.00 12.00 L12.00 6.00 L24.00 0.00");
    expect(fadeShapePath("linear", true, 24, 12, 2)).toBe("M0.00 0.00 L12.00 6.00 L24.00 12.00");
  });

  it("weight-curve presets follow the shapes; a narrow overlap stays 0 until its threshold", () => {
    expect(weightCurvePreset("linear")).toEqual([[0, 0], [1, 1]]);
    expect(weightCurvePreset("exp2")[4]).toEqual([0.5, 0.25]);
    expect(narrowWeightCurve(0.4)).toEqual([[0, 0], [0.4, 0], [1, 1]]);
  });
});

describe("1D regions in the lane", () => {
  const entries = [clip(0), clip(5), clip(10)];
  it("an entry without a region shows its derived one (clamped to the axis) and the lane draws ADR 0343's weights", () => {
    expect(shownRegion(entries, 1, [0, 10], "crossfade")).toEqual({ region: { start: 0, end: 10, fadeIn: 5, fadeOut: 5 }, explicit: false });
    expect(shownRegion(entries, 0, [0, 10], "crossfade").region).toEqual({ start: 0, end: 5, fadeIn: 0, fadeOut: 5 });
    expect(shownRegion(entries, 2, [0, 10], "layer").region).toEqual({ start: 5, end: 10, fadeIn: 5, fadeOut: 0 });
  });

  it("dragging a handle edits the region (an edge keeps its fade, squeezed to fit; a fade's inner end sets its width)", () => {
    const r = { start: 2, end: 8, fadeIn: 2, fadeOut: 2 };
    expect(dragRegion(r, "start", 1)).toEqual({ start: 1, end: 8, fadeIn: 2, fadeOut: 2 });
    expect(dragRegion(r, "start", 9)).toEqual({ start: 8, end: 8, fadeIn: 0, fadeOut: 0 });
    expect(dragRegion(r, "fadeIn", 5)).toEqual({ start: 2, end: 8, fadeIn: 3, fadeOut: 2 });
    expect(dragRegion(r, "fadeOut", 7.5)).toEqual({ start: 2, end: 8, fadeIn: 2, fadeOut: 0.5 });
    expect(handleAt(r, "fadeOut")).toBe(6);
    expect(nudgeRegion(r, "end", [0, 10], 1, true)).toEqual({ start: 2, end: 9, fadeIn: 2, fadeOut: 2 });
  });

  it("one drag is one undoable edit on the entry; Reset to automatic clears it", () => {
    const b = blend1D(entries);
    const withRegion = ok(setEntryUse(b, 1, { region: dragRegion(shownRegion(entries, 1, [0, 10], "crossfade").region, "start", 3) }));
    expect(withRegion.entries[1]!.region).toEqual({ start: 3, end: 10, fadeIn: 5, fadeOut: 5 });
    expect("region" in ok(setEntryUse(withRegion, 1, { region: undefined })).entries[1]!).toBe(false);
  });

  it("the lane and the weights-now read regions and weight curves through the engine's one weight model", () => {
    const b = blend1D([clip(0), clip(10, { region: { start: 6, end: 10, fadeIn: 2, fadeOut: 0 } })]);
    const regions = regionsOf(b.entries, [0, 10]);
    expect(regions?.[1]).toEqual({ start: 0.6, end: 1, fadeIn: 0.2, fadeOut: 0 });
    expect(liveWeights(b, RPM, { rpm: 7 }, 0)).toEqual([0.3, 0.5].map((v) => expect.closeTo(v, 9)));
    const lane = laneCurves([0, 1], "crossfade", "linear", 11, regions);
    expect(lane[1]![5]![1]).toBe(0); // x = 0.5: before the region
    const shaped = blend1D([clip(0), clip(10, { weightCurve: narrowWeightCurve(0.5) })]);
    expect(liveWeights(shaped, RPM, { rpm: 4 }, 0)[1]).toBe(0);
  });
});

describe("2D influence and weight curves", () => {
  it("the plane's influence map tints each cell by the entry weighing most there, curves applied", () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
    const g = influenceGrid(pts, "linear", undefined, 4);
    expect(g).toHaveLength(16);
    expect(g[0]).toMatchObject({ entry: 0 });
    const narrowed = influenceGrid(pts, "linear", [undefined, narrowWeightCurve(0.9), undefined], 4);
    expect(narrowed.filter((c) => c.entry === 1).length).toBeLessThan(g.filter((c) => c.entry === 1).length);
  });

  it("the curve editor edits a weight curve over the raw weight; the identity clears it", () => {
    const spec = weightCurveDialog(undefined);
    expect(spec).toMatchObject({ kind: "parameter", parameter: { name: "Blend weight", min: 0, max: 1 } });
    expect(spec.lanes[0]!.curve).toEqual([[0, 0], [1, 1]]);
    const lane = (curve: [number, number][]) => ({ lanes: [{ id: WEIGHT_LANE, curve, input: "", bypass: false }], minDistance: 0, maxDistance: 0 }) as never;
    expect(applyWeightCurveResult(undefined, lane([[0, 0], [1, 1]]))).toBeNull();
    expect(applyWeightCurveResult(undefined, lane([[0, 0], [0.4, 0], [1, 1]]))).toEqual({ curve: [[0, 0], [0.4, 0], [1, 1]] });
    expect(applyWeightCurveResult([[0, 0], [0.4, 0], [1, 1]], lane([[0, 0], [1, 1]]))).toEqual({ curve: undefined });
  });
});

describe("Switch fades, quantise and loop tails", () => {
  const sw: PlaylistBody = { ...emptyPlaylistBody("switch"), switch: { parameter: "s", map: {}, labelGain: {}, onChange: { when: "bar", how: "transition", length: { beats: 1 }, transition: { kind: "linked", playlist: "r.playlist.json", ...defaultEntryUse() } }, rules: [{ from: "*", to: "*", when: "bar", how: "crossfade", length: { beats: 1 } }] } };

  it("a change's shapes, tail and bridge fades are set and cleared through its patch; leaving transition drops the bridge fades", () => {
    const a = ok(setOnChange(sw, { shapeOut: "sCurve", tail: false, transitionIn: { length: { beats: 0 }, shape: "linear" } }));
    expect(a.switch!.onChange).toMatchObject({ shapeOut: "sCurve", tail: false, transitionIn: { length: { beats: 0 }, shape: "linear" } });
    const b = ok(setOnChange(a, { shapeOut: undefined, tail: undefined }));
    expect("shapeOut" in b.switch!.onChange || "tail" in b.switch!.onChange).toBe(false);
    expect("transitionIn" in ok(setOnChange(a, { how: "crossfade" })).switch!.onChange).toBe(false);
    expect(ok(setRule(sw, 0, { shapeIn: "exp2" })).switch!.rules[0]!.shapeIn).toBe("exp2");
  });

  it("a lane's quantize menu round-trips; Continuous clears it", () => {
    const seq: SequenceSettings = { length: 4, tempo: { bpm: 120, meter: "4/4" }, loops: [], markers: [], tracks: [{ id: "t", name: "T", kind: "audio", color: 1, volume: 0, pan: 0, output: null, mute: false, solo: false, enabled: true, effects: [], clips: [], automation: [{ id: "a", target: "volume", input: { parameter: "I" }, curve: [[0, 0]], bypass: false }] }] };
    for (const c of QUANTIZE_CHOICES) {
      const next = ok(setAutomation(seq, { track: "t" }, "a", { quantize: c.quantize }));
      expect(quantizeChoice(next.tracks[0]!.automation[0]!.quantize)).toBe(c.value);
      if (c.quantize === undefined) expect("quantize" in next.tracks[0]!.automation[0]!).toBe(false);
    }
  });

  it("a loop's tail and exit shape; the timeline shades the post-exit tail and each loop tail", () => {
    const seq: SequenceSettings = { length: 6, tempo: null, tracks: [], loops: [{ id: "l", start: 0, end: 4, active: "always", exit: "crossfade", exitFadeMs: 100, reentry: "ignore" }], markers: [{ id: "m", name: "in", at: 0, type: "exit" }, { id: "x", name: "out", at: 5, type: "exit" }] };
    const tailed = ok(setLoopMusic(seq, "l", { tail: true, exitShape: "log2" }));
    expect(tailed.loops[0]).toMatchObject({ tail: true, exitShape: "log2" });
    expect(sequenceTails(tailed, 6)).toEqual([{ kind: "postExit", from: 5, to: 6 }, { kind: "loopTail", from: 4, to: 5, loop: "l" }]);
    const plain = ok(setLoopMusic(tailed, "l", { tail: false, exitShape: "equalPower" }));
    expect("tail" in plain.loops[0]! || "exitShape" in plain.loops[0]!).toBe(false);
    expect(sequenceTails(plain, 5)).toEqual([]);
  });
});
