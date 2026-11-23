// ADR 0347, 0162: a moving emitter of a spatial test scene is heard with its Doppler shift, on the real core wasm and the
// core backend (the loopback host), driven by `engine.step` as the Studio's Engine drives its World each animation
// frame. The emitter plays a 500 Hz sine and flies a straight route past the listener at 20 m/s; the rendered output's
// frequency, measured from its zero crossings, is c / (c - L v cos) on approach and c / (c + L v cos) on recession, with
// L the doppler level (the source's 1 times the project's `doppler.amount`, or a playlist's `spatial.doppler`). A
// looping route's wrap (a jump from its end back to its start) gives no pitch spike, and a route that doesn't loop stops
// at its end and its pitch goes back to the clip's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine } from "../../../../myco";
import { parseAudioTestScene } from "../../../../engine/audio/spatial/testScene";
import { AUDIO_SCENE_FORMAT, type AudioTestScene } from "../../../../engine/audio/spatial/testSceneTypes";
import { mixer as globalMixer, setAudioBackend } from "../backend";
import { presetFromSettings } from "../core/context";
import { pla, sample } from "../playlists/testKit";
import { closeLoopbackAudio, endAudioSession, loopbackAudio, type LoopbackAudio } from "../testing";
import { playAudioTestScene, type AudioTestScenePlayer } from "./player";

const RATE = 48_000;
const TONE_HZ = 500;
const QUANTA_PER_FRAME = 6;
/** One animation frame: 6 render quanta (16 ms). */
const DT = (QUANTA_PER_FRAME * 128) / RATE;
const C = 343;
const SPEED = 20;
/** The listener stands this far off the route (the route runs along x at z = 0). */
const OFFSET = 4;

let engine: Engine | null = null;
let player: AudioTestScenePlayer | null = null;

beforeEach(() => {
  setAudioBackend(null);
  endAudioSession();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  player?.dispose();
  player = null;
  await closeLoopbackAudio();
  if (engine) engine.world.render = undefined as never;
  engine?.dispose();
  engine = null;
  Assets.clearSources();
  setAudioBackend(null);
  endAudioSession();
  vi.restoreAllMocks();
});

/** A scene with the listener at (0, 0, -OFFSET) facing +z and one moving emitter on `route` (y 0) playing `sound`. */
function flyby(route: { x: number; z: number }[], loop: boolean, sound = "tone.wav", start = 0): AudioTestScene {
  return parseAudioTestScene({
    format: AUDIO_SCENE_FORMAT,
    listeners: [{ id: "p1", name: "Player 1", position: { x: 0, y: 0, z: -OFFSET } }],
    activeListener: "p1",
    emitters: [{ id: "car", name: "Car", kind: "moving", route, height: 0, speed: SPEED, start, loop, sound, volume: 0 }],
  }).scene;
}

/**
 * The Studio's World and the real core on the loopback (the page's mixer, configured by the Engine from `audio`), every
 * clip a 500 Hz sine (a whole number of cycles: it loops seamlessly). Returns a stepper that records the mono sum.
 */
async function rig(audio: Record<string, unknown> = {}, assets: Record<string, unknown> = {}) {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "tone.wav": "data:audio/wav;base64,AAAA", ...assets }));
  engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }], ...audio } } });
  engine.world.render = { release() {}, warmUp: async () => {}, preloadTextures: async () => {} } as never;
  const tone = new Float32Array(RATE).map((_, i) => 0.5 * Math.sin((2 * Math.PI * TONE_HZ * i) / RATE));
  const loop: LoopbackAudio | null = await loopbackAudio({ preset: presetFromSettings(globalMixer.audioSettings), decode: () => ({ channelData: [tone] }) });
  if (!loop) return null;
  const out: number[] = [];
  /** `seconds` of animation frames: the World steps (the route mover, the audio system, Doppler), then the core renders. */
  const run = async (seconds: number) => {
    const frames = Math.round(seconds / DT);
    for (let f = 0; f < frames; f++) {
      engine!.step(DT);
      const o = loop.render(QUANTA_PER_FRAME);
      for (let i = 0; i < o.left.length; i++) out.push(o.left[i]! + o.right[i]!);
      for (let k = 0; k < 4; k++) await Promise.resolve();
    }
  };
  return { out, run };
}

/** Rising zero crossings of `x` from sample `from` to `to`, in fractional samples (linear interpolation). */
function crossings(x: readonly number[], from: number, to: number): number[] {
  const at: number[] = [];
  for (let i = Math.max(1, from); i < Math.min(to, x.length); i++) {
    const a = x[i - 1]!, b = x[i]!;
    if (a < 0 && b >= 0) at.push(i - 1 + a / (a - b));
  }
  return at;
}

/** The mean frequency over output seconds `t0`..`t1`: whole cycles between the first and last crossing. */
function frequency(x: readonly number[], t0: number, t1: number): number {
  const c = crossings(x, Math.round(t0 * RATE), Math.round(t1 * RATE));
  return ((c.length - 1) * RATE) / (c[c.length - 1]! - c[0]!);
}

/** The frequency of each cycle (between consecutive rising crossings) over `t0`..`t1`, with the time of each. */
function cycles(x: readonly number[], t0: number, t1: number): { t: number; hz: number }[] {
  const c = crossings(x, Math.round(t0 * RATE), Math.round(t1 * RATE));
  const out: { t: number; hz: number }[] = [];
  for (let i = 1; i < c.length; i++) out.push({ t: c[i]! / RATE, hz: RATE / (c[i]! - c[i - 1]!) });
  return out;
}

/** The mean cosine between the route (x) and the emitter -> listener axis while the emitter is between `x0` and `x1`. */
function meanCos(x0: number, x1: number): number {
  let s = 0;
  const n = 200;
  for (let i = 0; i < n; i++) {
    const x = x0 + ((x1 - x0) * (i + 0.5)) / n;
    s += Math.abs(x) / Math.hypot(x, OFFSET);
  }
  return s / n;
}

const approach = (level: number, cos: number) => C / (C - level * SPEED * cos);
const recession = (level: number, cos: number) => C / (C + level * SPEED * cos);

describe("a moving emitter of a test scene on the loopback core (ADR 0347, 0162)", () => {
  it("is heard higher on approach and lower on recession, by c / (c ∓ v)", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    // From x = -80 to 80 at 20 m/s: at -60..-40 from 1 to 2 s, at 40..60 from 6 to 7 s.
    player = playAudioTestScene(engine!.world, flyby([{ x: -80, z: 0 }, { x: 80, z: 0 }], false));
    await r.run(8);
    const up = frequency(r.out, 1, 2) / TONE_HZ;
    const down = frequency(r.out, 6, 7) / TONE_HZ;
    const cos = meanCos(40, 60);
    console.info(`[moving doppler] approach ${up.toFixed(5)} (expected ${approach(1, cos).toFixed(5)}), recession ${down.toFixed(5)} (expected ${recession(1, cos).toFixed(5)})`);
    expect(up).toBeCloseTo(approach(1, cos), 3);
    expect(down).toBeCloseTo(recession(1, cos), 3);
  }, 60_000);

  it("scales the shift by the project's Doppler amount", async (ctx) => {
    const r = await rig({ doppler: { amount: 0.5 } });
    if (!r) return ctx.skip();
    player = playAudioTestScene(engine!.world, flyby([{ x: -80, z: 0 }, { x: 80, z: 0 }], false));
    await r.run(8);
    const up = frequency(r.out, 1, 2) / TONE_HZ;
    const down = frequency(r.out, 6, 7) / TONE_HZ;
    const cos = meanCos(40, 60);
    console.info(`[moving doppler] amount 0.5: approach ${up.toFixed(5)} (expected ${approach(0.5, cos).toFixed(5)}), recession ${down.toFixed(5)} (expected ${recession(0.5, cos).toFixed(5)})`);
    expect(up).toBeCloseTo(approach(0.5, cos), 3);
    expect(down).toBeCloseTo(recession(0.5, cos), 3);
  }, 60_000);

  it("follows a playlist's own spatial.doppler level", async (ctx) => {
    const r = await rig({}, { "car.playlist.json": pla("clip", [sample("tone.wav")], { playback: { plays: "untilStopped" }, spatial: { doppler: 0.5 } }) });
    if (!r) return ctx.skip();
    player = playAudioTestScene(engine!.world, flyby([{ x: -80, z: 0 }, { x: 80, z: 0 }], false, "car.playlist.json"));
    await r.run(8);
    const up = frequency(r.out, 1, 2) / TONE_HZ;
    const down = frequency(r.out, 6, 7) / TONE_HZ;
    const cos = meanCos(40, 60);
    console.info(`[moving doppler] playlist level 0.5: approach ${up.toFixed(5)} (expected ${approach(0.5, cos).toFixed(5)}), recession ${down.toFixed(5)}`);
    expect(up).toBeCloseTo(approach(0.5, cos), 3);
    expect(down).toBeCloseTo(recession(0.5, cos), 3);
  }, 60_000);

  it("a looping route's wrap gives no pitch spike", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    // -30..30 at 20 m/s: a 3 s lap; the wraps (30 back to -30) at 3, 6 and 9 s.
    player = playAudioTestScene(engine!.world, flyby([{ x: -30, z: 0 }, { x: 30, z: 0 }], true));
    await r.run(10);
    const hi = approach(1, 1) * TONE_HZ, lo = recession(1, 1) * TONE_HZ;
    // Across each wrap (from just before to well after), every cycle stays between the recession's pitch and the approach's.
    for (const wrap of [3, 6, 9]) {
      const around = cycles(r.out, wrap - 0.3, wrap + 0.5);
      const top = Math.max(...around.map((c) => c.hz)), bottom = Math.min(...around.map((c) => c.hz));
      console.info(`[moving doppler] wrap at ${wrap} s: cycles ${bottom.toFixed(2)}..${top.toFixed(2)} Hz (recession ${lo.toFixed(2)}, approach ${hi.toFixed(2)})`);
      expect(top).toBeLessThan(hi * 1.002);
      expect(bottom).toBeGreaterThan(lo * 0.998);
    }
    // And the laps after a wrap are heard as the first: approaching after it, as before.
    expect(frequency(r.out, 6.5, 7.2) / TONE_HZ).toBeCloseTo(frequency(r.out, 0.5, 1.2) / TONE_HZ, 3);
  }, 60_000);

  it("a near-closed looping circuit travels its gap: no pitch spike at the wrap", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    // A 20 m square that ends 2 m short of its start, heading for the listener (south of the start): 78 m of route and a
    // 2 m gap, a 4 s lap; the wraps at 3.9 and 7.9 s. Jumped, the gap read as 125 m/s toward the listener for a frame
    // (577 Hz against the approach's 531 Hz before this was fixed).
    player = playAudioTestScene(engine!.world, flyby([{ x: 0, z: 0 }, { x: 20, z: 0 }, { x: 20, z: 20 }, { x: 0, z: 20 }, { x: 0, z: 2 }], true));
    await r.run(9);
    const hi = approach(1, 1) * TONE_HZ, lo = recession(1, 1) * TONE_HZ;
    for (const wrap of [3.9, 7.9]) {
      const around = cycles(r.out, wrap - 0.4, wrap + 0.4);
      const top = Math.max(...around.map((c) => c.hz)), bottom = Math.min(...around.map((c) => c.hz));
      console.info(`[moving doppler] circuit wrap near ${wrap} s: cycles ${bottom.toFixed(2)}..${top.toFixed(2)} Hz (recession ${lo.toFixed(2)}, approach ${hi.toFixed(2)})`);
      expect(top).toBeLessThan(hi * 1.002);
      expect(bottom).toBeGreaterThan(lo * 0.998);
    }
  }, 60_000);

  it("a listener moved while playing (the Spatial view's drag) is heard with Doppler too: (c ± v) / c", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    // A static emitter at the origin; the listener walks along x from -80, OFFSET m off it, at 20 m/s (a pose a frame).
    player = playAudioTestScene(engine!.world, parseAudioTestScene({
      format: AUDIO_SCENE_FORMAT,
      listeners: [{ id: "p1", name: "Player 1", position: { x: -80, y: 0, z: -OFFSET } }],
      activeListener: "p1",
      emitters: [{ id: "bell", name: "Bell", kind: "static", position: { x: 0, y: 0, z: 0 }, sound: "tone.wav", volume: 0 }],
    }).scene);
    let x = -80;
    for (let t = 0; t < 8; t += DT) {
      x += SPEED * DT;
      player.moveObject("p1", { position: { x, y: 0, z: -OFFSET } });
      await r.run(DT);
    }
    const up = frequency(r.out, 1, 2) / TONE_HZ;
    const down = frequency(r.out, 6, 7) / TONE_HZ;
    const cos = meanCos(40, 60);
    const towards = (C + SPEED * cos) / C, away = (C - SPEED * cos) / C;
    console.info(`[moving doppler] listener moving: approach ${up.toFixed(5)} (expected ${towards.toFixed(5)}), recession ${down.toFixed(5)} (expected ${away.toFixed(5)})`);
    expect(up).toBeCloseTo(towards, 3);
    expect(down).toBeCloseTo(away, 3);
  }, 60_000);

  it("a route that doesn't loop stops at its end, and the pitch returns to the clip's", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    // -40..20: it arrives at x = 20 (receding) at 3 s and stays.
    player = playAudioTestScene(engine!.world, flyby([{ x: -40, z: 0 }, { x: 20, z: 0 }], false));
    await r.run(5);
    expect(frequency(r.out, 2.4, 2.9) / TONE_HZ).toBeLessThan(0.96);
    const after = frequency(r.out, 3.5, 4.9) / TONE_HZ;
    console.info(`[moving doppler] after arriving: ${after.toFixed(5)}`);
    expect(after).toBeCloseTo(1, 4);
  }, 60_000);
});
