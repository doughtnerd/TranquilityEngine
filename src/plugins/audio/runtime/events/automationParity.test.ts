// ADR 0158 §3 and §6, task E3.4: the Rust core and the TypeScript fallback evaluator (`TsAutomation`) run the same
// parameter and curve scenes and must agree. "Curve evaluation and smoothing exist twice ... the parity test keeps them
// together" (§6).
//
// How the two sides are compared. Each scene is a list of per-quantum actions (a `setParam` at quantum n) applied to
// both sinks; then the TypeScript side takes one `update(128 / 48000)` and the core renders one 128-frame quantum on
// the real wasm (the loopback host). What each side exposes:
//
// - TypeScript: the values it hands the voice setters (`setVolume(base × gain)`, `setPitch(base × pitch)`), the bus
//   automation it hands the mixer (`_setAutomation(bus, gain, lowpass)`), and, for a low-pass, `evaluate()` over the
//   smoothed parameters (Babylon has no per-voice low-pass, so the evaluated cutoff is all there is).
// - Core: only audio. So the control values are read back from the rendered signal: a DC clip gives the gain (per
//   sample, so the within-quantum ramp is checked too), a linear-ramp clip gives the pitch (the advance of the clip
//   position over a quantum), and a 3 kHz sine through the voice's biquad gives the cutoff (RMS per quantum against
//   the analytic low-pass response).
//
// Tolerances, from what each side quantises (observed worst errors in brackets; each tolerance is about 3 to 10 times that):
// - Both smooth a parameter by `seek × 128 / 48000` per quantum (the core's step; `TsAutomation.update` gets exactly
//   that dt here), so the smoothing agrees to rounding: the core is f32, the reference f64. `GAIN_TOL` 1e-5 absolute,
//   in units of the unbound voice's output (1e-6 at worst, an f32 chain of parameter, curve, product, ramp, pan, mix);
//   the smallest ramp step in these scenes is about 1e-2, so any behavioural difference is far outside it.
// - The core ramps gain and pitch linearly across the quantum (frame j is `a + (b - a)(j + 1) / 128`, `a` the value at
//   the end of the previous quantum); `TsAutomation` sets a value once per update. So the reference is that ramp built
//   from the TypeScript values, per sample for gain and per quantum for pitch. `PITCH_TOL` 5e-5 (3e-6), in units of
//   the playback rate averaged over a quantum.
// - The low-pass is compared through the filter's magnitude at 3 kHz: RMS over one quantum (8 whole cycles) of a
//   steady sine against the analytic response of the core's biquad at the TypeScript side's evaluated cutoff. `LP_TOL`
//   1% relative (0.2%: the filter's state following a cutoff that moves a little every quantum).
// - A key in a curve is a place where one f32 rounding can move a quantum's value by a whole segment (a `step`, a
//   jump). The scenes keep every parameter sample off the keys (the seek steps never land on one), so the two sides
//   never straddle a key differently.
// - Timing: a command made at the start of quantum n reaches the core for quantum n + 1 (`CORE_LAG`; the batch is
//   delivered for the next quantum), so the TypeScript side applies the same action one update later. That is transport,
//   not evaluation, and it is the same for every scene.
// - Observed, outside this test's scope: a core voice whose gain evaluated at the parameter's *target* is 0
//   (`CoreAutomation.reevaluate`, which feeds selection) went silent at once instead of ramping down with the
//   parameter, so no scene seeks toward a target that silences a voice.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mixer as globalMixer, Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import type { Curve } from "../../../../engine/core/curve";
import type { AudioVoice } from "../backend";
import { createClipRegistry } from "../core/clipRegistry";
import { fakeDecoder, type PlanarClip } from "../core/fakeDecoder";
import type { AudioHost, CoreLink } from "../core/context";
import { CoreBackend, type CoreBackendHost } from "../core/coreBackend";
import { AutoTarget, evaluate, TsAutomation, type Binding } from "./automation";

const RATE = 48_000;
const Q = 128;
const DT = Q / RATE;
const CLIP_FRAMES = 96_000;
const RAMP_FRAMES = 32_000;
/** Quanta between a command posted at the start of quantum n and the core acting on it (the batch is delivered for the next quantum). */
const CORE_LAG = 1;
const GAIN_TOL = 1e-5;
const PITCH_TOL = 5e-5;
const LP_TOL = 0.01;
const SINE_HZ = 3000;
const SINE_AMP = 0.5;

// --- Clips: DC (gain), an integer ramp (pitch: linear interpolation of a linear ramp is exact), a sine (low-pass) ---

const dcClip = new Float32Array(CLIP_FRAMES).fill(0.25);
const rampClip = Float32Array.from({ length: CLIP_FRAMES }, (_, k) => (k < RAMP_FRAMES ? k / 32767 : 0));
const sineClip = Float32Array.from({ length: CLIP_FRAMES }, (_, k) => SINE_AMP * Math.sin((2 * Math.PI * SINE_HZ * k) / RATE));
const CLIPS = { dc: dcClip, ramp: rampClip, sine: sineClip } as const;
type ClipKind = keyof typeof CLIPS;
const BYTES: Record<ClipKind, number> = { dc: 16, ramp: 8, sine: 24 };
const decode = fakeDecoder(async (bytes): Promise<PlanarClip> => {
  const kind = (Object.keys(BYTES) as ClipKind[]).find((k) => BYTES[k] === bytes.byteLength)!;
  return { frames: CLIP_FRAMES, channels: 1, sampleRate: RATE, channelData: [CLIPS[kind]] };
});
const fetchBytes = async (path: string) => new ArrayBuffer(BYTES[path.replace(".wav", "") as ClipKind]);

// --- The core rig (a loopback host and a CoreBackend; skipped where the wasm isn't built) ---

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
  vi.restoreAllMocks();
});

async function coreRig() {
  const testing = await import("../testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>> & { link: CoreLink };
  try {
    loop = (await testing.createLoopbackHost({ preset: { ...testing.LOOPBACK_PRESET, limiterLookaheadMs: 0 } })) as typeof loop;
  } catch {
    return null;
  }
  const link = loop.link;
  const clips = createClipRegistry({ send: (m) => link.post(m), nextSeq: () => link.nextSeq(), fetchBytes, decodeWorker: decode, nextFrame: (cb) => cb(), nextQuantum: (cb) => cb() });
  const host: CoreBackendHost = { link, status: "running", preset: { maxLogical: 16, maxMixed: 8 }, worldCount: 1, sampleRate: RATE, addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"] };
  const mixer = new Mixer(defaultAudioSettings());
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer });
  closers.push(() => backend.dispose());
  /** One quantum: the backend's frame work, then the core's render; the left channel. */
  const quantum = async (): Promise<Float32Array> => {
    mixer.update(DT);
    backend.update(DT);
    const out = loop.renderQuanta(1).left;
    for (let k = 0; k < 4; k++) await Promise.resolve();
    return out;
  };
  return { backend, quantum };
}

/** A voice for `TsAutomation` that records what the evaluator hands its setters. */
function tsVoice(id: number) {
  const v = { id, playing: true, volume: [] as number[], pitch: [] as number[], setVolume(x: number) { v.volume.push(x); }, setPitch(x: number) { v.pitch.push(x); } };
  return v;
}

// --- Scenes ---

interface Action { q: number; group: number; slot: number; value: number; seek: number }
interface VoiceSpec { group: number; volume?: number; pitch?: number; bindings: Binding[] }
interface Scene {
  name: string;
  curves: Record<number, Curve>;
  voices?: VoiceSpec[];
  bus?: Binding[];
  /** Parameters set before the voices play (jumped, both sides). */
  initial?: { group: number; slot: number; value: number }[];
  actions: Action[];
  quanta: number;
}

const bind = (slot: number, curve: number, target: AutoTarget, global = true): Binding => ({ param: { global, slot }, curve, target });
const act = (q: number, slot: number, value: number, seek: number, group = 0): Action => ({ q, group, slot, value, seek });
/** A volume curve over 0..1 whose middle key is where the shape under test changes: [0 → 0.2] [0.5 → 1] [1 → 0.3]. */
const shaped = (interp: "linear" | "step" | "smooth" | "easeIn" | "easeOut"): Curve => [[0, 0.2, interp], [0.5, 1, interp], [1, 0.3]];
const ALL_SHAPES: Curve = [[0, 0.1, "linear"], [1, 1, "smooth"], [2, 0.2, "easeIn"], [3, 0.9, "easeOut"], [4, 0.4, "step"], [5, 1]];

const volumeScenes: Scene[] = [
  ...(["linear", "step", "smooth", "easeIn", "easeOut"] as const).map((interp): Scene => ({
    name: `volume, ${interp} segments, a seek from 0 to 1`,
    curves: { 0: shaped(interp) },
    voices: [{ group: 0, bindings: [bind(0, 0, AutoTarget.Volume)] }],
    initial: [{ group: 0, slot: 0, value: 0 }],
    actions: [act(3, 0, 1, 20)],
    quanta: 30,
  })),
  {
    name: "volume, every shape in one curve, swept 0 to 5.5",
    curves: { 0: ALL_SHAPES },
    voices: [{ group: 0, bindings: [bind(0, 0, AutoTarget.Volume)] }],
    initial: [{ group: 0, slot: 0, value: 0 }],
    actions: [act(2, 0, 5.5, 40)],
    quanta: 130,
  },
  {
    name: "volume, seek speed 0 jumps (and a jump back)",
    curves: { 0: shaped("linear") },
    voices: [{ group: 0, bindings: [bind(0, 0, AutoTarget.Volume)] }],
    initial: [{ group: 0, slot: 0, value: 0.1 }],
    actions: [act(3, 0, 0.9, 0), act(6, 0, 0.3, 0)],
    quanta: 10,
  },
  {
    name: "volume, a parameter changed mid-ramp (retarget, then reverse)",
    curves: { 0: shaped("smooth") },
    voices: [{ group: 0, bindings: [bind(0, 0, AutoTarget.Volume)] }],
    initial: [{ group: 0, slot: 0, value: 0 }],
    actions: [act(2, 0, 1, 10), act(9, 0, 0.2, 25), act(14, 0, 0.8, 5), act(17, 0, 0.8, 0)],
    quanta: 40,
  },
  {
    name: "volume, one global parameter driving three voices with different curves and volumes",
    curves: { 0: shaped("linear"), 1: shaped("smooth"), 2: [[0, 1], [1, 0.1, "easeOut"]] },
    voices: [
      { group: 0, volume: 1, bindings: [bind(0, 0, AutoTarget.Volume)] },
      { group: 0, volume: 0.5, bindings: [bind(0, 1, AutoTarget.Volume)] },
      { group: 0, volume: 0.25, bindings: [bind(0, 2, AutoTarget.Volume)] },
    ],
    initial: [{ group: 0, slot: 0, value: 0.05 }],
    actions: [act(2, 0, 0.95, 15)],
    quanta: 30,
  },
  {
    name: "volume, a local parameter per instance (group), the same slot at three values",
    curves: { 0: shaped("linear") },
    voices: [
      { group: 1, volume: 1, bindings: [bind(0, 0, AutoTarget.Volume, false)] },
      { group: 2, volume: 0.5, bindings: [bind(0, 0, AutoTarget.Volume, false)] },
      { group: 3, volume: 0.25, bindings: [bind(0, 0, AutoTarget.Volume, false)] },
    ],
    initial: [{ group: 1, slot: 0, value: 0.2 }, { group: 2, slot: 0, value: 0.7 }, { group: 3, slot: 0, value: 0.45 }],
    actions: [act(3, 0, 0.9, 12, 2), act(5, 0, 0.05, 0, 3), act(8, 0, 0.6, 20, 1)],
    quanta: 25,
  },
  {
    name: "volume, a local and a global parameter on one voice (product of two curves)",
    curves: { 0: shaped("linear"), 1: [[0, 0.5], [1, 1]] },
    voices: [{ group: 4, bindings: [bind(2, 0, AutoTarget.Volume, false), bind(1, 1, AutoTarget.Volume, true)] }],
    initial: [{ group: 4, slot: 2, value: 0.3 }, { group: 0, slot: 1, value: 0.2 }],
    actions: [act(2, 2, 0.8, 18, 4), act(4, 1, 1, 10)],
    quanta: 25,
  },
  {
    name: "volume, values outside the curve's x range clamp to the end keys",
    curves: { 0: [[0.25, 0.3, "smooth"], [0.75, 0.9]] },
    voices: [{ group: 0, bindings: [bind(0, 0, AutoTarget.Volume)] }],
    initial: [{ group: 0, slot: 0, value: -4 }],
    actions: [act(3, 0, 9, 0), act(6, 0, -7, 0), act(9, 0, 0.5, 0), act(12, 0, 50, 30)],
    quanta: 20,
  },
  // Curve outputs outside what a voice can use: the two evaluators clamp the same way (negative volume is silence).
  {
    name: "volume, a curve that goes negative clamps to silence",
    curves: { 0: [[0, 0.8], [0.3, -0.5], [0.5, -0.5], [0.7, 0.8], [1, 0.8]] },
    voices: [{ group: 0, bindings: [bind(0, 0, AutoTarget.Volume)] }],
    initial: [{ group: 0, slot: 0, value: 0.05 }],
    actions: [act(2, 0, 0.95, 12)],
    quanta: 36,
  },
  {
    name: "volume, two negative curves multiply to silence, not to a positive product",
    curves: { 0: [[0, -0.5], [1, -0.5]], 1: [[0, -0.8], [1, 0.9]] },
    voices: [{ group: 0, bindings: [bind(0, 0, AutoTarget.Volume), bind(0, 1, AutoTarget.Volume)] }, { group: 0, bindings: [bind(0, 0, AutoTarget.Volume)] }],
    initial: [{ group: 0, slot: 0, value: 0.9 }],
    actions: [act(2, 0, 0, 12)],
    quanta: 30,
  },
  {
    name: "volume, a binding to a curve that was never defined is the empty curve (0), as on the core",
    curves: { 0: shaped("linear") },
    voices: [{ group: 0, bindings: [bind(0, 0, AutoTarget.Volume), bind(0, 77, AutoTarget.Volume)] }],
    initial: [{ group: 0, slot: 0, value: 0.5 }],
    actions: [act(2, 0, 1, 12)],
    quanta: 10,
  },
];

const pitchScenes: Scene[] = [
  {
    name: "pitch, a global parameter through a linear curve, with a base pitch",
    curves: { 0: [[0, 0.5], [1, 2]] },
    voices: [{ group: 0, pitch: 1.25, bindings: [bind(0, 0, AutoTarget.Pitch)] }],
    initial: [{ group: 0, slot: 0, value: 0.3 }],
    actions: [act(3, 0, 0.9, 6)],
    quanta: 30,
  },
  {
    name: "pitch, a local parameter through a smooth curve, jumped then sought",
    curves: { 0: [[0, 0.7, "smooth"], [1, 1.6]] },
    voices: [{ group: 6, bindings: [bind(1, 0, AutoTarget.Pitch, false)] }],
    initial: [{ group: 6, slot: 1, value: 0 }],
    actions: [act(4, 1, 0.8, 0, 6), act(8, 1, 0.1, 4, 6)],
    quanta: 30,
  },
  {
    name: "pitch, a curve that reaches 0 or goes negative leaves the rate alone (a factor of 1), never a stalled voice",
    curves: { 0: [[0, -1], [0.2, 0], [0.5, 1.5], [1, 2]] },
    voices: [{ group: 0, bindings: [bind(0, 0, AutoTarget.Pitch)] }],
    initial: [{ group: 0, slot: 0, value: 0.8 }],
    actions: [act(2, 0, 0, 3), act(25, 0, 0.9, 3)],
    quanta: 50,
  },
  {
    name: "pitch, two pitch bindings multiply (one of them below 0 is ignored)",
    curves: { 0: [[0, 0.5], [1, 1.5]], 1: [[0, -2], [1, -2]] },
    voices: [{ group: 0, bindings: [bind(0, 0, AutoTarget.Pitch), bind(0, 1, AutoTarget.Pitch)] }],
    initial: [{ group: 0, slot: 0, value: 0.2 }],
    actions: [act(2, 0, 0.9, 5)],
    quanta: 20,
  },
];

const lowpassScenes: Scene[] = [
  {
    name: "low-pass, a cutoff swept down through an easeOut curve",
    curves: { 0: [[0, 18_000, "easeOut"], [1, 600]] },
    voices: [{ group: 0, bindings: [bind(0, 0, AutoTarget.Lowpass)] }],
    initial: [{ group: 0, slot: 0, value: 0.1 }],
    actions: [act(4, 0, 0.95, 1.5)],
    quanta: 40,
  },
  {
    name: "low-pass, the lowest of two cutoffs wins",
    curves: { 0: [[0, 9000], [1, 1000]], 1: [[0, 1500], [1, 8000]] },
    voices: [{ group: 0, bindings: [bind(0, 0, AutoTarget.Lowpass), bind(1, 1, AutoTarget.Lowpass)] }],
    initial: [{ group: 0, slot: 0, value: 0 }, { group: 0, slot: 1, value: 0 }],
    actions: [act(3, 0, 1, 1), act(6, 1, 1, 2)],
    quanta: 40,
  },
];

const busScenes: Scene[] = [
  {
    name: "bus volume, a global parameter through a smooth curve",
    curves: { 0: [[0, 1], [1, 0.2, "smooth"]] },
    bus: [bind(0, 0, AutoTarget.Volume)],
    initial: [{ group: 0, slot: 0, value: 0 }],
    actions: [act(3, 0, 1, 15), act(10, 0, 0.3, 0)],
    quanta: 30,
  },
  {
    name: "bus volume, a step curve then a linear segment, with the parameter retargeted mid-seek",
    curves: { 0: [[0, 1, "step"], [0.4, 0.5], [1, 0.1]] },
    bus: [bind(0, 0, AutoTarget.Volume)],
    initial: [{ group: 0, slot: 0, value: 0.1 }],
    actions: [act(2, 0, 1, 13), act(14, 0, 0.1, 9)],
    quanta: 30,
  },
];

// --- Running a scene ---

interface Rig { backend: CoreBackend; quantum: () => Promise<Float32Array> }

/** The core's gain at unity for the scene's clip: each voice alone, unbound, in a throwaway rig. */
async function unitLevel(clip: ClipKind, volume: number, pitch = 1): Promise<{ last: number; slope: number }> {
  const rig = await coreRig();
  if (!rig) throw new Error("no core");
  rig.backend.play({ path: `${clip}.wav`, url: "", loop: true, stream: false, bus: "SFX", volume, pitch });
  let out: Float32Array = new Float32Array(Q);
  const seen: Float32Array[] = [];
  for (let n = 0; n < 60; n++) {
    out = await rig.quantum();
    seen.push(out);
    if (seen.length >= 3 && seen[seen.length - 1]!.some((s) => s !== 0) && seen[seen.length - 2]!.some((s) => s !== 0)) break;
  }
  return { last: out[Q - 1]!, slope: (out[Q - 1]! - out[0]!) / (Q - 1) };
}

interface SceneRun {
  /** Per quantum, the core's rendered left channel. */
  core: Float32Array[];
}

/** Applies a scene's setup and per-quantum actions to a core rig, returning each quantum's audio from the first with every voice sounding. */
async function runCore(rig: Rig, scene: Scene, clip: ClipKind, afterSetup?: () => void): Promise<SceneRun> {
  const a = rig.backend.automation;
  for (const [id, c] of Object.entries(scene.curves)) a.defineCurve(Number(id), c);
  for (const p of scene.initial ?? []) a.setParam(p.group, p.slot, p.value, 0);
  const voices: AudioVoice[] = [];
  for (const spec of scene.voices ?? []) {
    voices.push(rig.backend.play({ path: `${clip}.wav`, url: "", loop: true, stream: false, bus: "SFX", volume: spec.volume ?? 1, pitch: spec.pitch ?? 1, group: spec.group })!);
  }
  (scene.voices ?? []).forEach((spec, i) => a.bindVoice(voices[i]!, spec.group, spec.bindings, { volume: spec.volume ?? 1, pitch: spec.pitch ?? 1 }));
  if (scene.bus) a.bindBus("SFX", scene.bus);
  afterSetup?.();
  // Wait until the clips are on the core (an async decode, so by voice state: a scene may be silent), then settle a few
  // quanta at the initial values.
  const want = voices.length || 1;
  let settled = -1;
  for (let n = 0; n < 80 && settled < 6; n++) {
    await rig.quantum();
    const playing = rig.backend.debug().voices.filter((v) => v.state === "playing" || v.state === "virtual").length;
    settled = playing >= want ? settled + 1 : -1;
  }
  if (settled < 6) throw new Error("the clips never started");
  const core: Float32Array[] = [];
  for (let q = 0; q < scene.quanta; q++) {
    for (const x of scene.actions) if (x.q === q) a.setParam(x.group, x.slot, x.value, x.seek);
    core.push(await rig.quantum());
  }
  return { core };
}

/** The TypeScript side of a scene: one `update(DT)` per quantum, recording what it hands the setters or the mixer. */
function runTs(scene: Scene) {
  const ts = new TsAutomation();
  for (const [id, c] of Object.entries(scene.curves)) ts.defineCurve(Number(id), c);
  for (const p of scene.initial ?? []) ts.setParam(p.group, p.slot, p.value, 0);
  const voices = (scene.voices ?? []).map((spec, i) => {
    const v = tsVoice(i + 1);
    ts.bindVoice(v as unknown as AudioVoice, spec.group, spec.bindings, { volume: spec.volume ?? 1, pitch: spec.pitch ?? 1 });
    return v;
  });
  const bus: { gain: number; lowpass: number }[] = [];
  const spy = vi.spyOn(globalMixer, "_setAutomation").mockImplementation((_name, gain, lowpass) => { bus.push({ gain, lowpass }); });
  if (scene.bus) ts.bindBus("SFX", scene.bus);
  // The values at the end of the settle (the initial values), for the first quantum's ramp start.
  ts.update(DT);
  const settled = { gain: voices.map((v) => v.volume.at(-1)), pitch: voices.map((v) => v.pitch.at(-1)), bus: bus.at(-1) };
  const series = voices.map(() => ({ volume: [] as number[], pitch: [] as number[] }));
  const busSeries: { gain: number; lowpass: number }[] = [];
  const cutoff: number[] = [];
  for (let q = 0; q < scene.quanta; q++) {
    for (const x of scene.actions) if (x.q + CORE_LAG === q) ts.setParam(x.group, x.slot, x.value, x.seek);
    ts.update(DT);
    voices.forEach((v, i) => {
      series[i]!.volume.push(v.volume.at(-1)!);
      series[i]!.pitch.push(v.pitch.at(-1)!);
    });
    if (scene.bus) busSeries.push(bus.at(-1)!);
    if (scene.voices?.[0]?.bindings.some((b) => b.target === AutoTarget.Lowpass)) {
      const spec = scene.voices[0]!;
      cutoff.push(evaluate(spec.bindings, new Map(Object.entries(scene.curves).map(([k, c]) => [Number(k), c])), (p) => ts.valueOf(p.global ? 0 : spec.group, p.slot)).lowpass);
    }
  }
  spy.mockRestore();
  return { series, busSeries, cutoff, settled };
}

/** Frame j of a quantum ramping from `a` (the end of the previous quantum) to `b`: the core's contract (`ramp_at`). */
const ramp = (a: number, b: number, j: number): number => a + (b - a) * ((j + 1) / Q);

async function sceneRig(): Promise<Rig | null> {
  return coreRig();
}

describe("the evaluator's per-binding clamps (the rules the core's `evaluate` is pinned to in audio-core/tests/automation.rs)", () => {
  const read = () => 0.5;
  const bindings = (...targets: [number, AutoTarget][]): Binding[] => targets.map(([curve, target]) => ({ param: { global: true, slot: 0 }, curve, target }));
  const curves = new Map<number, Curve>([[0, [[0, -0.5]]], [1, [[0, -0.8]]], [2, [[0, 2]]], [3, [[0, 0]]]]);
  it("clamps a volume curve below 0 to silence before multiplying", () => {
    expect(evaluate(bindings([0, AutoTarget.Volume], [1, AutoTarget.Volume]), curves, read).gain).toBe(0);
  });
  it("leaves the rate alone for a pitch curve at or below 0", () => {
    expect(evaluate(bindings([2, AutoTarget.Pitch], [0, AutoTarget.Pitch], [3, AutoTarget.Pitch]), curves, read).pitch).toBe(2);
  });
  it("treats a curve id that was never defined as the empty curve (0), as the core's table does", () => {
    expect(evaluate(bindings([77, AutoTarget.Volume]), curves, read).gain).toBe(0);
  });
});

describe("automation parity: the core and TsAutomation agree (E3.4)", () => {
  for (const scene of volumeScenes) {
    it(scene.name, { timeout: 30_000 }, async (ctx) => {
      const rig = await sceneRig();
      if (!rig) return ctx.skip();
      const unit = await unitLevel("dc", 1);
      const ts = runTs(scene);
      const { core } = await runCore(rig, scene, "dc");
      let worst = 0;
      for (let q = 0; q < scene.quanta; q++) {
        for (let j = 0; j < Q; j++) {
          // The core's output sums the voices; each is `volume × gain`, the gain ramped from the previous quantum's.
          let expected = 0;
          ts.series.forEach((s, i) => {
            const prev = q === 0 ? (ts.settled.gain[i] as number) : s.volume[q - 1]!;
            expected += ramp(prev, s.volume[q]!, j);
          });
          const got = core[q]![j]! / unit.last;
          worst = Math.max(worst, Math.abs(got - expected));
        }
      }
      expect(worst).toBeLessThan(GAIN_TOL);
    });
  }

  for (const scene of pitchScenes) {
    it(scene.name, { timeout: 30_000 }, async (ctx) => {
      const rig = await sceneRig();
      if (!rig) return ctx.skip();
      const unit = await unitLevel("ramp", 1);
      const ts = runTs(scene);
      const { core } = await runCore(rig, scene, "ramp");
      let worst = 0;
      let prevLast: number | null = null;
      for (let q = 0; q < scene.quanta; q++) {
        const s = ts.series[0]!;
        const prev = q === 0 ? (ts.settled.pitch[0] as number) : s.pitch[q - 1]!;
        // The mean rate over the quantum's 128 frames, from the advance of the ramp clip's position.
        const first = prevLast ?? core[q]![0]! - unit.slope * prev;
        const advance = (core[q]![Q - 1]! - first) / unit.slope;
        // Output sample k sits at the position the k previous frames advanced: so the advance from the previous
        // quantum's last sample is that quantum's last rate plus this quantum's first 127.
        let mean = prev;
        for (let j = 0; j < Q - 1; j++) mean += ramp(prev, s.pitch[q]!, j);
        expect(Number.isFinite(advance)).toBe(true);
        worst = Math.max(worst, Math.abs(advance - mean) / Q);
        prevLast = core[q]![Q - 1]!;
      }
      expect(worst).toBeLessThan(PITCH_TOL);
    });
  }

  for (const scene of busScenes) {
    it(scene.name, { timeout: 30_000 }, async (ctx) => {
      const rig = await sceneRig();
      if (!rig) return ctx.skip();
      const dummy: Scene = { ...scene, voices: [{ group: 0, bindings: [] }] };
      const unit = await unitLevel("dc", 1);
      const ts = runTs(scene);
      const { core } = await runCore(rig, dummy, "dc");
      let worst = 0;
      let prev = ts.settled.bus!.gain;
      for (let q = 0; q < scene.quanta; q++) {
        const now = ts.busSeries[q]!.gain;
        for (let j = 0; j < Q; j++) worst = Math.max(worst, Math.abs(core[q]![j]! / unit.last - ramp(prev, now, j)));
        prev = now;
      }
      expect(worst).toBeLessThan(GAIN_TOL);
    });
  }

  for (const scene of lowpassScenes) {
    it(scene.name, { timeout: 30_000 }, async (ctx) => {
      const rig = await sceneRig();
      if (!rig) return ctx.skip();
      const ts = runTs(scene);
      const { core } = await runCore(rig, scene, "sine");
      let worst = 0;
      for (let q = 0; q < scene.quanta; q++) {
        const rms = Math.sqrt(core[q]!.reduce((s, x) => s + x * x, 0) / Q);
        const expected = (await unitSine()) * lowpassMagnitude(ts.cutoff[q]!);
        worst = Math.max(worst, Math.abs(rms / expected - 1));
      }
      expect(worst).toBeLessThan(LP_TOL);
    });
  }
});

let sineUnit: number | undefined;
/** The RMS of the unfiltered sine through an unbound voice (pan law included). */
async function unitSine(): Promise<number> {
  if (sineUnit !== undefined) return sineUnit;
  const rig = (await coreRig())!;
  rig.backend.play({ path: "sine.wav", url: "", loop: true, stream: false, bus: "SFX" });
  let out: Float32Array = new Float32Array(Q);
  for (let n = 0; n < 60; n++) {
    out = await rig.quantum();
    if (n > 8 && out.some((s) => s !== 0)) break;
  }
  sineUnit = Math.sqrt(out.reduce((s, x) => s + x * x, 0) / Q);
  return sineUnit;
}

/** |H| at `SINE_HZ` of the core's low-pass biquad at `cutoff` Hz, Q 1 dB (the core's snapshot filter). */
function lowpassMagnitude(cutoff: number): number {
  const c = Math.min(1, Math.max(0, cutoff / (RATE / 2)));
  if (c >= 1) return 1;
  if (c <= 0) return 0;
  // audio-dsp's `coeffs::lowpass` (the RBJ low-pass, Q = 10^(dB / 20)), normalised by a0.
  const q = Math.pow(10, 1 / 20);
  const theta = Math.PI * c;
  const alpha = Math.sin(theta) / (2 * q);
  const cosw = Math.cos(theta);
  const beta = (1 - cosw) / 2;
  const a0 = 1 + alpha;
  const b0 = beta / a0, b1 = (2 * beta) / a0, b2 = beta / a0, a1 = (-2 * cosw) / a0, a2 = (1 - alpha) / a0;
  const w = (2 * Math.PI * SINE_HZ) / RATE;
  const num = Math.hypot(b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w), -(b1 * Math.sin(w) + b2 * Math.sin(2 * w)));
  const den = Math.hypot(1 + a1 * Math.cos(w) + a2 * Math.cos(2 * w), -(a1 * Math.sin(w) + a2 * Math.sin(2 * w)));
  return num / den;
}
