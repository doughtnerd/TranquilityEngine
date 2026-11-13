// G7a (ADR 0171 amended by 0172; architecture §4.6, §4.7's "rule definition" row; api-and-models §2.1 ducking rule
// fields, §4.2 `BUS_DUCK`): a project's level ducking rule reaches the core and ducks its target, on the real wasm (the
// loopback host), timed on the audio clock. The trigger's tap is pre-fader, so the trigger bus is turned down to
// `SFX_VOL` (0 would make its voice virtual: nothing to detect) and its known share is taken off what is heard: a
// constant 0.5 (-6 dBFS) on the trigger is over a -30 dBFS threshold, so the target settles at `amount` while it plays
// and back at 1 once it stops; under a threshold above -6 dBFS nothing ducks. A live
// `setDucking` adding a level rule takes effect the same way.
import { fakeDecoder } from "./fakeDecoder";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, type AudioSettings, type DuckingRule } from "../../../../engine/audio/settings";
import { DUCK_FLAG_LEVEL, DUCK_FLAG_RMS } from "../wire.generated";
import { createClipRegistry } from "./clipRegistry";
import { AudioHost, presetFromSettings } from "./context";
import { createCoreBackend, type CoreBackend } from "./coreBackend";
import { watchForTraps } from "./recovery";
import { Unlock, type UnlockContext } from "./unlock";

const RATE = 48_000;
const CLIP_FRAMES = 48_000;
const LEVEL = 0.5;
/** The trigger bus's fader: heard at this share of the clip, pre-fader for the detector. */
const SFX_VOL = 0.125;
const req = (bus: string) => ({ path: "const.wav", url: "const.wav", loop: true, stream: false, bus });

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
  /** `n` frames of 4 quanta: the left output over the clip's level, less the trigger's share once it plays (the target's gain as heard). */
  let sfxShare = 0;
  const step = async (n: number) => {
    const out: number[] = [];
    for (let f = 0; f < n; f++) {
      mixer.update(0.003);
      backend.update(0.003);
      const { left } = loop.renderQuanta(4);
      for (const v of left) out.push(v / LEVEL - sfxShare);
      await settle();
    }
    return { out, last: out[out.length - 1]! };
  };
  const sfxOn = (on: boolean) => void (sfxShare = on ? SFX_VOL : 0);
  return { loop, backend, mixer, step, sfxOn };
}

const level = (amount: number, extra: Partial<DuckingRule> = {}): DuckingRule => ({ target: "Music", trigger: "SFX", mode: "level", amount, attack: 0.005, release: 0.05, ...extra });

/** Music heard, then a voice on SFX (at `SFX_VOL`; the level tap is pre-fader) for 40 frames, then stopped. */
async function duckRun(r: NonNullable<Awaited<ReturnType<typeof rig>>>) {
  const { backend, mixer, step, sfxOn } = r;
  mixer.bus("SFX").volume = SFX_VOL;
  backend.play(req("Music"));
  const before = await step(10);
  const sfx = backend.play(req("SFX"))!;
  await step(1); // the voice's first quanta (its start) are left out of `during`
  sfxOn(true);
  const during = await step(40);
  const duckGain = mixer.bus("Music").duckGain;
  sfx.stop();
  await step(1);
  sfxOn(false);
  const after = await step(80);
  return { before: before.last, during: during.last, duckGain, after: after.last, min: Math.min(...during.out) };
}

describe("level ducking reaches the core from the project (G7a)", () => {
  for (const detector of ["rms", "peak"] as const) {
    it(`a level rule (${detector}) ducks its target to amount while the trigger is over threshold, and releases`, { timeout: 30_000 }, async (ctx) => {
      const amount = 0.25;
      const r = await rig([level(amount, { detector, threshold: -30 })]);
      if (!r) return ctx.skip();
      const ducks = vi.spyOn(r.backend.writer, "busDuck");
      r.backend.presence.settingsChanged(r.mixer); // same list: nothing new goes
      expect(ducks).not.toHaveBeenCalled();
      const sent = r.backend.presence["rules"];
      expect(sent).toEqual([expect.objectContaining({ flags: DUCK_FLAG_LEVEL | (detector === "rms" ? DUCK_FLAG_RMS : 0), thresholdDb: -30, amount })]);
      const m = await duckRun(r);
      console.info(`[G7a] level ${detector}: Music before ${m.before}, during ${m.during.toFixed(5)} (duckGain ${m.duckGain.toFixed(5)}), after ${m.after.toFixed(5)}`);
      expect(m.before).toBe(1);
      expect(m.during).toBeCloseTo(amount, 4);
      expect(m.duckGain).toBeCloseTo(amount, 3);
      expect(m.after).toBeCloseTo(1, 4);
      r.backend.dispose();
    });
  }

  it("under a threshold above the trigger's level (-3 dBFS against -6) nothing ducks", { timeout: 30_000 }, async (ctx) => {
    const r = await rig([level(0.25, { detector: "peak", threshold: -3 })]);
    if (!r) return ctx.skip();
    const m = await duckRun(r);
    expect(m.min).toBeCloseTo(1, 5);
    expect(m.during).toBeCloseTo(1, 5);
    r.backend.dispose();
  });

  it("a live setDucking adding a level rule takes effect; removing it releases", { timeout: 30_000 }, async (ctx) => {
    const amount = 0.3;
    const r = await rig([]);
    if (!r) return ctx.skip();
    const { backend, mixer, step, sfxOn } = r;
    mixer.bus("SFX").volume = SFX_VOL;
    backend.play(req("Music"));
    backend.play(req("SFX"));
    await step(10);
    sfxOn(true);
    expect((await step(10)).last).toBeCloseTo(1, 5);
    expect(mixer.apply({ op: "setDucking", index: 0, insert: true, rule: level(amount) })).toEqual({ ok: true, class: "direct" });
    const on = await step(40);
    expect(on.last).toBeCloseTo(amount, 4);
    expect(mixer.apply({ op: "setDucking", index: 0, rule: null })).toEqual({ ok: true, class: "direct" });
    const off = await step(80);
    expect(off.last).toBeCloseTo(1, 4);
    backend.dispose();
  });
});
