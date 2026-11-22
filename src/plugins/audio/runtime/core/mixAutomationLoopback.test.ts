// ADR 0330 / 0331 (ABI 4.8) on the real wasm (the loopback host, the page's mixer and the playlist runtime binding the
// mix's automation): every mixer automation target runs in the core, keyed on its parameter's smoothed value as the
// volume lanes are. A parameter that seeks (its `seekSpeed`) is heard moving an EQ band and a send part-way through its
// seek, and main never re-sends the bus chain or the sends for it (on the old main-thread path the value jumped to the
// target at once and went out as BUS_SLOT and BUS_SENDS). A snapshot fades linearly in dB (its midpoint level in dB is
// half its offset), and an instance submix's low-pass automation opens above its authored cutoff.
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import { AUDIO_PROJECT_FORMAT } from "../../../../engine/audio/project/types";
import type { Effect } from "../../../../engine/audio/effects/types";
import { log2Curve } from "../../../../engine/audio/project/fxAutomation";
import { FadeLaw, Op, readBusAutomate, readBusRamp, shapeLaw, AUTO_TARGET_FX, AUTO_TARGET_KIND_MASK, AUTO_TARGET_SEND, LANE_SNAPSHOT } from "../wire.generated";
import { presetFromSettings } from "./context";
import { Audio } from "../index";
import { closeLoopbackAudio, loopbackAudio } from "../testing";

const LEVEL = 0.25;
const CLIP_FRAMES = 96_000;
const SEND_DB = -6;
const SEND = Math.pow(10, SEND_DB / 20);
const req = (bus: string) => ({ path: "const.wav", url: "const.wav", loop: true, stream: false, bus });
const db = (g: number) => 20 * Math.log10(g);

afterEach(async () => {
  await closeLoopbackAudio();
  vi.restoreAllMocks();
});

/**
 * `audio.json`'s mix: SFX runs a flat EQ and sends into "Echo" (a fully wet delay, no feedback); "tone" moves the EQ's
 * low band 0 → -12 dB and "wet" the send 0 → -12 dB, each seeking at one unit a second; `extra` adds keys.
 */
function mix(extra: Record<string, unknown> = {}) {
  return {
    format: AUDIO_PROJECT_FORMAT,
    parameters: [
      { name: "tone", min: 0, max: 1, default: 0, seekSpeed: 1 },
      { name: "wet", min: 0, max: 1, default: 0, seekSpeed: 1 },
    ],
    buses: [
      { name: "Master" },
      { name: "SFX", parent: "Master", effects: [{ id: "fx1", type: "eq", params: { low: 0, mid: 0, high: 0 } }], sends: [{ to: "Echo", levelDb: SEND_DB }] },
      { name: "Music", parent: "Master" },
    ],
    returns: [{ name: "Echo", output: "Master", volumeDb: 0, effects: [{ id: "fx1", type: "delay", on: true, params: { time: 20, feedback: 0, mix: 100 } }] }],
    automation: [
      { on: "SFX", target: "fx:fx1:low", parameter: "tone", curve: [[0, 0], [1, -12]] },
      { on: "SFX", target: "send:Echo", parameter: "wet", curve: [[0, 0], [1, -12]] },
    ],
    ...extra,
  };
}

/** The real host and core backend on the loopback, on the page's mixer configured from `audio.json`'s mix, a constant clip. */
async function rig(m: Record<string, unknown> = mix()) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const settings: AudioSettings = { ...defaultAudioSettings(), mix: m };
  const audio = await loopbackAudio({
    settings,
    preset: { ...presetFromSettings(settings), limiterLookaheadMs: 0 },
    decode: () => ({ channelData: [new Float32Array(CLIP_FRAMES).fill(LEVEL)] }),
    recovery: { now: () => 0, warn: () => {} },
    watchFromStart: true,
    dt: 0.01,
  });
  if (!audio) return null;
  /** `n` frames (10 ms each): the left output over the clip's level. */
  const step = async (n: number) => {
    const out: number[] = [];
    for (let f = 0; f < n; f++) for (const v of (await audio.step()).left) out.push(v / LEVEL);
    return { out, last: out[out.length - 1]! };
  };
  return { audio, backend: audio.backend, mixer: audio.mixer, step, posted: audio.watched! };
}

describe("mixer automation runs in the core (ADR 0330, ABI 4.8)", () => {
  it("an EQ band's automation follows its seeking parameter in the core, with no bus chain re-sent", { timeout: 30_000 }, async (ctx) => {
    const r = await rig(mix({ buses: [{ name: "Master" }, { name: "SFX", parent: "Master", effects: [{ id: "fx1", type: "eq", params: { low: 0, mid: 0, high: 0 } }] }] , returns: [], automation: [{ on: "SFX", target: "fx:fx1:low", parameter: "tone", curve: [[0, 0], [1, -12]] }] }));
    if (!r) return ctx.skip();
    Audio.setParameter("tone", 0); // the playlist runtime binds the mix's automation on its first call
    r.backend.play(req("SFX"));
    expect((await r.step(10)).last).toBeCloseTo(1, 4); // a flat EQ: the constant clip at its level
    // The EQ went out once as the catalogue's (the core automates it by index), its binding as an fx target.
    const autos = r.posted.takeOps(Op.BUS_AUTOMATE).map((x) => readBusAutomate(x.view, x.off));
    const sfx = r.backend.buses.slotOf("SFX");
    expect(autos.filter((a) => a.voiceId === sfx).at(-1)!.bindings.map((b) => b.target & AUTO_TARGET_KIND_MASK)).toEqual([AUTO_TARGET_FX]);
    r.posted.takeOps(Op.BUS_SLOT);
    Audio.setParameter("tone", 1); // seeks there over a second
    const quarter = await r.step(25);
    // A quarter of the way: about -3 dB at DC (the low shelf's gain), well short of the target's -12 dB.
    console.info(`[mix automation] EQ low after 0.25 s of the seek: ${db(quarter.last).toFixed(2)} dB`);
    expect(db(quarter.last)).toBeGreaterThan(-4.5);
    expect(db(quarter.last)).toBeLessThan(-1.5);
    const done = await r.step(90);
    expect(db(done.last)).toBeCloseTo(-12, 1);
    expect(r.posted.takeOps(Op.BUS_SLOT)).toHaveLength(0); // the core moved it: main re-sent nothing
    r.backend.dispose();
  });

  it("a send's automation adds its dB in the core as its parameter seeks; the sends aren't re-sent", { timeout: 30_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    Audio.setParameter("wet", 0); // the playlist runtime binds the mix's automation on its first call
    r.backend.play(req("SFX"));
    expect((await r.step(10)).last).toBeCloseTo(1 + SEND, 4);
    const autos = r.posted.takeOps(Op.BUS_AUTOMATE).map((x) => readBusAutomate(x.view, x.off));
    const sfx = r.backend.buses.slotOf("SFX");
    expect(autos.filter((a) => a.voiceId === sfx).at(-1)!.bindings.map((b) => b.target & AUTO_TARGET_KIND_MASK).sort()).toEqual([AUTO_TARGET_FX, AUTO_TARGET_SEND]);
    Audio.setParameter("wet", 1);
    const half = await r.step(50);
    // Half-way through the seek: the send 6 dB down (1 + SEND·0.5); main's old path had it 12 dB down at once.
    console.info(`[mix automation] send after 0.5 s of the seek: ${(half.last - 1).toFixed(5)} (send ${SEND.toFixed(5)})`);
    expect(half.last - 1).toBeGreaterThan(SEND * Math.pow(10, -8 / 20));
    expect(half.last - 1).toBeLessThan(SEND * Math.pow(10, -4 / 20));
    const done = await r.step(80);
    expect(done.last - 1).toBeCloseTo(SEND * Math.pow(10, -12 / 20), 4);
    expect(r.posted.takeOps(Op.BUS_SENDS)).toHaveLength(0);
    r.backend.dispose();
  });

  it("a snapshot fades linearly in dB: half-way through its fade the level is half its offset in dB", { timeout: 30_000 }, async (ctx) => {
    const r = await rig(mix({ buses: [{ name: "Master" }, { name: "SFX", parent: "Master" }], returns: [], automation: [], snapshots: [{ name: "Quiet", start: { kind: "code" }, fadeInMs: 1000, fadeOutMs: 1000, buses: { SFX: -24 } }] }));
    if (!r) return ctx.skip();
    r.backend.play(req("SFX"));
    await r.step(10);
    r.posted.takeOps(Op.BUS_RAMP);
    Audio.snapshot("Quiet").start();
    const { out } = await r.step(130);
    // One snapshot-lane ramp of the dB law, for the whole fade.
    const ramps = r.posted.takeOps(Op.BUS_RAMP).map((x) => readBusRamp(x.view, x.off)).filter((x) => x.lane === LANE_SNAPSHOT);
    expect(ramps).toHaveLength(1);
    expect(shapeLaw(ramps[0]!.shape)).toBe(FadeLaw.Decibel);
    expect(ramps[0]!.frames).toBe(r.audio.sampleRate);
    const start = out.findIndex((v) => db(v) < -0.01);
    const end = out.findIndex((v) => db(v) <= -23.99);
    const mid = out.findIndex((v) => db(v) <= -12);
    console.info(`[mix automation] snapshot fade: -12 dB at ${((mid - start) / (end - start)).toFixed(4)} of the fade`);
    expect(end - start).toBeGreaterThan(0.98 * r.audio.sampleRate);
    expect((mid - start) / (end - start)).toBeCloseTo(0.5, 2); // linear in gain would cross -12 dB at 0.8
    r.backend.dispose();
  });
});

describe("instance submix parameter automation (ADR 0331, ABI 4.8)", () => {
  it("a submix's low-pass automation opens it above its authored cutoff", { timeout: 30_000 }, async (ctx) => {
    const sine = Float32Array.from({ length: 48_000 }, (_, k) => 0.25 * Math.sin((2 * Math.PI * 4000 * k) / 48_000));
    const audio = await loopbackAudio({ mixer: "own", preset: { maxLogical: 16, maxMixed: 8, limiterLookaheadMs: 0 }, decode: () => ({ channelData: [sine] }), dt: 0.003 });
    if (!audio) return ctx.skip();
    const { backend } = audio;
    const peak = async (frames: number) => {
      let p = 0;
      for (let f = 0; f < frames; f++) for (const s of (await audio.step()).left) p = Math.max(p, Math.abs(s));
      return p;
    };
    const lp = { id: "lp", type: "lowpass", on: true, params: { cutoff: 500 } } as Effect;
    expect(backend.submixes.open(3, "SFX", [lp], "test")).toBe(true);
    backend.play({ path: "s.wav", url: "s.wav", loop: true, stream: false, bus: "SFX", group: 3 });
    await peak(8);
    const closed = await peak(6);
    expect(closed).toBeLessThan(0.03); // a 4 kHz tone well under a 500 Hz low-pass
    // Its cutoff from instance 3's local parameter 0 (0 → 500 Hz, 1 → 18 kHz, in log scale).
    backend.automation.defineCurve(900, log2Curve([[0, 500], [1, 18_000]]));
    backend.automation.setParam(3, 0, 1, 0);
    backend.submixes.automate(3, [{ effect: "lp", param: 0, log: true, input: { global: false, slot: 0 }, curve: 900 }]);
    await peak(8);
    const open = await peak(6);
    console.info(`[submix automation] 4 kHz tone: ${closed.toFixed(4)} at the authored 500 Hz, ${open.toFixed(4)} opened by automation`);
    expect(open).toBeGreaterThan(0.2); // above the authored cutoff: the tone passes
    backend.automation.setParam(3, 0, 0, 0);
    await peak(8);
    expect(await peak(6)).toBeLessThan(0.03);
    backend.dispose();
  });
});
