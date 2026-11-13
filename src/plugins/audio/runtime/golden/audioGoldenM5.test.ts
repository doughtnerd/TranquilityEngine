// 0171/0172 M5-0, tasks G1 and DS0 (api-and-models §10 "Golden (Node, real wasm)": new goldens for stamped ramps, stamped
// config, the tombstone, a late sequence and a presence duck, native equals wasm; the waves plan's DS0: the discontinuity
// check on the stamped fade, snapshot, presence duck and post-fader mute scenes).
//
// The fixtures under `golden/m5/` are written natively by `native/audio/crates/audio-core/tests/m5_goldens.rs` and
// `m5_presence_golden.rs` (`UPDATE_GOLDENS=1`; this file never writes them), which also hold each scene against its
// offline reference. Here the real committed wasm replays each on the loopback host and must give the same bits, the
// same split and late counters, and stay within the fixture's discontinuity bounds (`maxStep`, F-40).
//
// The format is Z3's (`audioGoldenM4.test.ts`, whose renderer this repeats rather than importing that test file and
// running its suite twice), plus: a send step's optional `firstFrame` (the batch header's first frame when the batch
// arrives after it; otherwise the host's current frame), `late` (`lateCommands`, `maxLatenessFrames`), `null` (the
// native error against the reference, informational), `ds0` (`[from, to, bound]` windows) and `busDuck` (the presence
// duck's target slot and its voice's level: the last STATUS block's busDuck gain is checked against the output).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mixer } from "../../../../engine/audio/mixer";
import { abrupt, closeRigs, liveRig, SMOOTH } from "../mix/clickHarness";
import { createLoopbackHost, LOOPBACK_PRESET, type LoopbackHost } from "../testing";
import { BUS_LP_OFF_HZ, BUS_MASTER_OUT, BUS_RAMP_MASK_GAIN, Kind, LANE_RUNTIME, writeBatchHeader, writeClipBegin, writeClipChunk, writeEnvelope } from "../wire.generated";
import { maxStep } from "./maxStep";

const M5_DIR = fileURLToPath(new URL("./m5/", import.meta.url));

interface M5Fixture {
  readonly scene: string;
  readonly about: string;
  readonly preset: { readonly maxLogical: number; readonly maxMixed: number; readonly maxBuses: number; readonly limiterLookaheadMs: number };
  readonly clips: readonly { readonly id: number; readonly frames: number; readonly fill: "dc"; readonly value: number }[];
  readonly steps: readonly ({ readonly send: string; readonly count: number; readonly firstFrame?: number } | { readonly run: number })[];
  readonly frames: number;
  readonly fnv1a64: string;
  readonly splits: { readonly splitQuanta: number; readonly voiceSplits: number };
  readonly late?: { readonly lateCommands: number; readonly maxLatenessFrames: number };
  readonly null?: { readonly maxError: number; readonly tolerance: number; readonly from: number; readonly to: number };
  readonly ds0?: readonly (readonly [number, number, number])[];
  readonly busDuck?: { readonly slot: number; readonly level: number };
  /** Rv1's `bus-mute-send` only: each mute or unmute transition's `[first frame, frames]`. */
  readonly toggles?: readonly (readonly [number, number])[];
}

/** G1's scenes (`m5_goldens.rs`), the presence duck (`m5_presence_golden.rs`) and Rv1's named golden. */
const G1_CASES = ["stamped-fade", "stamped-snapshot", "stamped-slot", "tombstone", "late-sequence", "two-sends"] as const;
const PRESENCE = "presence-duck";
const RV1 = "bus-mute-send";

function readM5(name: string): M5Fixture {
  const path = `${M5_DIR}${name}.json`;
  if (!existsSync(path)) throw new Error(`no golden/m5/${name}.json: run UPDATE_GOLDENS=1 cargo test -p audio-core --test m5_goldens (native/audio)`);
  return JSON.parse(readFileSync(path, "utf8")) as M5Fixture;
}

/** FNV-1a 64 over `left`'s f32 bytes then `right`'s, as 16 lowercase hex digits (Z3's digest). */
function fnv1a64(left: Float32Array, right: Float32Array): string {
  let h = 0xcbf29ce484222325n;
  for (const part of [left, right]) {
    const bytes = new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
    for (let i = 0; i < bytes.length; i++) h = ((h ^ BigInt(bytes[i]!)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/** Replays the fixture on a loopback host (DC clips as CLIP_BEGIN + one CLIP_CHUNK; steps as BATCHes). */
async function render(fixture: M5Fixture): Promise<{ readonly left: Float32Array; readonly right: Float32Array; readonly host: LoopbackHost; readonly lateness: { max: number } }> {
  const host = await createLoopbackHost({ preset: { ...LOOPBACK_PRESET, ...fixture.preset } });
  // `maxLatenessFrames` is per STATUS block (reset at each take): keep the largest any block carried.
  const lateness = { max: 0 };
  host.link.onStatus((s) => {
    lateness.max = Math.max(lateness.max, s.maxLatenessFrames);
  });
  let seq = 1;
  for (const clip of fixture.clips) {
    const begin = new ArrayBuffer(16 + 20);
    writeEnvelope(new DataView(begin), 0, { kind: Kind.CLIP_BEGIN, seq: seq++, bodyBytes: 20 });
    writeClipBegin(new DataView(begin), 0, { clipId: clip.id, frames: clip.frames, channels: 1, sampleRate: 48_000, format: 0 });
    host.send(begin);
    const samples = new Float32Array(clip.frames).fill(clip.value);
    const chunk = new ArrayBuffer(32 + samples.byteLength);
    writeEnvelope(new DataView(chunk), 0, { kind: Kind.CLIP_CHUNK, seq: seq++, bodyBytes: 16 + samples.byteLength });
    writeClipChunk(new DataView(chunk), 0, { clipId: clip.id, frameOffset: 0, frames: clip.frames, reserved: 0 });
    new Uint8Array(chunk, 32).set(new Uint8Array(samples.buffer));
    host.send(chunk);
  }
  const left = new Float32Array(fixture.frames);
  const right = new Float32Array(fixture.frames);
  let at = 0;
  for (const step of fixture.steps) {
    if ("run" in step) {
      const out = host.renderQuanta(step.run);
      left.set(out.left, at);
      right.set(out.right, at);
      at += out.left.length;
      continue;
    }
    const bytes = Uint8Array.from(step.send.match(/../g) ?? [], (b) => parseInt(b, 16));
    const buffer = new ArrayBuffer(32 + bytes.length);
    writeEnvelope(new DataView(buffer), 0, { kind: Kind.BATCH, seq: seq++, bodyBytes: 16 + bytes.length });
    writeBatchHeader(new DataView(buffer), 0, { firstFrame: step.firstFrame ?? host.frame, count: step.count, flags: 0 });
    new Uint8Array(buffer, 32).set(bytes);
    host.send(buffer);
  }
  expect(at, `${fixture.scene}: frames rendered`).toBe(fixture.frames);
  return { left, right, host, lateness };
}

/** The largest step of both channels over `[from, to)`. */
function step2(left: Float32Array, right: Float32Array, from: number, to: number): number {
  return Math.max(maxStep(left, from, to), maxStep(right, from, to));
}

/** Digest, counters (STATUS after 6 more quanta, as Z3's test reads them), DS0's windows and the busDuck reading. */
async function checkScene(name: string): Promise<void> {
  const fixture = readM5(name);
  const { left, right, host, lateness } = await render(fixture);
  expect(left.every(Number.isFinite) && right.every(Number.isFinite), `${name}: finite`).toBe(true);
  const digest = fnv1a64(left, right);
  expect(digest, `${name}: wasm digest ${digest} != native ${fixture.fnv1a64}`).toBe(fixture.fnv1a64);
  for (const [from, to, bound] of fixture.ds0 ?? []) {
    const step = step2(left, right, from, to);
    expect(step, `${name}: DS0 ${from}..${to}: largest step ${step} over ${bound}`).toBeLessThanOrEqual(bound);
  }
  host.renderQuanta(6);
  const last = host.statuses.at(-1);
  expect(last && { splitQuanta: last.splitQuanta, voiceSplits: last.voiceSplits }, `${name}: split counters`).toEqual(fixture.splits);
  expect(fixture.splits.splitQuanta, `${name}: no split quanta`).toBe(0);
  if (fixture.late) expect(last && { lateCommands: last.lateCommands, maxLatenessFrames: lateness.max }, `${name}: late counters (lateCommands cumulative; maxLatenessFrames per block, the largest)`).toEqual(fixture.late);
  if (fixture.busDuck) {
    // The last block's busDuck gain is the duck gain at the end of the quantum ending at its `currentFrame` (STATUS
    // follows the 6/48-quantum cadence, so take whichever block came last). The scene's voice is a DC 0.5 on the target
    // with no other lane moving, so that gain is twice the output's sample just before `currentFrame`.
    const { slot, level } = fixture.busDuck;
    const item = last?.busDuck.find((d) => d.slot === slot);
    expect(item, `${name}: busDuck has slot ${slot}`).toBeDefined();
    const at = last!.currentFrame;
    expect(at, `${name}: a STATUS block inside the scene`).toBeGreaterThan(0);
    expect(at).toBeLessThanOrEqual(fixture.frames);
    const heard = left[at - 1]! / level;
    expect(Math.abs(item!.gain - heard), `${name}: busDuck gain ${item!.gain} at ${at}, the output says ${heard}`).toBeLessThanOrEqual(1e-6);
    expect(item!.gain).toBeLessThan(1);
  }
}

describe("M5 goldens (G1): native equals wasm", () => {
  it.for(G1_CASES)("%s: the wasm output equals the native digest; counters and DS0 windows hold", async (name) => {
    await checkScene(name);
  });

  // Dp1's core (presence in `duck.rs`).
  it(`${PRESENCE}: the wasm output equals the native digest; the duck's DS0 window and busDuck STATUS hold`, async () => {
    await checkScene(PRESENCE);
  });

  it("golden/m5/ holds no fixture without a case", () => {
    const names = readdirSync(M5_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length));
    const known: readonly string[] = [...G1_CASES, PRESENCE, RV1];
    for (const name of names) expect(known, `m5/${name}.json has no case`).toContain(name);
  });
});

describe("DS0: the discontinuity check on M5-0's scenes (wasm output)", () => {
  // The stamped fade, the snapshot change and the presence duck carry their windows in their fixtures and run
  // in `checkScene` above; the fixture's bound is the offline reference's own largest step plus 1 %.
  it("the stamped fade, the snapshot and the presence duck scenes carry DS0 windows", () => {
    for (const name of ["stamped-fade", "stamped-snapshot", PRESENCE]) expect(readM5(name).ds0?.length, `${name}: DS0 windows`).toBeGreaterThan(0);
  });

  // Rv1's post-fader mute (`m5/bus-mute-send`): each mute or unmute window steps no more than the steady output's largest
  // step plus the dry ramp's (the voice's 0.5 under MASTER 0.5, ramped over the toggle).
  it("post-fader mute (bus-mute-send): every toggle under its bound", async () => {
    const fixture = readM5(RV1);
    const { left, right } = await render(fixture);
    expect(fnv1a64(left, right)).toBe(fixture.fnv1a64);
    const steady = step2(left, right, 20 * 128, 40 * 128);
    for (const [at, n] of fixture.toggles ?? []) {
      const bound = steady + 0.25 / n;
      const step = step2(left, right, Math.max(0, at - 128), Math.min(left.length, at + n + 128));
      expect(step, `toggle at ${at}: ${step} over ${bound}`).toBeLessThanOrEqual(bound);
    }
    expect(fixture.toggles?.length).toBe(2);
  });
});

// --- DSd: the discontinuity check on the Mixer scene -------------------------------------------------------------------
// Sa2's Mixer page (`samples/sound-lab/scenes/mixer.scene.json`) plays on the Sound Lab project's buses and rules, which
// this reads from disk (a test may read a sample; `src/` never imports one). The real wasm renders them on the loopback host
// through the page's mixer and the live-edit path (`clickHarness.ts`), Master at 0.5 so four tone voices stay under the
// limiter (as Ck1's copy of this mixer did). Two checks:
//   1. every ducking rule is audible: the trigger's tone makes the target's duck lane fall to the rule's amount, and
//      stopping the trigger lets it release (the lane is the core's STATUS `busDuck`, read through `Bus.duckGain`);
//   2. a live session of edits on the Mixer scene's buses and rules, each under F-40's `maxStep` bound: no step in an edit's
//      window beyond the signal's own largest step before and after it, plus 1 %; an abrupt control shows the detector fires.
type DuckRule = { target: string; trigger: string; mode: string; amount: number; attack: number; release: number; detector?: string; threshold?: number };
interface MixerSceneProject {
  readonly buses: readonly { readonly name: string; readonly volume?: number }[];
  readonly ducking: readonly DuckRule[];
}

const SOUND_LAB_AUDIO = (JSON.parse(readFileSync(fileURLToPath(new URL("../../../../../samples/sound-lab/project.json", import.meta.url)), "utf8")) as { audio: MixerSceneProject }).audio;
const MIXER_SCENE = { ...SOUND_LAB_AUDIO, buses: SOUND_LAB_AUDIO.buses.map((b) => (b.name === "Master" ? { ...b, volume: 0.5 } : b)) };

describe("DSd: the Mixer scene (Sa2) on the real core", () => {
  afterEach(async () => {
    await closeRigs();
  });

  it("the Mixer scene has the three rules the page shows: one presence and two level (RMS and peak)", () => {
    expect(SOUND_LAB_AUDIO.ducking.map((r) => [r.trigger, r.target, r.mode, r.detector ?? null])).toEqual([
      ["SFX", "Music", "presence", null],
      ["Voice", "Music", "level", "rms"],
      ["Voice", "Ambience", "level", "peak"],
    ]);
  });

  for (const [index, rule] of SOUND_LAB_AUDIO.ducking.entries()) {
    it(`rule ${index} (${rule.trigger} ducks ${rule.target}, ${rule.mode}${rule.detector ? ` ${rule.detector} ${rule.threshold} dBFS` : ""}): audible, the duck falls to ${rule.amount} and releases`, { timeout: 120_000 }, async (ctx) => {
      const r = await liveRig(MIXER_SCENE);
      if (!r) return ctx.skip();
      const bus = mixer.bus(rule.target);
      r.play(rule.target, "toneA.wav");
      await r.step(60);
      expect(bus.duckGain, `${rule.target} is not ducked before the trigger`).toBe(1);
      const trigger = r.play(rule.trigger, "toneB.wav");
      // The duck lane's own series, one reading per main-thread frame (4 quanta of the audio clock): it never rises while
      // the trigger holds, and it settles on the rule's amount.
      const series: number[] = [];
      for (let f = 0; f < 400; f++) {
        await r.step(1);
        series.push(bus.duckGain);
      }
      for (let i = 1; i < series.length; i++) expect(series[i]!, `frame ${i}: the duck only falls while the trigger plays`).toBeLessThanOrEqual(series[i - 1]! + 1e-6);
      expect(Math.min(...series), "the duck fell").toBeLessThan(0.99);
      expect(series.at(-1)!, "settled on the rule's amount").toBeCloseTo(rule.amount, 1);
      trigger!.stop();
      await r.step(700);
      expect(bus.duckGain, "released after the trigger stops").toBeCloseTo(1, 2);
      console.info(`[DSd] rule ${index} (${rule.trigger} -> ${rule.target}, ${rule.mode}): settled ${series.at(-1)!.toFixed(3)} (amount ${rule.amount}), released to ${bus.duckGain.toFixed(3)}`);
    });
  }

  type RigOf = NonNullable<Awaited<ReturnType<typeof liveRig>>>;
  type Edit = [string, (r: RigOf) => void];
  const edits: Edit[] = [
    ["Music volume 0.6 -> 0.3", () => mixer.apply({ op: "setBus", bus: "Music", key: "volume", value: 0.3 })],
    ["Voice volume 1 -> 0.5", () => mixer.apply({ op: "setBus", bus: "Voice", key: "volume", value: 0.5 })],
    ["Voice high-pass 100 -> 300 Hz", () => mixer.apply({ op: "setEffect", bus: "Voice", index: 0, key: "frequency", value: 300 })],
    ["Ambience reverb send 0.5 -> 0.2", () => mixer.apply({ op: "setEffect", bus: "Ambience", index: 0, key: "send", value: 0.2 })],
    ["Voice -> Music amount 0.35 -> 0.2", () => mixer.apply({ op: "setDucking", index: 1, rule: { ...SOUND_LAB_AUDIO.ducking[1]!, amount: 0.2 } as never })],
    ["Voice -> Music threshold -30 -> -16 dBFS (over the voice, so the duck releases)", () => mixer.apply({ op: "setDucking", index: 1, rule: { ...SOUND_LAB_AUDIO.ducking[1]!, amount: 0.2, threshold: -16 } as never })],
    ["SFX tone starts (the presence duck engages)", (r) => void r.play("SFX", "toneB.wav")],
    ["Voice -> Ambience detector peak -> rms", () => mixer.apply({ op: "setDucking", index: 2, rule: { ...SOUND_LAB_AUDIO.ducking[2]!, detector: "rms" } as never })],
    ["Underwater snapshot (script, 0.3 s)", () => mixer.snapshot("Underwater", 0.3)],
    ["snapshot off (script, 0.3 s)", () => mixer.clearSnapshot(0.3)],
    ["SFX muted", () => mixer.apply({ op: "setBus", bus: "SFX", key: "mute", value: true })],
  ];
  /** Main-thread frames (4 quanta each) between edits: every ramp, dip and duck follower settles inside it. */
  const SPACING = 150;
  /** F-40's bound for this check: the signal's own largest step before and after the edit, plus 1 %. */
  const BOUND = 1.01;
  /**
   * Two kinds of edit change what the mix is made of, not only its gain, so the signal before and after the edit is not the
   * signal inside it, and `maxStep` on the full mix is too coarse to bound them by 1 %: the snapshots sweep low-passes (Music to
   * 500 Hz, SFX 1500, Ambience 900), and while a cut-off moves the partials of the tones shift in relative phase, so their sum
   * can step beyond its stationary peak though nothing clicks; and a new voice (the SFX tone) sounds at full level for the
   * duck's attack before the presence duck pulls Music down, a sum larger than either the quiet before or the ducked after.
   * Those are held to S4's `abrupt` (the largest step of the difference from the same session without the edit, over its
   * peak; a smooth change reads at or under 0.23) instead of the 1 % bound; every other edit meets both.
   */
  const ABRUPT_ONLY = new Set(["Underwater snapshot (script, 0.3 s)", "snapshot off (script, 0.3 s)", "SFX tone starts (the presence duck engages)"]);

  /**
   * One session on the Mixer scene (the voice playing, so both level rules hold their ducks; an edit starts the SFX tone) with
   * the first `limit` edits; `ctrl` replaces edit `at` after `pre` extra single quanta (the edit's phase against the tones).
   */
  async function session(limit = edits.length, ctrl?: { at: number; pre?: number; run: (r: RigOf) => void }) {
    const r = (await liveRig(MIXER_SCENE))!;
    r.play("Music", "toneA.wav");
    r.play("Ambience", "toneB.wav");
    r.play("Voice", "toneA.wav");
    const out: number[] = [...(await r.step(SPACING)).out];
    const at: number[] = [];
    for (let e = 0; e < edits.length; e++) {
      if (ctrl && ctrl.at === e && ctrl.pre) out.push(...(await r.quanta(ctrl.pre)));
      at.push(out.length);
      if (ctrl && ctrl.at === e) ctrl.run(r);
      else if (e < limit) edits[e]![1](r);
      out.push(...(await r.step(SPACING)).out);
    }
    r.backend.dispose();
    await closeRigs();
    return { x: Float32Array.from(out), at };
  }

  it("a live session of edits on the Mixer scene's buses and rules: maxStep stays within the signal's own, +1 %", { timeout: 300_000 }, async (ctx) => {
    const probe = await liveRig(MIXER_SCENE);
    if (!probe) return ctx.skip();
    probe.backend.dispose();
    await closeRigs();
    // The session with the first n edits, for n = 0..all: edit e is measured against run e (the same session without it).
    const runs = [];
    for (let n = 0; n <= edits.length; n++) runs.push(await session(n));
    const { x, at } = runs[edits.length]!;
    const settle = 4096;
    let worst = 0;
    let worstAbrupt = 0;
    for (let e = 0; e < edits.length; e++) {
      const [name] = edits[e]!;
      const from = at[e]!;
      const to = e + 1 < at.length ? at[e + 1]! : x.length;
      const before = maxStep(x, from - settle, from);
      const after = maxStep(x, to - settle, to);
      const inside = maxStep(x, from - 1, to);
      const ratio = inside / Math.max(before, after);
      const m = abrupt(runs[e]!.x, runs[e + 1]!.x, from);
      expect(m.pre).toBe(true);
      console.info(`[DSd] Mixer scene: ${name}: maxStep ratio ${ratio.toFixed(4)} (${inside.toExponential(3)} against ${before.toExponential(3)} before, ${after.toExponential(3)} after), abrupt ${m.abrupt.toFixed(3)} (difference peak ${m.peak.toFixed(4)})`);
      expect(m.abrupt, `${name}: abrupt`).toBeLessThanOrEqual(SMOOTH);
      worstAbrupt = Math.max(worstAbrupt, m.abrupt);
      if (ABRUPT_ONLY.has(name)) continue;
      worst = Math.max(worst, ratio);
      expect(inside, `${name}: maxStep ${inside} against ${before} before, ${after} after`).toBeLessThanOrEqual(Math.max(before, after) * BOUND);
    }
    console.info(`[DSd] Mixer scene: ${edits.length} live edits; worst maxStep ratio ${worst.toFixed(4)} (bound ${BOUND}; the ${ABRUPT_ONLY.size} edits that change the mix's makeup are held to abrupt), worst abrupt ${worstAbrupt.toFixed(3)} (bound ${SMOOTH})`);
  });

  it("the control: the output cut by a literal step in place of the first edit is caught by maxStep (the phases of 8 positions against the tones)", { timeout: 300_000 }, async (ctx) => {
    const probe = await liveRig(MIXER_SCENE);
    if (!probe) return ctx.skip();
    probe.backend.dispose();
    await closeRigs();
    const settle = 4096;
    let strongest = 0;
    for (let k = 0; k < 8; k++) {
      const control = await session(0, { at: 0, pre: k, run: (r) => r.backend.writer.busRampFrames(BUS_MASTER_OUT, LANE_RUNTIME, BUS_RAMP_MASK_GAIN, 0, BUS_LP_OFF_HZ, 1) });
      const from = control.at[0]!;
      const own = maxStep(control.x, from - settle, from);
      const inside = maxStep(control.x, from - 1, from + 4096);
      strongest = Math.max(strongest, inside / own);
      console.info(`[DSd] control (phase ${k}): the cut steps ${inside.toExponential(3)} against the signal's own ${own.toExponential(3)} (ratio ${(inside / own).toFixed(2)})`);
    }
    // A literal cut steps by the mix's sample value at that instant, so a phase near a zero crossing steps little (phase 3 reads 0.83x): the detector
    // is shown by the phases where the value is large.
    console.info(`[DSd] control: the strongest phase reads ${strongest.toFixed(2)}x the signal's own largest step`);
    expect(strongest, "the detector fires on a literal step at some phase").toBeGreaterThan(2);
  });
});
