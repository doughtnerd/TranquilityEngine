// The `ANIM_FRAME` record (ADR 0373, 0376): an `AnimatorDebugFrame` round-trips through its payload (the debug report in
// the core's wire form, every parameter and input kind, root motion), long strings are cut on a code point, and a payload
// that doesn't read back is refused, never misread.
import { describe, expect, it } from "vitest";
import type { AnimatorDebugFrame } from "./frame";
import { FRAME_TEXT_MAX_BYTES, decodeFrameRecord, encodeFrameRecord } from "./frameRecord";

const frame: AnimatorDebugFrame = {
  index: 42,
  time: 1.5,
  report: {
    instance: 0x10002,
    nodes: [{ node: 3, weight: 0.75, clip: 9, time: 0.5, normalized: 0.25 }],
    machines: [{ machine: 0, current: 1, target: 2, active: 4, elapsed: 0.5, duration: 0.25, stateTime: 1.25, normalized: 0.125, travel: 0xffffffff, lastFired: 3, entries: 2 }],
    transitions: [{ machine: 0, transition: 4, target: 2, blocker: 2, detail: 7, value: -0.5 }],
    requests: [{ name: 5, life: 0.5 }],
    dropped: 1,
  },
  parameters: [0.2, true, false, [0.5, 1], [1, 2, 3], [0, 0, 0, 1], null],
  inputs: [
    { kind: "param", name: "speed", value: 0.2 },
    { kind: "param", name: "aim", value: [1, 2] },
    { kind: "param", name: "target", value: null },
    { kind: "request", name: "Jump", lifetime: 0.25 },
    { kind: "travel", machine: "Base", state: "Run" },
    { kind: "jump", machine: "Base", state: "Idle" },
    { kind: "slotPlay", slot: "Upper", clip: "anim/wave.anim" },
    { kind: "slotStop", slot: "Upper" },
    { kind: "link", linked: "Weapon" },
    { kind: "layerWeight", layer: "Upper", weight: 0.5 },
    { kind: "ik" },
    { kind: "other", what: "warp target" },
  ],
  root: [0, 0, 0.1, 0, 0, 0, 1],
};

describe("the ANIM_FRAME record", () => {
  it("round-trips a frame", () => {
    const read = decodeFrameRecord(encodeFrameRecord(frame));
    expect("frame" in read).toBe(true);
    if (!("frame" in read)) return;
    const back = read.frame;
    expect(back.index).toBe(42);
    expect(back.time).toBe(1.5);
    expect(back.parameters).toEqual(frame.parameters);
    expect(back.inputs).toEqual(frame.inputs);
    expect(back.root).toEqual(frame.root);
    expect(back.report.instance).toBe(0x10002);
    expect(back.report.dropped).toBe(1);
    expect(back.report.nodes).toEqual(frame.report.nodes);
    expect(back.report.machines).toEqual(frame.report.machines);
    expect(back.report.transitions).toEqual(frame.report.transitions);
    expect(back.report.requests).toEqual(frame.report.requests);
    // Encoding the decoded frame gives the same bytes: one encoding for the link and takes.
    expect(Array.from(encodeFrameRecord(back))).toEqual(Array.from(encodeFrameRecord(frame)));
  });

  it("cuts a long name on a code point", () => {
    const long = "é".repeat(FRAME_TEXT_MAX_BYTES); // two bytes each
    const read = decodeFrameRecord(encodeFrameRecord({ ...frame, inputs: [{ kind: "other", what: long }] }));
    const what = "frame" in read && read.frame.inputs[0]!.kind === "other" ? read.frame.inputs[0]!.what : "";
    expect(what).toBe("é".repeat(FRAME_TEXT_MAX_BYTES / 2));
  });

  it("refuses a payload that doesn't read back", () => {
    const bytes = encodeFrameRecord(frame);
    for (let cut = 0; cut < bytes.length; cut += 7) expect(decodeFrameRecord(bytes.subarray(0, cut))).toEqual({ refused: expect.stringContaining("doesn't read") });
    const huge = bytes.slice();
    new DataView(huge.buffer).setUint32(12, 0xffffffff, true); // the report's length
    expect(decodeFrameRecord(huge)).toEqual({ refused: expect.stringContaining("report of") });
    const nan = bytes.slice();
    new DataView(nan.buffer).setFloat64(0, Number.NaN, true);
    expect(decodeFrameRecord(nan)).toEqual({ refused: expect.stringContaining("time") });
  });
});
