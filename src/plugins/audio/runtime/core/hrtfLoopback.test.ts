// H3 end to end on the loopback host (the real wasm, shell, clip registry, HRIR loader with the shipped asset, and the
// core backend): the top `voices.hrtf` spatial voices get HRTF once the table is resident (`Audio.debug()` shows
// `hrtfReady` and `counters.hrtfVoices`), never more than `voices.hrtf`; `audio.spatial: "equalPower"` and
// `voices.hrtf: 0` never fetch the table; a failed fetch reads `hrtfLoadFailure` 1 and flags nothing. Also the
// 16 HRTF voices with the listener turning (the work: flagged voices and frames rendered). The wall-clock cost of an
// HRTF voice (printed, for A3.5; compare with `wu::HRTF_VOICE`) is in `hrtfCost.bench.ts`, apart from `npm test`.
import { fakeDecoder } from "./fakeDecoder";
import { afterEach, describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import { AudioHost, presetFromSettings } from "./context";
import { createCoreBackend } from "./coreBackend";
import { createHrirLoader } from "./hrir";
import { req, readAsset, rig } from "./hrtfLoopbackRig";
import { watchForTraps } from "./recovery";
import { Unlock, type UnlockContext } from "./unlock";

/** The harness's patience for a test; every assertion here is on frames rendered or on state, not on wall time. */
const PATIENCE_MS = 120_000;

const hosts: AudioHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});

describe("HRTF for the nearest voices on the loopback host (H3)", { timeout: PATIENCE_MS }, () => {
  it("a rebuild after a trap brings the HRTF voices back on HRTF (the replayed PLAY carries the panner)", async (ctx) => {
    const testing = await import("../testing");
    let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>>;
    try {
      loop = await testing.createLoopbackHost({ testHooks: true });
    } catch {
      return ctx.skip();
    }
    const context = {
      state: "running",
      sampleRate: 48_000,
      destination: {},
      resume: () => Promise.resolve(),
      close: () => Promise.resolve(),
      addEventListener() {},
      removeEventListener() {},
    };
    const node = Object.assign(new EventTarget(), { connect() {}, disconnect() {} }) as unknown as AudioWorkletNode;
    const host = AudioHost._create({
      context: context as unknown as AudioContext,
      node,
      link: loop.link,
      unlock: new Unlock({ target: new EventTarget(), context: context as unknown as UnlockContext }),
      preset: presetFromSettings(defaultAudioSettings()),
      respawn: () => loop.respawn(),
    });
    hosts.push(host);
    const { createClipRegistry } = await import("./clipRegistry");
    const link = loop.link;
    const frames = 48_000;
    const clips = createClipRegistry({
      send: (m) => link.post(m),
      nextSeq: () => link.nextSeq(),
      fetchBytes: async () => new ArrayBuffer(8),
      decodeWorker: fakeDecoder(async () => ({ frames, channels: 1, sampleRate: 48_000, channelData: [new Float32Array(frames).fill(0.1)] })),
      nextFrame: (cb) => cb(),
      nextQuantum: (cb) => cb(),
    });
    const settings = defaultAudioSettings();
    settings.voices = { ...settings.voices, hrtf: 2 };
    const mixer = new Mixer(settings);
    const hrir = createHrirLoader({ clips, sampleRate: 48_000, fetchBytes: readAsset });
    const backend = createCoreBackend(host, { clips, clock: loop.clock, mixer, hrir });
    watchForTraps(host, { now: () => 0, warn: () => {} });
    const step = async (n: number) => {
      for (let f = 0; f < n; f++) {
        mixer.update(0.003);
        backend.update(0.003);
        loop.renderQuanta(4);
        await new Promise((r) => setImmediate(r)); // a macrotask turn for the HRIR file read; no timer, no clock
      }
    };
    // Frames until the work is done (the table resident, the host rebuilt): a real millisecond between frames lets the
    // file read and the respawn get CPU on a busy machine; the frame budget is an escape hatch, not the measure.
    const until = async (done: () => boolean, what: string) => {
      for (let k = 0; k < 20_000 && !done(); k++) {
        await step(1);
        if (!done()) await new Promise((res) => setTimeout(res, 1));
      }
      if (!done()) throw new Error(`gave up waiting for ${what}`);
    };
    for (let k = 0; k < 3; k++) backend.play(req(`s${k}.wav`, -(k + 1), -1));
    await until(() => backend.debug().core.hrtfReady === true, "the HRIR table");
    await step(10);
    expect(backend.debug().counters.hrtfVoices).toBe(2);
    loop.trapNext();
    await until(() => host.health.recoveries >= 1 && loop.cores >= 2, "the rebuild after the trap");
    await until(() => backend.debug().core.hrtfReady === true, "the table on the new core");
    await step(10);
    expect(host.health.recoveries).toBe(1);
    expect(loop.cores).toBe(2);
    const d = backend.debug();
    expect(d.core.hrtfReady).toBe(true);
    expect(d.core.hrtfFlagged).toBe(2);
    expect(d.counters.hrtfVoices).toBe(2);
    backend.dispose();
  });

  it("gives HRTF to the top voices.hrtf spatial voices once the table is resident", async (ctx) => {
    const r = await rig({ hrtf: 2 });
    if (!r) return ctx.skip();
    const { backend, step, fetches, hrtfSeen } = r;
    // Four spatial voices at distances 1..4 (nearest loudest) and one non-spatial voice.
    for (let k = 0; k < 4; k++) backend.play(req(`s${k}.wav`, -(k + 1), -1));
    backend.play({ path: "flat.wav", url: "flat.wav", loop: true, stream: false, bus: "SFX" });
    await r.until(() => backend.debug().core.hrtfReady === true, "the HRIR table");
    await step(10);
    expect(fetches()).toBe(1);
    const d = backend.debug();
    expect(d.core.hrtfReady).toBe(true);
    expect(d.core.hrtfFlagged).toBe(2);
    expect(d.counters.hrtfVoices).toBe(2);
    expect(d.counters.hrtfLoadFailure).toBe(0);
    expect(Math.max(...hrtfSeen)).toBeLessThanOrEqual(2);
    // The two nearest are the flagged ones.
    const flagged = [...Array(backend.table.capacity).keys()].filter((i) => backend.hrtf.flag[i] === 1);
    expect(flagged.map((i) => backend.table.posX[i])).toEqual(expect.arrayContaining([-1, -2]));
    // Lowering the limit to 1 unflags one (the core crossfades it out over 45 ms, then frees it).
    r.mixer.audioSettings.voices.hrtf = 1;
    await step(12);
    expect(backend.debug().counters.hrtfVoices).toBe(1);
    // equalPower at run time: every voice back to equal-power.
    r.mixer.audioSettings.spatial = "equalPower";
    await step(12);
    expect(backend.debug().counters.hrtfVoices).toBe(0);
    expect(backend.debug().core.hrtfFlagged).toBe(0);
    backend.dispose();
  });

  it("a handover: main never flags past the limit; the core pans the outgoing voice for its 45 ms crossfade, then the limit (F-11)", async (ctx) => {
    const r = await rig({ hrtf: 1 });
    if (!r) return ctx.skip();
    const { backend, step, hrtfSeen } = r;
    backend.play(req("far.wav", -4, 0));
    await r.until(() => backend.debug().core.hrtfReady === true, "the HRIR table");
    await step(10);
    expect(backend.debug().counters.hrtfVoices).toBe(1);
    // A nearer voice outranks it: the far one is unflagged and the near one flagged in the same frame (unflags first).
    hrtfSeen.length = 0;
    const flagged: number[] = [];
    backend.play(req("near.wav", -1, 0));
    for (let f = 0; f < 30; f++) {
      await step(1);
      flagged.push(backend.debug().core.hrtfFlagged as number);
    }
    expect(Math.max(...flagged)).toBe(1);
    // The core: 2 while the far voice crossfades out beside the near one crossfading in, for 45 ms (17 quanta, about
    // 5 of these 4-quantum frames), then 1. The count is the panners that ran (the work-unit model's HRTF term).
    const over = hrtfSeen.filter((n) => n === 2).length;
    expect(Math.max(...hrtfSeen)).toBe(2);
    expect(over).toBeGreaterThanOrEqual(4);
    expect(over).toBeLessThanOrEqual(6);
    expect(hrtfSeen.slice(-10).every((n) => n === 1)).toBe(true);
    backend.dispose();
  });

  it('never fetches the table with "equalPower" or voices.hrtf 0', async (ctx) => {
    for (const opts of [{ spatial: "equalPower" as const }, { hrtf: 0 }]) {
      const r = await rig(opts);
      if (!r) return ctx.skip();
      r.backend.play(req("s.wav", 1, -1));
      await r.step(20);
      expect(r.fetches()).toBe(0);
      expect(r.backend.debug().counters.hrtfVoices).toBe(0);
      expect(r.backend.debug().core.hrtfReady).toBe(false);
      r.backend.dispose();
    }
  });

  it("a failed fetch reads hrtfLoadFailure 1, warns once and flags nothing", async (ctx) => {
    const r = await rig({ failFetch: true });
    if (!r) return ctx.skip();
    r.backend.play(req("s.wav", 1, -1));
    await r.until(() => r.backend.debug().counters.hrtfLoadFailure === 1, "the failed fetch to read");
    await r.step(10);
    expect(r.fetches()).toBe(1);
    const d = r.backend.debug();
    expect(d.counters.hrtfLoadFailure).toBe(1);
    expect(d.core.hrtfFlagged).toBe(0);
    expect(d.counters.hrtfVoices).toBe(0);
    expect(r.warnings).toHaveLength(1);
    r.backend.dispose();
  });

  it("16 spatial voices with the listener turning 3 degrees a frame: all 16 stay on HRTF, the frames render", async (ctx) => {
    const r = await rig({ hrtf: 16 });
    if (!r) return ctx.skip();
    for (let k = 0; k < 16; k++) r.backend.play(req(`s${k}.wav`, Math.sin(k), -Math.cos(k)));
    await r.until(() => r.backend.debug().core.hrtfReady === true, "the HRIR table");
    await r.step(10);
    expect(r.backend.debug().counters.hrtfVoices).toBe(16);
    const frames = 300;
    let peak = 0;
    for (let f = 0; f < frames; f++) {
      const a = (f * 3 * Math.PI) / 180;
      r.backend.setListener({ position: { x: 0, y: 0, z: 0 }, forward: { x: Math.sin(a), y: 0, z: -Math.cos(a) }, up: { x: 0, y: 1, z: 0 } });
      r.backend.update(0.01);
      const out = r.loop.renderQuanta(4);
      for (const s of out.left) peak = Math.max(peak, Math.abs(s));
    }
    expect(r.backend.debug().counters.hrtfVoices).toBe(16);
    expect(peak).toBeGreaterThan(0); // the HRTF voices sound
    r.backend.dispose();
  });
});
