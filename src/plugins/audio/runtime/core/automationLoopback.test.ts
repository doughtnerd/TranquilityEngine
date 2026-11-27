// ADR 0158 E3.1 end to end on the real wasm (the loopback host): an event's automation runs in the core (the runtime
// makes no `TsAutomation` on the core backend), a parameter change moves a bound voice's level within its seek time, a
// region loops and releases on the frame, a voice re-sent through a forwarding object is found by id (C6), and a hard
// rebuild mid-automation restores curves (a full 1,024-curve table), parameters, bindings and loops.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import type { Curve } from "../../../../engine/core/curve";
import { setAudioBackend, type AudioVoice } from "../backend";
import { Audio } from "../index";
import { playlistHost } from "../playlists/host";
import { AutoTarget, TsAutomation, type Binding } from "../automation";
import { CORE_CURVE_KEYS } from "./commandWriter";
import { BATCH_FLAGS_OVERFLOWED } from "../wire.generated";
import { endAudioSession, loopbackAudio, closeLoopbackAudio } from "../testing";

const RATE = 48_000;
const STEP = 3;
const CLIP_FRAMES = 96_000;
const DC = 0.5;
/** A ramp (sample k = floor(k / 3) / 32767), so the output says which clip frame is playing; and a constant. */
const ramp = Float32Array.from({ length: CLIP_FRAMES }, (_, k) => Math.floor(k / STEP) / 32767);
const dc = new Float32Array(CLIP_FRAMES).fill(DC);
/** The clip frame (to 3 frames) the output at `v` is at, for the ramp at unity gain. */
const frameOf = (v: number): number => Math.round(v * 32768) * STEP;


/** The mean absolute level of `out[from..to)`. */
function level(out: readonly number[], from: number, to: number): number {
  let s = 0;
  for (let k = from; k < to; k++) s += Math.abs(out[k]!);
  return s / Math.max(1, to - from);
}

afterEach(async () => {
  await closeLoopbackAudio();
  vi.restoreAllMocks();
});

async function loopbackRig(options: { pageMixer?: boolean } = {}) {
  // ADR 0221: the production assembly on the loopback (the page's mixer registered, or its own); no limiter look-ahead.
  const loop = await loopbackAudio({
    mixer: options.pageMixer ? "page" : "own",
    preset: { maxLogical: 16, maxMixed: 8, limiterLookaheadMs: 0 },
    decode: (path) => ({ channelData: [path.startsWith("ramp") ? ramp : dc] }),
    recovery: { now: () => 0, warn: () => {} },
  });
  if (!loop) return null;
  const { backend, host } = loop;
  const out: number[] = [];
  /** `n` frames of 4 quanta (≈ 10.7 ms each). */
  const step = async (n: number, perFrame?: () => void) => {
    for (let f = 0; f < n; f++) {
      perFrame?.();
      loop.mainFrame(0.0107);
      for (const s of loop.render(4).left) out.push(s);
      for (let k = 0; k < 4; k++) await Promise.resolve();
    }
  };
  return { backend, step, out, loop, host };
}

const vol = (slot: number, curve: number, global = false): Binding => ({ param: { global, slot }, curve, target: AutoTarget.Volume });

describe("playlist automation in the core (E3.1, loopback)", () => {
  it("runs a playlist's parameter automation in the core: no TsAutomation on main, and a parameter change reaches the level within the seek time", { timeout: 30_000 }, async (ctx) => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({
      "s.json": { format: "myco.scene@1", nodes: [] },
      "dc.wav": "data:,",
      // A gain curve in dB whose keys are the old linear curve's values at 0, 0.25 and 1 (0.25 is -12.04 dB).
      "e.playlist.json": {
        format: "myco.playlist@1", type: "layer", parameters: [{ name: "Speed", min: 0, max: 1, default: 1, seekSpeed: 10 }],
        entries: [{ embedded: { type: "clip", entries: [{ sample: "dc.wav", loop: "on" }] }, curves: { gain: { input: { parameter: "Speed" }, curve: [[0, -96], [0.25, 20 * Math.log10(0.25)], [1, 0]] } } }],
      },
    }));
    const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }, { name: "SFX", parent: "Master" }], seed: 7 } } });
    await SceneManager.load("s.json");
    engine.world.render = {} as never;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    endAudioSession();
    const r = await loopbackRig({ pageMixer: true });
    if (!r) return ctx.skip();
    const { backend, step, out } = r;
    const evaluated = vi.spyOn(TsAutomation.prototype, "update");
    const applied = vi.spyOn(TsAutomation.prototype, "bindVoice");
    try {
      const h = Audio.play("e.playlist.json");
      expect(h.playing).toBe(true);
      // The runtime's sink is the core's.
      expect(playlistHost().automation).toBe(backend.automation);
      const tick = () => playlistHost().update(0.0107);
      await vi.waitFor(async () => {
        await step(1, tick);
        expect(out.some((s) => s !== 0)).toBe(true);
      });
      await step(10, tick);
      const full = level(out, out.length - 2048, out.length);
      expect(full).toBeGreaterThan(0.1);
      // Speed 1 → 0.25 at 10 units/s: 75 ms of smoothing in the core, then the curve's 0.25.
      h.setParameter("Speed", 0.25);
      const mark = out.length;
      await step(3, tick); // ≈ 32 ms: still moving
      const moving = level(out, out.length - 256, out.length);
      expect(moving).toBeLessThan(full * 0.95);
      expect(moving).toBeGreaterThan(full * 0.3);
      await step(10, tick);
      expect(out.length - mark).toBeGreaterThan(0.075 * RATE + 2048);
      expect(level(out, out.length - 2048, out.length) / full).toBeCloseTo(0.25, 3);
      // Selection's copy, evaluated on main at the target.
      expect(backend.debug().voices[0]!.gain).toBeCloseTo(0.25, 6);
      expect(backend.debug().voices[0]!.event).toBeGreaterThan(0);
      expect(evaluated).not.toHaveBeenCalled();
      expect(applied).not.toHaveBeenCalled();
      h.stop();
    } finally {
      endAudioSession();
      setAudioBackend(null);
      engine.dispose?.();
    }
  });

  it("loops a region and releases on the frame: the voice finishes its pass and plays its tail to the end", { timeout: 30_000 }, async (ctx) => {
    const r = await loopbackRig();
    if (!r) return ctx.skip();
    const { backend, step, out } = r;
    const v = backend.play({ path: "ramp.wav", url: "", loop: true, stream: false, bus: "SFX" })!;
    // Sent before the clip is on the core: held, then sent behind its PLAY.
    backend.automation.setLoop(v, 0.5, 0.6, true);
    await step(90); // ≈ 0.96 s: past 0.6 s, looping 0.5..0.6
    const inRegion = out.slice(-RATE / 4).map(frameOf);
    expect(Math.min(...inRegion)).toBeGreaterThanOrEqual(24_000);
    expect(Math.max(...inRegion)).toBeLessThan(28_800);
    // Wraps land exactly: the frame before a wrap is the region's last.
    const tail = out.slice(-RATE / 4);
    for (let k = 1; k < tail.length; k++) {
      if (frameOf(tail[k]!) < frameOf(tail[k - 1]!)) {
        expect(frameOf(tail[k - 1]!)).toBe(28_797);
        expect(frameOf(tail[k]!)).toBe(24_000);
      }
    }
    const mark = out.length;
    backend.automation.setLoop(v, 0.5, 0.6, false);
    await step(20);
    const after = out.slice(mark).map(frameOf);
    let wraps = 0;
    let through = -1;
    for (let k = 1; k < after.length; k++) {
      if (after[k]! < after[k - 1]! - 100) wraps++;
      if (after[k - 1] === 28_797 && after[k] === 28_800 && through < 0) through = k;
    }
    expect(wraps).toBeLessThanOrEqual(1); // at most the pass already under way when the release arrived
    expect(through).toBeGreaterThan(0); // straight on past the region's end
    expect(Math.max(...after)).toBeGreaterThan(28_800 + 0.1 * RATE);
    await step(150);
    expect(v.playing).toBe(false);
    backend.dispose();
  });

  it("finds a voice re-sent through a forwarding object by its id (C6)", { timeout: 30_000 }, async (ctx) => {
    const r = await loopbackRig();
    if (!r) return ctx.skip();
    const { backend, step, out } = r;
    const a = backend.automation;
    a.defineCurve(0, [[0, 1], [1, 0.5]]);
    a.setParam(0, 0, 0, 0);
    const inner = backend.play({ path: "dc.wav", url: "", loop: true, stream: false, bus: "SFX" })!;
    await step(10);
    const full = level(out, out.length - 1024, out.length);
    expect(full).toBeGreaterThan(0.1);
    // What the runtime's `resend()` passes after the hand-over: the pending backend's object, forwarding to the core voice.
    const forwarded = { get id() { return inner.id; }, get playing() { return inner.playing; } } as unknown as AudioVoice;
    a.bindVoice(forwarded, 0, [vol(0, 0, true)], { volume: 1, pitch: 1 });
    a.setParam(0, 0, 1, 0);
    await step(4);
    expect(level(out, out.length - 1024, out.length) / full).toBeCloseTo(0.5, 3);
    backend.dispose();
  });
});

describe("a hard rebuild mid-automation (E3.1, loopback)", () => {
  it("restores a full 1,024-curve table, parameters, bindings and loops on the new core", { timeout: 30_000 }, async () => {
    const r = (await loopbackRig())!;
    const { backend, step, out, loop, host } = r;
    const posted = loop.watch();
    const a = backend.automation;
    // A full table (past the writer's 256 KB staging area): curve id k is flat at 1 except the two used below.
    const full = (y: (x: number) => number): Curve => Array.from({ length: CORE_CURVE_KEYS }, (_, k) => [k / (CORE_CURVE_KEYS - 1), y(k / (CORE_CURVE_KEYS - 1))] as const);
    for (let id = 0; id < 1024; id++) a.defineCurve(id, full(() => 1));
    a.defineCurve(1023, full((x) => x)); // gain = the local parameter
    a.defineCurve(1000, full((x) => x)); // gain = the global parameter
    a.setParam(0, 3, 0, 0); // the loop voice silent
    a.setParam(7, 2, 0.25, 0); // the constant voice at 0.25
    const steady = backend.play({ path: "dc.wav", url: "", loop: true, stream: false, bus: "SFX", group: 7 })!;
    a.bindVoice(steady, 7, [vol(2, 1023)], { volume: 1, pitch: 1 });
    const looping = backend.play({ path: "ramp.wav", url: "", loop: true, stream: false, bus: "SFX", group: 8 })!;
    a.bindVoice(looping, 8, [vol(3, 1000, true)], { volume: 1, pitch: 1 });
    a.setLoop(looping, 0.5, 0.6, true);
    // A full table of 64-key curves (ADR 0346) is ≈ 1.8 MB: about 40 frames of resync at 48 KB a frame.
    await vi.waitFor(async () => {
      await step(1);
      expect(a.counts.pending).toBe(0);
      expect(out.some((s) => s !== 0)).toBe(true);
    }, { timeout: 15_000, interval: 1 });
    await step(10);
    // Nothing was dropped: no posted batch carries the overflow flag (the curves past the staging area were carried).
    expect(posted.take().some((b) => (b.flags & BATCH_FLAGS_OVERFLOWED) !== 0)).toBe(false);
    const before = level(out, out.length - 2048, out.length);
    expect(before / DC).toBeCloseTo(0.25, 2);

    loop.trap();
    await step(2);
    expect(host.health.traps).toBe(1);
    const restartAt = out.length;
    await vi.waitFor(async () => {
      await step(1);
      expect(out.slice(restartAt).some((s) => s !== 0)).toBe(true);
    });
    await step(20);
    expect(host.health.recoveries).toBe(1);
    expect(steady.playing).toBe(true);
    expect(looping.playing).toBe(true);
    // Curves (the last id), the instance's parameter and the binding came back: still 0.25, the loop voice still silent.
    expect(level(out, out.length - 2048, out.length) / before).toBeCloseTo(1, 2);
    // Now hear the loop voice alone: its global parameter to 1, the constant's local one to 0 (bindings on the new core).
    a.setParam(7, 2, 0, 0);
    a.setParam(0, 3, 1, 0);
    await step(70); // ≈ 0.75 s: whatever pass it resumed in, it is looping 0.5..0.6 s now
    const heard = out.slice(-RATE / 4).map(frameOf);
    expect(Math.min(...heard)).toBeGreaterThanOrEqual(24_000);
    expect(Math.max(...heard)).toBeLessThan(28_800);
    backend.dispose();
  });
});
