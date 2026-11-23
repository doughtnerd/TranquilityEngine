import { describe, expect, it } from "vitest";
import { curveKeyHandles, evalCurve, type CurveKey } from "../../../engine/core/curve";
import {
  addKey,
  applyUserPreset,
  axisOf,
  clearLane,
  createDraft,
  deleteKey,
  dopeLanes,
  dragHandle,
  draftChanged,
  draftResult,
  evalLane,
  formatValue,
  fromNorm,
  inputChoices,
  keyAtPlayhead,
  keyCountText,
  laneColor,
  laneContext,
  moveKey,
  parseUserPresets,
  playheadAt,
  presetCurve,
  presetsFor,
  readout,
  readoutHeading,
  rulerRange,
  samplePath,
  saveUserPreset,
  setKeyFree,
  setKeyShape,
  setKeyValue,
  setKeyX,
  setLaneInput,
  snapTo,
  stretchDistance,
  toNorm,
  valueAt,
  withEnds,
  withLane,
  type CurveEditorSpec,
  type CurveLane,
  type LaneContext,
} from "./curveEditorModel";

const gain: CurveLane = { id: "gain", name: "Gain", unit: "dB", min: -60, max: 6, step: 0.5, base: 0, curve: [[0, 0], [2, -12]] };
const lowpass: CurveLane = { id: "lp", name: "Low-pass", unit: "Hz", min: 200, max: 20000, step: 10, scale: "log", base: 20000, curve: [[0, 20000], [2, 200]] };
const active: CurveLane = { id: "on", name: "Active", unit: "", min: 0, max: 1, step: 1, bool: true, base: 1, curve: [] };
const timeSpec: CurveEditorSpec = { kind: "time", length: 2, lanes: [gain, lowpass, active], inputs: [{ id: "speed", name: "Speed", min: 0, max: 100, unit: "km/h", now: 30 }] };

const ctxOf = (spec: CurveEditorSpec, id: string): LaneContext => laneContext(spec, createDraft(spec), id)!;
const ok = <T>(r: { next: T } | { refused: string }): T => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};
const refused = (r: { next: unknown } | { refused: string }): string => ("refused" in r ? r.refused : "accepted");

describe("axes and inputs", () => {
  it("a time lane runs 0..length snapping to 0.01 s; a parameter by its range; distance to 0.1 m", () => {
    expect(axisOf(timeSpec, "time")).toMatchObject({ kind: "time", min: 0, max: 2, snap: 0.01, unit: "s" });
    expect(axisOf(timeSpec, "speed")).toMatchObject({ kind: "parameter", min: 0, max: 100, snap: 1, now: 30 });
    expect(axisOf({ ...timeSpec, inputs: [{ id: "p", name: "P", min: 0, max: 1 }] }, "p").snap).toBe(0.01);
    const dist: CurveEditorSpec = { kind: "distance", lanes: [gain], maxDistance: 40, now: 12 };
    expect(axisOf(dist, "distance")).toMatchObject({ kind: "distance", min: 0, max: 60, snap: 0.1, now: 12 });
    expect(axisOf({ ...dist, maxDistance: 80 }, "distance").max).toBe(120);
  });
  it("Driven by offers time and each input; a lane's unknown input falls back to the kind's axis", () => {
    expect(inputChoices(timeSpec).map((c) => c.id)).toEqual(["time", "speed"]);
    const d = createDraft({ ...timeSpec, lanes: [{ ...gain, input: "nope" }] });
    expect(d.lanes[0].input).toBe("time");
  });
});

describe("the draft", () => {
  it("every curve gets keys at both ends of its domain; an empty one is flat at its plain value", () => {
    const d = createDraft(timeSpec);
    expect(d.lanes[0].curve).toEqual([[0, 0], [2, -12]]);
    expect(d.lanes[2].curve).toEqual([[0, 1, "step"], [2, 1, "step"]]);
    // A curve inside the domain gains ends holding its values; one past it is cut where the domain ends.
    expect(withEnds([[0.5, 3], [1, 4]], 0, 2, gain)).toEqual([[0, 3], [0.5, 3], [1, 4], [2, 4]]);
    expect(withEnds([[-1, 0], [3, 4]], 0, 2, gain)).toEqual([[0, 1], [2, 3]]);
  });
  it("Apply returns curves in units with each lane's input and bypass; Min/Max only for distance", () => {
    const d = createDraft(timeSpec);
    const r = draftResult(timeSpec, withLane(d, "gain", { bypass: true }));
    expect(r).toEqual({ kind: "time", lanes: [{ id: "gain", curve: [[0, 0], [2, -12]], input: "time", bypass: true }, { id: "lp", curve: [[0, 20000], [2, 200]], input: "time", bypass: false }, { id: "on", curve: [[0, 1, "step"], [2, 1, "step"]], input: "time", bypass: false }] });
    const dist: CurveEditorSpec = { kind: "distance", lanes: [gain], minDistance: 3, maxDistance: 30 };
    expect(draftResult(dist, createDraft(dist))).toMatchObject({ minDistance: 3, maxDistance: 30 });
  });
  it("tells a changed draft from an unchanged one", () => {
    const d = createDraft(timeSpec);
    expect(draftChanged(d, createDraft(timeSpec))).toBe(false);
    expect(draftChanged(d, withLane(d, "gain", { bypass: true }))).toBe(true);
  });
});

describe("values", () => {
  it("a log lane maps octaves to 0..1 and back", () => {
    expect(toNorm(lowpass, 2000)).toBeCloseTo(0.5);
    expect(fromNorm(lowpass, 0.5)).toBeCloseTo(2000);
    expect(toNorm(gain, -27)).toBeCloseTo(0.5);
  });
  it("a pointer's value is quantised to 1/200 of the range and clamped; a switch is on or off", () => {
    expect(valueAt(gain, toNorm(gain, -27.1))).toBe(-27.06);
    expect(valueAt(gain, toNorm(gain, 0.1))).toBe(0); // the grid runs through 0
    expect(valueAt(lowpass, 0.5012)).toBe(2000);
    expect(valueAt(gain, 1.3)).toBe(6);
    expect(valueAt(active, 0.7)).toBe(1);
    expect(valueAt(active, 0.2)).toBe(0);
  });
  it("a log lane evaluates in octaves: halfway between 20 kHz and 200 Hz is 2 kHz", () => {
    expect(evalLane(lowpass, [[0, 20000], [2, 200]], 1)).toBeCloseTo(2000);
    expect(evalLane(gain, [[0, 0], [2, -12]], 1)).toBe(-6);
  });
  it("formats values with the lane's precision and unit, On/Off, and −∞ at a dB floor", () => {
    expect(formatValue(gain, -6.25)).toBe("−6.3 dB");
    expect(formatValue(gain, -60)).toBe("−∞ dB");
    expect(formatValue(active, 1)).toBe("On");
    expect(formatValue(lowpass, 1999.6)).toBe("2000 Hz");
    expect(formatValue(gain, -0.01)).toBe("0.0 dB");
  });
  it("draws step corners and samples in normalised y", () => {
    const pts = samplePath(gain, [[0, 6, "step"], [1, -60], [2, -60]], [0, 2], 4);
    expect(pts[0]).toEqual([0, 1]);
    const riser = pts.findIndex((p) => p[0] === 1);
    expect(pts[riser - 1][1]).toBe(1); // just before the key: still held
    expect(pts[riser][1]).toBe(0);
  });
  it("colours lanes from the series palette", () => {
    expect(laneColor(gain, 0)).toBe("var(--series-1)");
    expect(laneColor({ ...gain, color: 4 }, 0)).toBe("var(--series-4)");
    expect(laneColor(gain, 9)).toBe("var(--series-2)");
  });
});

describe("key edits", () => {
  const ctx = ctxOf(timeSpec, "gain");
  const curve: CurveKey[] = [[0, 0], [1, -6, "smooth"], [2, -12]];

  it("double-click adds a snapped key taking the shape of the key before it", () => {
    const r = ok(addKey(ctx, curve, 1.5037, toNorm(gain, -9)));
    expect(r.index).toBe(2);
    expect(r.curve[2]).toEqual([1.5, -8.91, "smooth"]); // the nearest 1/200 of the range (0.33 dB)
  });
  it("is ignored within half a step of an existing key, and Alt places it unsnapped", () => {
    expect(refused(addKey(ctx, curve, 1.004, 0.5))).toBe("a key is already there");
    expect(ok(addKey(ctx, curve, 1.5037, 0.5, { snap: false })).curve[2][0]).toBe(1.5037);
  });
  it("drags snap x, quantise y and stay between the neighbours; end keys move vertically only", () => {
    expect(moveKey(ctx, curve, 1, 1.2345, toNorm(gain, 0))[1]).toEqual([1.23, 0, "smooth"]);
    expect(moveKey(ctx, curve, 1, 5, 0.5)[1][0]).toBe(1.99);
    expect(moveKey(ctx, curve, 1, 1.2345, 0.5, { snap: false })[1][0]).toBe(1.2345);
    expect(moveKey(ctx, curve, 0, 0.7, 1)[0]).toEqual([0, 6]);
  });
  it("end keys can't be deleted or moved sideways; inner ones can", () => {
    expect(refused(deleteKey(curve, 0))).toBe("end keys can't be deleted");
    expect(refused(deleteKey(curve, 2))).toBe("end keys can't be deleted");
    expect(ok(deleteKey(curve, 1))).toEqual([[0, 0], [2, -12]]);
    expect(refused(setKeyX(ctx, curve, 0, 1))).toBe("end keys stay at the ends");
    expect(ok(setKeyX(ctx, curve, 1, 0.5))[1]).toEqual([0.5, -6, "smooth"]);
  });
  it("typed values are clamped into the range", () => {
    expect(ok(setKeyValue(ctx, curve, 1, 40))[1]).toEqual([1, 6, "smooth"]);
    expect(refused(setKeyValue(ctx, curve, 1, NaN))).toBe("not a number");
  });
  it("setting Bézier derives mirrored handles from the neighbours' slope, (next.x − prev.x) / 6 long", () => {
    const k = ok(setKeyShape(ctx, curve, 1, "bezier"))[1];
    const h = curveKeyHandles(k)!;
    expect(h.out[0]).toBeCloseTo(2 / 6);
    expect(h.in[0]).toBeCloseTo(-2 / 6);
    expect(h.out[1]).toBeCloseTo(-12 / 2 * (2 / 6)); // slope -6 dB/s
    expect(h.in[1]).toBeCloseTo(-h.out[1]);
    expect(h.free).toBeUndefined();
  });
  it("other shapes replace the key's interp; a switch only steps; a linear-only curve only goes straight", () => {
    expect(ok(setKeyShape(ctx, curve, 1, "linear"))[1]).toEqual([1, -6]);
    expect(ok(setKeyShape(ctx, curve, 1, "easeOut"))[1]).toEqual([1, -6, "easeOut"]);
    expect(refused(setKeyShape(ctxOf(timeSpec, "on"), [[0, 1, "step"], [2, 1, "step"]], 0, "linear"))).toBe("an on/off property steps");
    expect(refused(setKeyShape({ ...ctx, linearOnly: true }, curve, 1, "smooth"))).toBe("this curve's keys are linear");
  });
  it("handle drags mirror unless free, and keep each handle on its side", () => {
    const bez = ok(setKeyShape(ctx, curve, 1, "bezier"));
    const dragged = dragHandle(ctx, bez, 1, "out", 1.5, toNorm(gain, 0));
    const h = curveKeyHandles(dragged[1])!;
    expect(h.out).toEqual([0.5, 6]);
    expect(h.in).toEqual([-0.5, -6]);
    const free = ok(setKeyFree(bez, 1, true));
    const h2 = curveKeyHandles(dragHandle(ctx, free, 1, "out", 0.5, toNorm(gain, 0))[1])!;
    expect(h2.out[0]).toBe(0.005); // can't cross to the left: half a snap step
    expect(h2.in).toEqual(curveKeyHandles(bez[1])!.in);
    expect(refused(setKeyFree(curve, 1, true))).toBe("only a Bézier key has handles");
  });
  it("a log lane's handles follow octaves", () => {
    const lctx = ctxOf(timeSpec, "lp");
    const c = ok(setKeyShape(lctx, [[0, 20000], [1, 2000], [2, 200]], 1, "bezier"));
    const h = curveKeyHandles(c[1])!;
    // Straight in octaves: the out handle a third of the way to 200 Hz in log space.
    expect(2000 + h.out[1]).toBeCloseTo(2000 * Math.pow(0.1, 1 / 3), 0);
    expect(evalLane(lowpass, c, 1)).toBeCloseTo(2000);
  });
  it("a switch's keys step to on or off", () => {
    const sctx = ctxOf(timeSpec, "on");
    expect(ok(addKey(sctx, [[0, 1, "step"], [2, 1, "step"]], 1, 0.2)).curve[1]).toEqual([1, 0, "step"]);
  });
});

describe("lanes", () => {
  it("switching Driven by rescales keys' x and handle dx from the old domain to the new", () => {
    const spec: CurveEditorSpec = { ...timeSpec, lanes: [{ ...gain, curve: [[0, 0], [1, -6, "bezier", { in: [-0.2, 1], out: [0.2, -1] }], [2, -12]] }] };
    const d = ok(setLaneInput(spec, createDraft(spec), "gain", "speed"));
    expect(d.lanes[0].input).toBe("speed");
    expect(d.lanes[0].curve).toEqual([[0, 0], [50, -6, "bezier", { in: [-10, 1], out: [10, -1] }], [100, -12]]);
    expect(refused(setLaneInput(spec, d, "gain", "rpm"))).toBe("no such input");
  });
  it("clear flattens at the plain value and turns the lane back on", () => {
    const d0 = withLane(createDraft(timeSpec), "gain", { bypass: true });
    const d = ok(clearLane(timeSpec, d0, "gain"));
    expect(d.lanes[0]).toEqual({ id: "gain", curve: [[0, 0], [2, 0]], input: "time", bypass: false });
    expect(keyCountText(d.lanes[0].curve)).toBe("constant");
    expect(keyCountText([[0, 0], [1, 2], [2, 0]])).toBe("3 keys");
  });
  it("reads each lane at its probe: the playhead, the input's now; a bypassed lane shows its plain value", () => {
    const spec: CurveEditorSpec = { ...timeSpec, lanes: [gain, { ...lowpass, input: "speed", curve: [[0, 20000], [100, 200]] }, { ...active, bypass: true }] };
    const rows = readout(spec, createDraft(spec), 1);
    expect(rows.map((r) => r.text)).toEqual(["−6.0 dB", `${formatValue(lowpass, evalLane(lowpass, [[0, 20000], [100, 200]], 30))}`, "On · off"]);
    expect(readoutHeading(axisOf(spec, "time"), 1)).toBe("At the playhead, 1.00 s");
    expect(readoutHeading(axisOf(spec, "speed"), 1)).toBe("At game now, 30 km/h");
  });
  it("the dope sheet lists the lanes driven by time", () => {
    const spec: CurveEditorSpec = { ...timeSpec, lanes: [gain, { ...lowpass, input: "speed" }] };
    expect(dopeLanes(spec, createDraft(spec))).toEqual(["gain"]);
  });
});

describe("distance", () => {
  const spec: CurveEditorSpec = { kind: "distance", minDistance: 2, maxDistance: 40, lanes: [{ ...gain, curve: [[0, 0], [2, 0], [21, -30], [40, -60], [50, -60]] }] };
  it("Min/Max stretch every distance lane's keys: inside Min with Min, between onto the new span, beyond toward the axis end", () => {
    const d = stretchDistance(spec, createDraft(spec), 4, 30);
    expect(d.minDistance).toBe(4);
    expect(d.maxDistance).toBe(30);
    expect(d.lanes[0].curve.map((k) => k[0])).toEqual([0, 4, 17, 30, 45, 60]);
    expect(d.lanes[0].curve.at(-1)).toEqual([60, -60]); // the end key stays at the end
  });
  it("keeps Min at least 0.5 m and 1 m inside Max, and Max inside the axis", () => {
    const d = stretchDistance(spec, createDraft(spec), 70, 80);
    expect(d.maxDistance).toBe(60);
    expect(d.minDistance).toBe(59);
    expect(stretchDistance(spec, createDraft(spec), 0, 40).minDistance).toBe(0.5);
  });
  it("offers Inverse square for a dB lane: 0 dB to Min, −20·log10(d/Min) to Max, silence past it", () => {
    const ctx = ctxOf(spec, "gain");
    expect(presetsFor(ctx).map((p) => p.id)).toEqual(["inverseSquare", "flat", "linear", "easeIn", "easeOut", "sCurve"]);
    const c = presetCurve(ctx, createDraft(spec), [], "inverseSquare");
    expect(c[0]).toEqual([0, 0]);
    expect(c[1]).toEqual([2, 0]);
    expect(c[6][0]).toBeCloseTo(40);
    expect(c[6][1]).toBeCloseTo(-20 * Math.log10(20));
    expect(c.at(-2)).toEqual([40.1, -60]);
    expect(c.at(-1)![0]).toBe(60);
  });
  it("presets apply between Min and Max, leading with a key at 0", () => {
    const ctx = ctxOf(spec, "gain");
    const c = presetCurve(ctx, createDraft(spec), [[0, 0], [60, -60]], "sCurve");
    expect(c[0]).toEqual([0, evalCurve([[0, 0], [60, -60]], 2)]);
    expect(c[1][0]).toBe(2);
    expect(c[1][2]).toBe("smooth");
  });
});

describe("presets", () => {
  const ctx = ctxOf(timeSpec, "gain");
  const d = createDraft(timeSpec);
  it("run between the curve's values at the ends, or the range's bottom and top when those are equal", () => {
    expect(presetCurve(ctx, d, [[0, 0], [2, -12]], "linear")).toEqual([[0, 0], [2, -12]]);
    expect(presetCurve(ctx, d, [[0, 0], [2, -12]], "easeIn")).toEqual([[0, 0, "easeIn"], [2, -12]]);
    expect(presetCurve(ctx, d, [[0, 3], [2, 3]], "easeOut")).toEqual([[0, -60, "easeOut"], [2, 6]]);
    expect(presetCurve(ctx, d, [[0, 0], [2, -12]], "flat")).toEqual([[0, 0], [2, 0]]);
  });
  it("a switch gets Flat only; a linear-only curve Flat and Linear", () => {
    expect(presetsFor(ctxOf(timeSpec, "on")).map((p) => p.id)).toEqual(["flat"]);
    expect(presetsFor({ ...ctx, linearOnly: true }).map((p) => p.id)).toEqual(["flat", "linear"]);
  });
  it("user presets store x and y normalised and lay over any lane", () => {
    const saved = ok(saveUserPreset(ctx, d, [[0, 6], [1, -27, "smooth"], [2, -60]], []));
    expect(saved).toEqual([{ name: "My curve 1", keys: [[0, 1], [0.5, 0.5, "smooth"], [1, 0]] }]);
    expect(ok(saveUserPreset(ctx, d, [[0, 6], [2, 6]], saved)).at(-1)!.name).toBe("My curve 2");
    const onLp = applyUserPreset(ctxOf(timeSpec, "lp"), d, saved[0]);
    expect(onLp[0]).toEqual([0, 20000]);
    expect(onLp[1][1]).toBeCloseTo(2000, 0);
    expect(onLp[2]).toEqual([2, 200]);
  });
  it("parses the stored list leniently", () => {
    expect(parseUserPresets([{ name: "A", keys: [[0, 0], ["x", 1]] }, { name: 3 }, "junk", { name: "B", keys: [] }])).toEqual([{ name: "A", keys: [[0, 0]] }]);
    expect(parseUserPresets("nope")).toEqual([]);
  });
});

describe("time view", () => {
  it("a ruler drag under 3% of the length is a click; the playhead rounds to 0.01 s", () => {
    expect(rulerRange(1.5, 0.5, 2)).toEqual([0.5, 1.5]);
    expect(rulerRange(1, 1.04, 2)).toBeNull();
    expect(playheadAt(1.2345, 2)).toBe(1.23);
    expect(playheadAt(5, 2)).toBe(2);
  });
  it("a key at the playhead holds the curve's value there", () => {
    const ctx = ctxOf(timeSpec, "gain");
    const r = ok(keyAtPlayhead(ctx, [[0, 0], [2, -12]], 0.5));
    expect(r.curve[1]).toEqual([0.5, -3]);
  });
  it("snaps without float noise", () => {
    expect(snapTo(0.30000000000000004, 0.1)).toBe(0.3);
    expect(snapTo(1.2345, 1)).toBe(1);
  });
});
