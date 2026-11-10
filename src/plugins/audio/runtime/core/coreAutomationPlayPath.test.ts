// E5.3c (ADR 0158 §6 budget): the core sink's play path without allocation, against the same recording writer and
// voice table as `coreAutomation.test.ts`: `evaluateInto` gives exactly `evaluate`'s numbers, the intrusive group and
// global reader lists match a plain model through binds, re-binds and frees, a parameter set to the value it already
// holds re-evaluates nothing (unless a seek runs), and a slot's reused entry carries nothing over from its last voice.
import { describe, expect, it } from "vitest";
import type { Curve } from "../../../../engine/core/curve";
import { AutoTarget, evaluate, evaluateInto, type Binding } from "../events/automation";
import type { AudioVoice } from "../backend";
import { CoreAutomation, type CoreAutomationDeps } from "./coreAutomation";
import { VoiceState, VoiceTable } from "./voiceTable";
import type { ClipInfo } from "./clipRegistry";

function rig() {
  const table = new VoiceTable(32);
  const automates: [number, { param: number; curve: number; target: number }[]][] = [];
  const writer: CoreAutomationDeps["writer"] = {
    automate: (id, _at, b) => void automates.push([id, b.map((x) => ({ ...x }))]),
    param: () => {},
    curves: () => {},
    busAutomate: () => {},
    setLoop: () => {},
  };
  const state = { now: 10_000 };
  const info: ClipInfo = { id: 1, path: "a.wav", state: "ready", refs: 1, frames: 96_000, channels: 1, sampleRate: 48_000, format: 1, bytes: 0, failure: null };
  const auto = new CoreAutomation({
    table,
    writer,
    clockMap: { framesNow: () => state.now, lookaheadFrames: () => 1000, sampleRate: 48_000 },
    playheads: { positionNow: () => 0, start: () => {}, retime: () => {} },
    clipInfo: () => info,
    busIndex: () => 0,
    sending: () => true,
  });
  const voice = (group = 0): AudioVoice => {
    const id = table.allocate(0, 128, 0, VoiceState.PLAYING as never);
    table.group[id & 0xffff] = group;
    return { id } as AudioVoice;
  };
  const free = (v: AudioVoice) => {
    table.free(v.id, 0);
    auto.forget(v.id & 0xffff);
  };
  return { table, auto, automates, state, voice, free };
}

const bind = (slot: number, curve: number, target: AutoTarget, global = false): Binding => ({ param: { global, slot }, curve, target });
const ramp: Curve = [[0, 0.2], [1, 1]];

/** A small deterministic generator. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("evaluateInto: evaluate's numbers without a callback (E5.3c)", () => {
  it("matches evaluate bit for bit over random bindings, curves (some undefined) and values", () => {
    const r = rng(11);
    const curves = new Map<number, Curve>();
    for (let id = 0; id < 6; id++) {
      const keys: [number, number, ...string[]][] = [];
      let x = -0.5;
      const n = 1 + Math.floor(r() * 5);
      for (let k = 0; k < n; k++) keys.push([(x += r()), r() * 3 - 0.5, ["linear", "step", "smooth"][Math.floor(r() * 3)]!]);
      curves.set(id, keys as unknown as Curve);
    }
    const out = { gain: 0, pitch: 0, lowpass: 0 };
    for (let trial = 0; trial < 2_000; trial++) {
      const n = Math.floor(r() * 9);
      const bindings: Binding[] = [];
      const ids = new Int32Array(8), targets = new Uint8Array(8), xs = new Float64Array(8);
      for (let j = 0; j < n; j++) {
        const b = bind(j, Math.floor(r() * 8), Math.floor(r() * 3) as AutoTarget); // ids 6 and 7 are undefined
        bindings.push(b);
        ids[j] = b.curve;
        targets[j] = b.target;
        xs[j] = r() * 4 - 1;
      }
      const want = evaluate(bindings, curves, (p) => xs[p.slot]!);
      expect(evaluateInto(n, ids, targets, xs, curves, out)).toEqual(want);
    }
  });
});

describe("CoreAutomation's reader lists (E5.3c)", () => {
  it("re-evaluates exactly the voices a model says read the parameter, through binds, re-binds and frees", () => {
    const { auto, voice, free } = rig();
    auto.defineCurve(0, ramp);
    const r = rng(5);
    // The model: per live voice, the group it is listed under (local bindings) and whether it reads a global.
    const live = new Map<AudioVoice, { group: number; local: boolean; global: boolean }>();
    for (let step = 0; step < 3_000; step++) {
      const op = r();
      if (op < 0.35 && live.size < 30) {
        const g = 1 + Math.floor(r() * 4);
        live.set(voice(g), { group: g, local: false, global: false });
      } else if (op < 0.6 && live.size > 0) {
        const v = [...live.keys()][Math.floor(r() * live.size)]!;
        const g = r() < 0.2 ? 0 : 1 + Math.floor(r() * 4); // re-bound, sometimes to another (or no) group
        const local = r() < 0.7, global = r() < 0.4;
        const bs: Binding[] = [];
        if (local) bs.push(bind(0, 0, AutoTarget.Volume));
        if (global) bs.push(bind(1, 0, AutoTarget.Pitch, true));
        auto.bindVoice(v, g, bs, { volume: 1, pitch: 1 });
        // Only bound voices are on the lists; one with no bindings and no loop leaves the mirror.
        live.set(v, { group: g, local: local && g > 0, global });
      } else if (op < 0.75 && live.size > 0) {
        const v = [...live.keys()][Math.floor(r() * live.size)]!;
        free(v);
        live.delete(v);
      } else {
        const g = Math.floor(r() * 5);
        const before = auto.stats.evaluations;
        auto.setParam(g, g === 0 ? 1 : 0, step / 3_000, 0); // a new value each time
        let want = 0;
        for (const m of live.values()) if (g === 0 ? m.global : m.local && m.group === g) want++;
        expect(auto.stats.evaluations - before).toBe(want);
      }
    }
  });

  it("a parameter set to the value it holds re-evaluates nothing; a new value, or one while a seek runs, does", () => {
    const { auto, voice, table, state } = rig();
    auto.defineCurve(0, ramp);
    const a = voice(3);
    const b = voice(3);
    auto.bindVoice(a, 3, [bind(0, 0, AutoTarget.Volume)], { volume: 1, pitch: 1 });
    auto.bindVoice(b, 3, [bind(0, 0, AutoTarget.Volume), bind(2, 0, AutoTarget.Volume, true)], { volume: 1, pitch: 1 });
    auto.setParam(3, 0, 0.5, 0);
    let n = auto.stats.evaluations;
    auto.setParam(3, 0, 0.5, 0);
    auto.setParam(3, 0, 0.5, 2); // a seek to where it already is: still nothing to move
    expect(auto.stats.evaluations - n).toBe(0);
    auto.setParam(3, 0, 1, 0);
    expect(auto.stats.evaluations - n).toBe(2);
    expect(table.autoGain[a.id & 0xffff]).toBeCloseTo(1, 6);
    // A global seeking: the smoothed value matters to selection, so even an unchanged local re-evaluates its readers.
    auto.setParam(0, 2, 1, 0);
    auto.setParam(0, 2, 0, 1); // fading out
    state.now += 4_800; // 0.1 s into a 1 s fade
    n = auto.stats.evaluations;
    auto.setParam(3, 0, 1, 0);
    expect(auto.stats.evaluations - n).toBe(2);
    // The same result as a fresh evaluation: b's gain is the larger of the targets' (0.2) and the smoothed values' (0.92).
    expect(table.autoGain[b.id & 0xffff]).toBeCloseTo(evaluate([bind(0, 0, AutoTarget.Volume), bind(2, 0, AutoTarget.Volume, true)], new Map([[0, ramp]]), (p) => (p.global ? 0.9 : 1)).gain, 6);
  });

  it("a slot's reused entry carries nothing over: fewer bindings send and evaluate only the new ones", () => {
    const { auto, voice, free, table, automates } = rig();
    auto.defineCurve(0, ramp);
    auto.defineCurve(1, [[0, 2], [1, 2]]);
    auto.setParam(1, 0, 0, 0);
    const a = voice(1);
    auto.bindVoice(a, 1, [bind(0, 0, AutoTarget.Volume), bind(0, 1, AutoTarget.Pitch), bind(0, 0, AutoTarget.Volume)], { volume: 1, pitch: 1 });
    const i = a.id & 0xffff;
    expect(table.autoPitch[i]).toBe(2);
    free(a);
    const b = voice(2);
    expect(b.id & 0xffff).toBe(i); // the same slot, the same entry object
    auto.setParam(2, 0, 1, 0);
    auto.bindVoice(b, 2, [bind(0, 0, AutoTarget.Volume)], { volume: 1, pitch: 1 });
    expect(automates.at(-1)).toEqual([b.id, [{ param: 0, curve: 0, target: AutoTarget.Volume }]]);
    expect(table.autoGain[i]).toBe(1);
    expect(table.autoPitch[i]).toBe(1);
    // And it reads group 2's locals, not group 1's.
    const n = auto.stats.evaluations;
    auto.setParam(1, 0, 0.5, 0);
    expect(auto.stats.evaluations - n).toBe(0);
    auto.setParam(2, 0, 0, 0);
    expect(table.autoGain[i]).toBeCloseTo(0.2, 6);
  });
});
