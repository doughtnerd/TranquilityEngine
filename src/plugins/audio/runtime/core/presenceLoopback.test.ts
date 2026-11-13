// ADR 0171 amended by 0172 (Dp1; architecture §4.6 R4, §4.5; api-and-models §1.1, §4.2, §4.3): presence ducking in the
// core, on the real wasm (the loopback host), timed on the audio clock. A voice on the trigger bus stamps `BUS_PRESENCE`
// at its start frame and the target's duck starts at the start of the quantum holding that frame; an explicit stop
// releases it with `release`; `Bus.duckGain` reads STATUS's `busDuck`; two rules combine by min. And Mx2's timing note:
// during a fade `Bus.volume` is the value being heard (the getter equals the core's lane at the heard frame).
import { fakeDecoder } from "./fakeDecoder";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, type AudioSettings, type DuckingRule } from "../../../../engine/audio/settings";
import { createClipRegistry } from "./clipRegistry";
import { AudioHost, presetFromSettings } from "./context";
import { createCoreBackend, type CoreBackend } from "./coreBackend";
import { watchForTraps } from "./recovery";
import { Unlock, type UnlockContext } from "./unlock";

const RATE = 48_000;
const Q = 128;
const CLIP_FRAMES = 48_000;
const LEVEL = 0.5;
const req = (bus: string, extra: object = {}) => ({ path: "const.wav", url: "const.wav", loop: true, stream: false, bus, ...extra });

const hosts: AudioHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  vi.restoreAllMocks();
});

function fakeContext() {
  const ctx = {
    state: "running",
    sampleRate: RATE,
    destination: {},
    resume: () => Promise.resolve(),
    close: () => {
      ctx.state = "closed";
      return Promise.resolve();
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return ctx;
}

/** The real host and core backend on the loopback with `ducking`, a constant 0.5 clip, output frames = core frames. */
async function rig(ducking: DuckingRule[] = []) {
  const testing = await import("../testing");
  const settings: AudioSettings = { ...defaultAudioSettings(), ducking };
  const preset = { ...presetFromSettings(settings), limiterLookaheadMs: 0 };
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>>;
  try {
    loop = await testing.createLoopbackHost({ testHooks: true, preset });
  } catch {
    return null;
  }
  const context = fakeContext();
  const node = Object.assign(new EventTarget(), { connect() {}, disconnect() {} }) as unknown as AudioWorkletNode;
  const unlock = new Unlock({ target: new EventTarget(), context: context as unknown as UnlockContext });
  const host = AudioHost._create({ context: context as unknown as AudioContext, node, link: loop.link, unlock, preset, respawn: () => loop.respawn() });
  hosts.push(host);
  const link = loop.link;
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async (path) => new TextEncoder().encode(path).buffer as ArrayBuffer,
    decodeWorker: fakeDecoder(() => ({ frames: CLIP_FRAMES, channels: 1, sampleRate: RATE, channelData: [new Float32Array(CLIP_FRAMES).fill(LEVEL)] })),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const mixer = new Mixer(settings);
  const backend: CoreBackend = createCoreBackend(host, { clips, clock: loop.clock, mixer });
  watchForTraps(host, { now: () => 0, warn: () => {} });
  const settle = async () => {
    for (let k = 0; k < 8; k++) await Promise.resolve();
  };
  /** Frames of 4 quanta: the left output from core frame `start`; per frame, the heard time and `probe()` after the update. */
  const step = async <T = undefined>(n: number, probe?: () => T) => {
    const start = loop.frame;
    const out: number[] = [];
    const probes: { time: number; value: T }[] = [];
    for (let f = 0; f < n; f++) {
      mixer.update(0.003);
      backend.update(0.003);
      if (probe) probes.push({ time: mixer.time, value: probe() });
      const { left } = loop.renderQuanta(4);
      for (const v of left) out.push(v);
      await settle();
    }
    return { start, out, probes, last: out[out.length - 1]! };
  };
  return { loop, host, backend, mixer, step };
}

const rule = (trigger: string, amount: number, attack: number, release: number): DuckingRule => ({ target: "Music", trigger, mode: "presence", amount, attack, release });

/** The core's per-quantum follower step (`duck.rs`): a 63 % one-pole time constant `t` seconds. */
const coef = (t: number) => (t > 0 ? Math.exp(-Q / (t * RATE)) : 0);

describe("presence ducking in the core (Dp1)", () => {
  it("a stamped voice start ducks from its frame's quantum; an explicit stop releases with `release`; duckGain reads STATUS", { timeout: 30_000 }, async (ctx) => {
    const [amount, attack, release] = [0.25, 0.01, 0.1];
    const r = await rig([rule("SFX", amount, attack, release)]);
    if (!r) return ctx.skip();
    const { backend, mixer, step } = r;
    mixer.bus("SFX").volume = 0; // the trigger is silent: Music alone is heard
    backend.play(req("Music"));
    await step(10);
    expect((await step(1)).last).toBe(LEVEL);
    expect(backend.presence.duckRecords).toBe(1);
    // A voice on SFX, stamped 0.05 s ahead of the heard clock.
    const writes = vi.spyOn(backend.writer, "busPresence");
    const sfx = backend.play(req("SFX", { at: backend.time + 0.05 }))!;
    // Stamped at the voice's start frame: the PLAY's own stamp (the table's start frame, cleared once the PLAY is sent).
    const plays = vi.mocked(writes).mock.calls;
    expect(plays).toHaveLength(1);
    expect(plays[0]![0]).toBe((1 << 1) | (1 << 2)); // Music and SFX
    const startFrame = plays[0]![1]!;
    expect(startFrame).toBe(backend.clockMap.frameOfTime(backend.time + 0.05));
    expect(startFrame).toBeGreaterThan(r.loop.frame);
    const run = await step(60);
    const at = (frame: number) => run.out[frame - run.start]! / LEVEL;
    const q0 = Math.floor(startFrame / Q) * Q;
    const firstChanged = run.start + run.out.findIndex((v) => v !== LEVEL);
    expect(firstChanged, "the duck starts at the start of the quantum holding the stamped frame").toBe(q0);
    // The attack: the first quantum's end at amount + (1 − amount)·coef, interpolated per sample from 1.
    const end1 = amount + (1 - amount) * coef(attack);
    expect(at(q0)).toBeCloseTo(1 + (end1 - 1) / Q, 5);
    expect(at(q0 + Q - 1)).toBeCloseTo(end1, 5);
    expect(run.last / LEVEL).toBeCloseTo(amount, 4);
    // `Bus.duckGain`: STATUS's busDuck (a block old), the held duck.
    expect(mixer.bus("Music").duckGain).toBeCloseTo(amount, 4);
    expect(mixer.bus("SFX").duckGain).toBe(1);
    // An explicit stop: BUS_PRESENCE asap with the bit cleared; the duck releases with `release`.
    writes.mockClear();
    sfx.stop();
    const rel = await step(1);
    expect(writes).toHaveBeenCalledWith(1 << 1, undefined);
    const relAt = rel.start + rel.out.findIndex((v) => v / LEVEL > amount + 1e-4);
    const more = await step(120); // settles within SETTLE (1e-5) after ~11 time constants
    const all = [...rel.out, ...more.out];
    const g = (frame: number) => all[frame - rel.start]! / LEVEL;
    // 63 % of the way back after `release` seconds (to a quantum).
    const tau = Math.round(release * RATE);
    expect(g(relAt + tau)).toBeGreaterThan(1 - (1 - amount) * Math.exp(-1) - 0.01);
    expect(g(relAt + tau)).toBeLessThan(1 - (1 - amount) * Math.exp(-1) + 0.01);
    expect(more.last).toBe(LEVEL);
    expect(mixer.bus("Music").duckGain).toBe(1);
    backend.dispose();
  });

  it("two rules on one target combine by min; main computes no presence duck on this backend", { timeout: 30_000 }, async (ctx) => {
    const r = await rig([rule("SFX", 0.5, 0.005, 0.1), rule("UI", 0.2, 0.005, 0.1)]);
    if (!r) return ctx.skip();
    const { backend, mixer, step } = r;
    mixer.bus("SFX").volume = 0;
    mixer.bus("UI").volume = 0;
    backend.play(req("Music"));
    await step(10);
    backend.play(req("SFX"));
    const one = await step(40);
    expect(one.last / LEVEL).toBeCloseTo(0.5, 4);
    expect(mixer.bus("Music").duckGain).toBeCloseTo(0.5, 4);
    backend.play(req("UI"));
    const both = await step(40);
    expect(both.last / LEVEL).toBeCloseTo(0.2, 4);
    expect(mixer.bus("Music").duckGain).toBeCloseTo(0.2, 4);
    // The mixer reads the core's duck: with no STATUS entry it would be 1, never main's own estimate.
    expect(mixer.laneGain("Music", 5)).toBeCloseTo(0.2, 4);
    backend.dispose();
  });

  it("during a fade, Bus.volume is the value heard: the getter equals the core's lane at the heard frame", { timeout: 30_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { backend, mixer, step } = r;
    backend.play(req("SFX"));
    await step(10);
    expect((await step(1)).last).toBe(LEVEL);
    const frames = 2_400;
    mixer.bus("SFX").fadeTo(0.5, frames / RATE);
    const run = await step(40, () => mixer.bus("SFX").volume);
    const end = run.start + run.out.length;
    let compared = 0;
    let moving = 0;
    for (const p of run.probes) {
      const f = Math.round(p.time * RATE);
      if (f < run.start || f >= end) continue;
      const heard = run.out[f - run.start]! / LEVEL;
      // To the ramp's exactness: a sample's step either side (the core's sample k is its (k + 1)th step).
      expect(Math.abs(p.value - heard), `heard frame ${f}`).toBeLessThanOrEqual((2 * 0.5) / frames + 1e-6);
      compared++;
      if (heard < 1 && heard > 0.5) moving++;
    }
    expect(compared).toBeGreaterThan(10);
    expect(moving, "compared while the fade moves").toBeGreaterThan(3);
    backend.dispose();
  });
});
