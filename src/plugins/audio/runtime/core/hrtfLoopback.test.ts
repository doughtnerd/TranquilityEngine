// H3 end to end on the loopback host (the real wasm, shell, clip registry, HRIR loader with the shipped asset, and the
// core backend): the top `voices.hrtf` spatial voices get HRTF once the table is resident (`Audio.debug()` shows
// `hrtfReady` and `counters.hrtfVoices`), never more than `voices.hrtf`; `audio.spatial: "equalPower"` and
// `voices.hrtf: 0` never fetch the table; a failed fetch reads `hrtfLoadFailure` 1 and flags nothing. Also the
// per-voice cost of HRTF in the real wasm (printed, for A3.5; compare with `wu::HRTF_VOICE`).
import { fakeDecoder } from "./fakeDecoder";
import { afterEach, describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import { AudioHost, presetFromSettings, type CoreLink } from "./context";
import { CoreBackend, createCoreBackend, type CoreBackendHost } from "./coreBackend";
import { createHrirLoader } from "./hrir";
import { watchForTraps } from "./recovery";
import { Unlock, type UnlockContext } from "./unlock";

const att = { minDistance: 1, maxDistance: 100, rolloff: "inverse" as const };
const req = (path: string, x: number, z: number, extra: object = {}) => ({ path, url: path, loop: true, stream: false, bus: "SFX", attenuation: att, position: { x, y: 0, z }, ...extra });

async function readAsset(): Promise<ArrayBuffer> {
  const nodeFs = "node:fs/promises";
  const { readFile } = (await import(/* @vite-ignore */ nodeFs)) as { readFile(url: URL): Promise<Uint8Array> };
  const bytes = await readFile(new URL("../wasm/myco_hrir.bin", import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function rig(opts: { spatial?: "hrtf" | "equalPower"; hrtf?: number; failFetch?: boolean } = {}) {
  const testing = await import("../testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>> & { link: CoreLink };
  try {
    loop = (await testing.createLoopbackHost()) as typeof loop;
  } catch {
    return null;
  }
  const { createClipRegistry } = await import("./clipRegistry");
  const link = loop.link;
  const frames = 48_000;
  const tone = new Float32Array(frames).map((_, i) => 0.2 * Math.sin((2 * Math.PI * 440 * i) / 48_000));
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async () => new ArrayBuffer(8),
    decodeWorker: fakeDecoder(async () => ({ frames, channels: 1, sampleRate: 48_000, channelData: [tone] })),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  let fetches = 0;
  const warnings: string[] = [];
  const hrir = createHrirLoader({
    clips,
    sampleRate: 48_000,
    warn: (m) => warnings.push(m),
    fetchBytes: async () => {
      fetches++;
      if (opts.failFetch) throw new Error("HTTP 404");
      return readAsset();
    },
  });
  const host: CoreBackendHost = {
    link,
    status: "running",
    preset: { maxLogical: 256, maxMixed: 32 },
    worldCount: 1,
    sampleRate: 48_000,
    addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"],
  };
  const settings = defaultAudioSettings();
  settings.spatial = opts.spatial ?? "hrtf";
  settings.voices = { ...settings.voices, hrtf: opts.hrtf ?? 16 };
  const mixer = new Mixer(settings);
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer, hrir });
  const hrtfSeen: number[] = [];
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) {
      mixer.update(0.003);
      backend.update(0.003);
      loop.renderQuanta(4);
      hrtfSeen.push(backend.mirror.hrtfVoices);
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  return { loop, backend, mixer, step, fetches: () => fetches, warnings, hrtfSeen };
}

const hosts: AudioHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});

describe("HRTF for the nearest voices on the loopback host (H3)", () => {
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
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    for (let k = 0; k < 3; k++) backend.play(req(`s${k}.wav`, -(k + 1), -1));
    await step(30);
    expect(backend.debug().counters.hrtfVoices).toBe(2);
    loop.trapNext();
    await step(40);
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
    await step(40);
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
    await step(40);
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
    await r.step(20);
    expect(r.fetches()).toBe(1);
    const d = r.backend.debug();
    expect(d.counters.hrtfLoadFailure).toBe(1);
    expect(d.core.hrtfFlagged).toBe(0);
    expect(d.counters.hrtfVoices).toBe(0);
    expect(r.warnings).toHaveLength(1);
    r.backend.dispose();
  });

  it("measures the per-voice HRTF cost in the wasm", async (ctx) => {
    /** µs per quantum with 16 spatial voices; `moving` turns the listener 3° a frame (4 quanta), so kernels crossfade. */
    const time = async (hrtf: number, moving: boolean) => {
      const r = await rig({ hrtf });
      if (!r) return null;
      for (let k = 0; k < 16; k++) r.backend.play(req(`s${k}.wav`, Math.sin(k), -Math.cos(k)));
      await r.step(40);
      const flagged = r.backend.debug().counters.hrtfVoices;
      const frames = 300;
      let spent = 0;
      const blocks: number[] = [];
      for (let f = 0; f < frames; f++) {
        if (moving) {
          const a = (f * 3 * Math.PI) / 180;
          r.backend.setListener({ position: { x: 0, y: 0, z: 0 }, forward: { x: Math.sin(a), y: 0, z: -Math.cos(a) }, up: { x: 0, y: 1, z: 0 } });
          r.backend.update(0.01);
        }
        const t0 = performance.now();
        r.loop.renderQuanta(4);
        const dt = performance.now() - t0;
        spent += dt;
        blocks.push(dt);
      }
      r.backend.dispose();
      blocks.sort((a, b) => a - b);
      return { per: (spent / (frames * 4)) * 1000, flagged, p99: (blocks[Math.floor(blocks.length * 0.99)]! / 4) * 1000 };
    };
    const best = async (hrtf: number, moving: boolean) => {
      let out: { per: number; flagged: number; p99: number } | null = null;
      for (let k = 0; k < 2; k++) {
        const r = await time(hrtf, moving);
        if (r && (!out || r.per < out.per)) out = r;
      }
      return out;
    };
    const ep = await best(0, false);
    const still = await best(16, false);
    const epMoving = await best(0, true);
    const moving = await best(16, true);
    if (!ep || !still || !epMoving || !moving) return ctx.skip();
    expect(still.flagged).toBe(16);
    const perStill = (still.per - ep.per) / 16;
    const perMoving = (moving.per - epMoving.per) / 16;
    console.log(
      `[hrtf cost] wasm (loopback, with the shell): equal-power quantum ${ep.per.toFixed(1)} µs for 16 voices; per HRTF voice +${perStill.toFixed(2)} µs static, +${perMoving.toFixed(2)} µs with the listener turning (kernel crossfades); p99 of 4-quantum blocks per quantum: ${epMoving.p99.toFixed(0)} µs equal-power, ${moving.p99.toFixed(0)} µs HRTF turning`,
    );
    expect(perStill).toBeLessThan(200);
  }, 30_000);
});
