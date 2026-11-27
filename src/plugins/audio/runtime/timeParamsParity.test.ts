// ADR 0346: time parameters on the Rust core (the real wasm on the loopback host, through the core backend's automation
// sink) against `TsAutomation`, the Babylon fallback's evaluator. Both read a volume curve keyed on voice time or on a
// group's sequence clock; the core's gain is read back from a DC clip (the last frame of each quantum is the value it
// evaluated at that quantum's first frame), `TsAutomation`'s from what it hands `setVolume`.
//
// - Voice time: the core counts from the voice's first rendered quantum, `TsAutomation` from its `startAt` on its clock.
//   Quantum n after the start reads the curve at n × 128 / 48000 s on both (f32 seconds in the core: 1e-5).
// - Sequence time: `setSequenceTime(group, value, rate)` re-anchors the group's clock; the core anchors an asap TIME at
//   the next quantum, so the two are compared by their slope per quantum and by the value a quantum after the anchor.
// - Clip time is the playhead, which only the core sees (`TsAutomation` estimates it from voice time and pitch): checked
//   on the core alone, at pitch 2.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Curve } from "../../../engine/core/curve";
import { evalCurve } from "../../../engine/core/curve";
import type { AudioVoice } from "./backend";
import { AutoTarget, TimeParam, timeParam, TsAutomation, type Binding } from "./automation";
import { loopbackAudio, closeLoopbackAudio } from "./testing";

const RATE = 48_000;
const Q = 128;
const DT = Q / RATE;
const LEVEL = 0.25;
const dcClip = new Float32Array(96_000).fill(LEVEL);

afterEach(async () => {
  await closeLoopbackAudio();
  vi.restoreAllMocks();
});

async function coreRig() {
  const loop = await loopbackAudio({
    mixer: "own",
    preset: { maxLogical: 16, maxMixed: 8, limiterLookaheadMs: 0 },
    decode: () => ({ channelData: [dcClip] }),
  });
  if (!loop) return null;
  const { backend } = loop;
  const quantum = async (): Promise<Float32Array> => {
    loop.mainFrame(DT);
    const out = loop.render(1).left;
    for (let k = 0; k < 4; k++) await Promise.resolve();
    return out;
  };
  return { backend, quantum };
}

/** Plays the DC clip bound to `binding` on the core; the last frame of every quantum from the first that sounds, over the unbound level. */
async function coreGains(curve: Curve, binding: Binding, quanta: number, opts: { group?: number; pitch?: number; anchor?: { value: number; rate: number } } = {}): Promise<number[] | null> {
  const rig = await coreRig();
  if (!rig) return null;
  const a = rig.backend.automation;
  a.defineCurve(0, curve);
  if (opts.anchor) a.setSequenceTime(opts.group ?? 0, opts.anchor.value, opts.anchor.rate);
  const voice = rig.backend.play({ path: "dc.wav", url: "", loop: true, stream: false, bus: "SFX", volume: 1, pitch: opts.pitch ?? 1, group: opts.group ?? 0 })!;
  a.bindVoice(voice, opts.group ?? 0, [binding], { volume: 1, pitch: opts.pitch ?? 1 });
  const out: number[] = [];
  let started = false;
  for (let n = 0; n < 200 && out.length < quanta; n++) {
    const q = await rig.quantum();
    // The first quantum the voice is playing in reads its curve at 0 s; a curve that starts above 0 makes it audible.
    if (!started && !q.some((s) => s !== 0)) continue;
    started = true;
    out.push(q[Q - 1]!);
  }
  return out;
}

/** The unbound voice's level (the DC through the pan law and the bus). */
async function unit(): Promise<number> {
  const g = await coreGains([[0, 1]], { param: timeParam(TimeParam.Voice), curve: 0, target: AutoTarget.Volume }, 3);
  return g![2]!;
}

function tsGains(curve: Curve, binding: Binding, quanta: number, opts: { group?: number; anchor?: { value: number; rate: number } } = {}): number[] {
  let now = 0;
  const ts = new TsAutomation(() => now);
  ts.defineCurve(0, curve);
  const v = { id: 1, playing: true, volume: [] as number[], setVolume(x: number) { v.volume.push(x); }, setPitch() {} };
  if (opts.anchor) ts.setSequenceTime(opts.group ?? 0, opts.anchor.value, opts.anchor.rate);
  ts.bindVoice(v as unknown as AudioVoice, opts.group ?? 0, [binding], { volume: 1, pitch: 1 }, 0);
  const out: number[] = [];
  for (let n = 0; n < quanta; n++) {
    now = n * DT;
    ts.update(n === 0 ? 0 : DT);
    out.push(v.volume.at(-1)!);
  }
  return out;
}

const FADE_IN: Curve = [[0, 0.1], [0.1, 1, "smooth"], [0.2, 0.4]];

describe("time parameters: the core against TsAutomation (ADR 0346)", () => {
  it("follows a volume curve on voice time from the voice's start, quantum for quantum", async () => {
    const binding: Binding = { param: timeParam(TimeParam.Voice), curve: 0, target: AutoTarget.Volume };
    const level = await unit().catch(() => null);
    if (level === null) return; // the wasm isn't built here
    const core = (await coreGains(FADE_IN, binding, 90))!;
    const ts = tsGains(FADE_IN, binding, 90);
    for (let n = 0; n < 90; n++) {
      expect(core[n]! / level, `quantum ${n}`).toBeCloseTo(evalCurve(FADE_IN, n * DT), 4);
      expect(ts[n]!, `quantum ${n}`).toBeCloseTo(evalCurve(FADE_IN, n * DT), 9);
    }
  });

  it("follows a group's sequence clock from its anchor at its rate", async () => {
    const binding: Binding = { param: timeParam(TimeParam.Sequence), curve: 0, target: AutoTarget.Volume };
    const ramp: Curve = [[0, 0], [10, 1]];
    const level = await unit().catch(() => null);
    if (level === null) return;
    const anchor = { value: 2, rate: 0.5 };
    const core = (await coreGains(ramp, binding, 20, { group: 5, anchor }))!;
    const ts = tsGains(ramp, binding, 20, { group: 5, anchor });
    const perQuantum = (0.5 * DT) / 10;
    for (let n = 2; n < 20; n++) {
      expect(core[n]! / level - core[n - 1]! / level).toBeCloseTo(perQuantum, 6);
      expect(ts[n]! - ts[n - 1]!).toBeCloseTo(perQuantum, 9);
    }
    // Both near 2 s (0.2) at the start: the core anchored its clock a few quanta before the voice sounded.
    expect(core[0]! / level).toBeGreaterThanOrEqual(0.2);
    expect(core[0]! / level).toBeLessThan(0.21); // the clip decodes before the voice sounds
    expect(ts[0]).toBeCloseTo(0.2, 9);
  });

  it("reads clip time from the core's playhead (twice voice time at pitch 2)", async () => {
    const binding: Binding = { param: timeParam(TimeParam.Clip), curve: 0, target: AutoTarget.Volume };
    const level = await unit().catch(() => null);
    if (level === null) return;
    const core = (await coreGains([[0, 0.1], [0.2, 1]], binding, 20, { pitch: 2 }))!;
    for (let n = 0; n < 20; n++) expect(core[n]! / level, `quantum ${n}`).toBeCloseTo(evalCurve([[0, 0.1], [0.2, 1]], 2 * n * DT), 4);
  });
});

describe("TsAutomation's time parameters (ADR 0346)", () => {
  it("keeps a stamped sequence anchor until its time, then reads from it; a park holds", () => {
    let now = 0;
    const ts = new TsAutomation(() => now);
    ts.setSequenceTime(3, 0, 1);
    ts.setSequenceTime(3, 5, 0, 2); // a hold point at 2 s
    now = 1.5;
    expect(ts.sequenceTime(3)).toBeCloseTo(1.5, 12);
    now = 2.5;
    expect(ts.sequenceTime(3)).toBe(5);
    now = 9;
    expect(ts.sequenceTime(3)).toBe(5);
    expect(ts.sequenceTime(4)).toBe(0); // no anchor: 0
    ts.releaseGroup(3);
    expect(ts.sequenceTime(3)).toBe(0);
  });

  it("starts voice time at the bind's `startAt` and keeps it across a re-bind", () => {
    let now = 10;
    const ts = new TsAutomation(() => now);
    ts.defineCurve(0, [[0, 0], [1, 1]]);
    const v = { id: 1, playing: true, volume: [] as number[], setVolume(x: number) { v.volume.push(x); }, setPitch() {} };
    const b: Binding[] = [{ param: timeParam(TimeParam.Voice), curve: 0, target: AutoTarget.Volume }];
    ts.bindVoice(v as unknown as AudioVoice, 0, b, { volume: 1, pitch: 1 }, 10.5);
    expect(v.volume.at(-1)).toBe(0); // before its start
    now = 10.75;
    ts.update(0.25);
    expect(v.volume.at(-1)).toBeCloseTo(0.25, 12);
    ts.bindVoice(v as unknown as AudioVoice, 0, b, { volume: 2, pitch: 1 }); // a new base, the same start
    expect(v.volume.at(-1)).toBeCloseTo(0.5, 12);
  });

  it("without a clock, runs on the sum of `update`'s steps", () => {
    const ts = new TsAutomation();
    ts.setSequenceTime(0, 1, 2);
    ts.update(0.5);
    expect(ts.sequenceTime(0)).toBeCloseTo(2, 12);
  });
});
