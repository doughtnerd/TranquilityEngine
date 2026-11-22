// ADR 0332: an entry's curves on voice, clip or sequence time become automation bindings on the core's time parameters
// (`curveParts`), like its parameter curves; nothing is left for main to evaluate per frame.
import { describe, expect, it } from "vitest";
import type { Curve } from "../../../../engine/core/curve";
import { AutoTarget, TimeParam } from "../events/automation";
import { curveParts, toCoreCurve } from "./curves";

describe("curveParts: time curves are bindings (ADR 0332)", () => {
  it("binds gain, pitch and low-pass curves on each time input to its time parameter", () => {
    const ids = new Map<Curve, number>();
    const curveId = (c: Curve): number => { if (!ids.has(c)) ids.set(c, ids.size); return ids.get(c)!; };
    const gain: Curve = [[0, -12], [1, 0]];
    const pitch: Curve = [[0, 0], [2, 12]];
    const lowpass: Curve = [[0, 500], [4, 12_000]];
    const parts = curveParts(
      {
        gain: { input: "voiceTime", curve: gain, bypass: false },
        pitch: { input: "clipTime", curve: pitch, bypass: false },
        lowpass: { input: "sequenceTime", curve: lowpass, bypass: false },
      },
      { bindings: [], timeCurves: [] },
      () => null,
      curveId,
      "test",
    );
    expect(parts.timeCurves).toEqual([]);
    expect(parts.bindings.map((b) => [b.param.time, b.target])).toEqual([
      [TimeParam.Voice, AutoTarget.Volume],
      [TimeParam.Clip, AutoTarget.Pitch],
      [TimeParam.Sequence, AutoTarget.Lowpass],
    ]);
    // dB and semitones are resampled into the core's linear gain and pitch ratio; a cutoff stays in Hz.
    expect(parts.bindings[0]!.curve).toBe(ids.get(toCoreCurve(gain, "gain")));
    expect(parts.bindings[1]!.curve).toBe(ids.get(toCoreCurve(pitch, "pitch")));
    expect(parts.bindings[2]!.curve).toBe(ids.get(lowpass));
  });

  it("adds below the parent's bindings and leaves the parent's list alone", () => {
    const parent = { bindings: [{ param: { global: true, slot: 0 }, curve: 9, target: AutoTarget.Volume }], timeCurves: [] };
    const parts = curveParts({ gain: { input: "voiceTime", curve: [[0, 0]], bypass: false } }, parent, () => null, () => 1, "test");
    expect(parts.bindings).toHaveLength(2);
    expect(parent.bindings).toHaveLength(1);
  });
});
