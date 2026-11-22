// ADR 0330 (ABI 4.7) on the real wasm (the loopback host): returns are core buses fed by post-fader sends. A project from
// `audio.json` whose SFX bus sends into a return holding a delay insert (fully wet, no feedback) is heard on the return:
// with a constant clip, the output is SFX's direct share at first, then that plus the send's share once the delay has
// passed. A muted bus silences its send (`BUS_SEND_MUTED`, the level kept), a snapshot's offset on the return moves the
// return's level, a hard rebuild replays the sends, and a level ducking rule keyed by a return ducks its target.
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import { AUDIO_PROJECT_FORMAT } from "../../../../engine/audio/project/types";
import { BUS_SEND_MUTED, Op, readBusSends } from "../wire.generated";
import { presetFromSettings } from "./context";
import { closeLoopbackAudio, loopbackAudio } from "../testing";

const LEVEL = 0.25;
const CLIP_FRAMES = 48_000;
/** The send's level and its gain. */
const SEND_DB = -6;
const SEND = Math.pow(10, SEND_DB / 20);
/** The return's delay, ms: the return is silent for this long after the send starts. */
const DELAY_MS = 20;
const req = (bus: string) => ({ path: "const.wav", url: "const.wav", loop: true, stream: false, bus });

afterEach(async () => {
  await closeLoopbackAudio();
  vi.restoreAllMocks();
});

/** `audio.json`'s mix: SFX sends into the "Echo" return (a fully wet delay), Music beside it; `extra` adds keys. */
function mix(extra: Record<string, unknown> = {}) {
  return {
    format: AUDIO_PROJECT_FORMAT,
    buses: [
      { name: "Master" },
      { name: "SFX", parent: "Master", sends: [{ to: "Echo", levelDb: SEND_DB }] },
      { name: "Music", parent: "Master" },
    ],
    returns: [{ name: "Echo", output: "Master", volumeDb: 0, effects: [{ id: "fx1", type: "delay", on: true, params: { time: DELAY_MS, feedback: 0, mix: 100 } }] }],
    ...extra,
  };
}

/** The real host and core backend on the loopback, configured from `audio.json`'s mix, a constant clip. */
async function rig(m: Record<string, unknown> = mix()) {
  const settings: AudioSettings = { ...defaultAudioSettings(), mix: m };
  const audio = await loopbackAudio({
    mixer: "own",
    settings,
    preset: { ...presetFromSettings(settings), limiterLookaheadMs: 0 },
    decode: () => ({ channelData: [new Float32Array(CLIP_FRAMES).fill(LEVEL)] }),
    recovery: { now: () => 0, warn: () => {} },
    watchFromStart: true,
    dt: 0.003,
  });
  if (!audio) return null;
  /** `n` frames: the left output over the clip's level (1 = SFX's direct path at unity). */
  const step = async (n: number) => {
    const out: number[] = [];
    for (let f = 0; f < n; f++) for (const v of (await audio.step()).left) out.push(v / LEVEL);
    return { out, last: out[out.length - 1]! };
  };
  return { audio, backend: audio.backend, mixer: audio.mixer, step, posted: audio.watched! };
}

describe("returns are core buses fed by bus sends (ADR 0330, ABI 4.7)", () => {
  it("a bus's send into a return with a delay insert is heard on the return, after the delay", { timeout: 30_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    expect(r.mixer.returnNames).toEqual(["Echo"]);
    r.backend.play(req("SFX"));
    const { out, last } = await r.step(40);
    // From the voice's first sample: SFX alone for the delay's length, then its send's share through the return too.
    const onset = out.findIndex((v) => v > 0.5);
    const delay = (DELAY_MS / 1000) * r.audio.sampleRate;
    console.info(`[returns] onset at ${onset}: direct ${out[onset + 64]!.toFixed(5)}, with the return ${last.toFixed(5)} (send ${SEND.toFixed(5)})`);
    expect(onset).toBeGreaterThanOrEqual(0);
    expect(Math.max(...out.slice(onset, onset + delay - 1))).toBeCloseTo(1, 4); // the return hasn't spoken yet
    expect(out[onset + delay + 128]).toBeCloseTo(1 + SEND, 4);
    expect(last).toBeCloseTo(1 + SEND, 4);
    // What reached the core: one BUS_SENDS for SFX, into the return's slot (after the buses), at the send's level.
    const sent = r.posted.takeOps(Op.BUS_SENDS).map((x) => readBusSends(x.view, x.off));
    const sfx = r.backend.buses.slotOf("SFX"), echo = r.backend.buses.slotOf("Echo");
    expect(echo).toBe(3);
    expect(sent.filter((x) => x.voiceId === sfx).at(-1)!.sends).toEqual([expect.objectContaining({ to: echo, flags: 0, level: expect.closeTo(SEND, 6) })]);
    r.backend.dispose();
  });

  it("a muted bus silences its send (BUS_SEND_MUTED, the level kept); unmuted, the return comes back at the same level", { timeout: 30_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    r.backend.play(req("SFX"));
    expect((await r.step(30)).last).toBeCloseTo(1 + SEND, 4);
    r.posted.takeOps(Op.BUS_SENDS);
    r.mixer.bus("SFX").mute = true;
    const muted = await r.step(30);
    expect(muted.last).toBeCloseTo(0, 5); // the direct path and the return's tail are both gone
    const sends = r.posted.takeOps(Op.BUS_SENDS).map((x) => readBusSends(x.view, x.off).sends);
    expect(sends.at(-1)).toEqual([expect.objectContaining({ flags: BUS_SEND_MUTED, level: expect.closeTo(SEND, 6) })]);
    r.mixer.bus("SFX").mute = false;
    expect((await r.step(30)).last).toBeCloseTo(1 + SEND, 4);
    expect(r.posted.takeOps(Op.BUS_SENDS).map((x) => readBusSends(x.view, x.off).sends).at(-1)).toEqual([expect.objectContaining({ flags: 0, level: expect.closeTo(SEND, 6) })]);
    r.backend.dispose();
  });

  it("a snapshot's level offset on the return moves the return's level", { timeout: 30_000 }, async (ctx) => {
    const r = await rig(mix({ snapshots: [{ name: "Dry", start: { kind: "code" }, fadeInMs: 0, fadeOutMs: 0, buses: { Echo: -6 } }] }));
    if (!r) return ctx.skip();
    r.backend.play(req("SFX"));
    expect((await r.step(30)).last).toBeCloseTo(1 + SEND, 4);
    r.mixer.snapshot("Dry", 0);
    const dry = await r.step(30);
    expect(dry.last).toBeCloseTo(1 + SEND * Math.pow(10, -6 / 20), 4);
    expect(r.mixer.bus("Echo").effectiveGain).toBeCloseTo(Math.pow(10, -6 / 20), 6);
    r.backend.dispose();
  });

  it("a script's volume on a return is the return's own lane", { timeout: 30_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    r.backend.play(req("SFX"));
    await r.step(30);
    r.mixer.bus("Echo").volume = 0.5;
    expect((await r.step(30)).last).toBeCloseTo(1 + SEND * 0.5, 4);
    r.backend.dispose();
  });

  it("a hard rebuild replays the sends after the tree", { timeout: 30_000 }, async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    r.backend.play(req("SFX"));
    expect((await r.step(30)).last).toBeCloseTo(1 + SEND, 4);
    r.audio.trap();
    let resumed = false;
    for (let f = 0; f < 60 && !resumed; f++) resumed = (await r.step(1)).last !== 0;
    expect(resumed, "sound again on the new core").toBe(true);
    expect(r.audio.host.health.recoveries).toBe(1);
    expect((await r.step(30)).last).toBeCloseTo(1 + SEND, 4);
    r.backend.dispose();
  });

  it("a level ducking rule keyed by a return ducks its target while the return carries sound", { timeout: 30_000 }, async (ctx) => {
    const amountDb = -12;
    const r = await rig(mix({ ducking: [{ target: "Music", trigger: "Echo", mode: "level", detector: "peak", thresholdDb: -30, amountDb, attackMs: 5, releaseMs: 50 }] }));
    if (!r) return ctx.skip();
    r.backend.play(req("Music"));
    await r.step(10);
    expect(r.mixer.bus("Music").duckGain).toBeCloseTo(1, 5);
    const sfx = r.backend.play(req("SFX"))!;
    await r.step(40);
    expect(r.mixer.bus("Music").duckGain).toBeCloseTo(Math.pow(10, amountDb / 20), 3);
    sfx.stop();
    await r.step(80);
    expect(r.mixer.bus("Music").duckGain).toBeCloseTo(1, 3);
    r.backend.dispose();
  });
});
