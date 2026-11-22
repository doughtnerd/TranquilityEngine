import { describe, expect, it } from "vitest";
import type { ParameterDef } from "../../../../engine/audio/parameters";
import { TIME_INPUT } from "../../../../editor/ui/curves/curveEditorModel";
import { applyCurveResult, curveSpec } from "./sequenceCurves";
import { fixtureSequence } from "./sequenceFixture";
import { findClip } from "./sequenceModel";

const seq = fixtureSequence();
const PARAMS: ParameterDef[] = [{ name: "brake", min: 0, max: 1, default: 0, seekSpeed: 0 }, { name: "surface", labels: ["a", "b"], default: "a" }];

describe("sequence curves in the shared curve editor", () => {
  it("offers every target of a clip as a lane, its automation or its plain value, over clip time", () => {
    const spec = curveSpec(seq, { clip: "c1" }, 3, PARAMS)!;
    expect(spec).toMatchObject({ kind: "time", length: 3, timeName: "Clip time" });
    expect(spec.inputs!.map((i) => i.id)).toEqual(["brake"]);
    const volume = spec.lanes.find((l) => l.id === "volume")!;
    expect(volume.curve).toEqual([[0, -12], [0.5, 0], [2.5, 0], [3, -24]]);
    expect(volume.input).toBe(TIME_INPUT);
    expect(spec.lanes.find((l) => l.id === "pitch")!.curve).toEqual([[0, 0]]);
    expect(spec.lanes.some((l) => l.id === "fx:fx1:on")).toBe(true);
    expect(curveSpec(seq, { track: "t1" }, 6, PARAMS)!.timeName).toBe("Timeline");
  });

  it("applies the result: changed curves and drivers, new shaped lanes, flat lanes back to plain values", () => {
    const r = applyCurveResult(seq, { clip: "c1" }, {
      kind: "time",
      lanes: [
        { id: "volume", curve: [[0, 0], [1, 0]], input: TIME_INPUT, bypass: false },
        { id: "pitch", curve: [[0, 0], [1, 5]], input: "brake", bypass: false },
        { id: "pan", curve: [[0, 0]], input: TIME_INPUT, bypass: false },
      ],
    });
    if ("refused" in r) throw new Error(r.refused);
    const auto = findClip(r.next, "c1")!.clip.automation;
    expect(auto.map((a) => a.target)).toEqual(["pitch"]);
    expect(auto[0]).toMatchObject({ id: "a1", input: { parameter: "brake" }, curve: [[0, 0], [1, 5]] });
    const t = applyCurveResult(seq, { track: "t1" }, { kind: "time", lanes: [{ id: "pan", curve: [[0, -1], [2, 1]], input: TIME_INPUT, bypass: true }] });
    if ("refused" in t) throw new Error(t.refused);
    expect(t.next.tracks[0]!.automation[0]).toMatchObject({ input: "sequenceTime", bypass: true, curve: [[0, -1], [2, 1]] });
    expect("refused" in applyCurveResult(seq, { clip: "nope" }, { kind: "time", lanes: [] })).toBe(true);
  });
});
