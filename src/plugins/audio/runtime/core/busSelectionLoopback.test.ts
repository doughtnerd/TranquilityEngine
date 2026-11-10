// ADR 0158 §3 (M2 F3) on the real wasm (the loopback host): voice selection's bus factor includes each bus's automated
// gain (and its ancestors'), with the same no-gap rule as a voice's own automation (E4.5): while a global parameter
// driving a bus binding seeks, the larger of the automated gain at the target and at main's smoothed estimate, so a
// bus automated down to silence keeps its voices mixed (and audible) until the fade ends instead of cutting at once
// (the audio gap of m2-decisions entry 18).
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { mixer as globalMixer } from "../../../../engine/audio/mixer";
import { setAudioBackend } from "../backend";
import { Audio } from "../index";
import { events } from "../events/eventRuntime";
import { _resetHandleWarningsForTests } from "./handle";
import { fakeDecoder, type PlanarClip } from "./fakeDecoder";
import { createClipRegistry } from "./clipRegistry";
import type { AudioHost, CoreLink } from "./context";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";

const RATE = 48_000;
const QUANTUM = 128;
const FRAME_QUANTA = 4;
const FRAME_SECONDS = (FRAME_QUANTA * QUANTUM) / RATE;
const QUANTUM_MS = (QUANTUM / RATE) * 1000;
const SILENT = 1e-3;
const F = "myco.audioevent@1";
const decode = fakeDecoder(async (): Promise<PlanarClip> => ({ frames: 96_000, channels: 1, sampleRate: RATE, channelData: [new Float32Array(96_000).fill(0.25)] }));
const fetchBytes = async () => new ArrayBuffer(16);

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
  events()._reset();
  setAudioBackend(null);
  vi.restoreAllMocks();
});

async function rig(maxMixed: number) {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({
    "s.json": { format: "myco.scene@1", nodes: [] },
    "long.wav": "data:,",
    "plain.audioevent.json": { format: F, root: { type: "clip", clip: "long.wav", loop: true } },
  }));
  const engine = await Engine.create({
    headless: true,
    project: {
      audio: {
        buses: [{ name: "Master" }, { name: "Loud", parent: "Master" }, { name: "Quiet", parent: "Master" }, { name: "Sub", parent: "Quiet" }],
        seed: 7,
        parameters: [{ name: "Level", min: 0, max: 1, default: 1, seekSpeed: 5 }],
        automation: [{ bus: "Quiet", parameter: "Level", target: "volume", curve: [[0, 0], [1, 1]] }],
      },
    },
  });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  _resetHandleWarningsForTests();
  const testing = await import("../testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>> & { link: CoreLink };
  try {
    loop = (await testing.createLoopbackHost({ preset: { ...testing.LOOPBACK_PRESET, maxMixed, limiterLookaheadMs: 0 } })) as typeof loop;
  } catch {
    return null;
  }
  const link = loop.link;
  const clips = createClipRegistry({ send: (m) => link.post(m), nextSeq: () => link.nextSeq(), fetchBytes, decodeWorker: decode, nextFrame: (cb) => cb(), nextQuantum: (cb) => cb() });
  const host: CoreBackendHost = { link, status: "running", preset: { maxLogical: 64, maxMixed }, worldCount: 1, sampleRate: RATE, addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"] };
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer: globalMixer });
  closers.push(() => backend.dispose());
  events()._reset();
  setAudioBackend(backend);
  /** One frame of 4 quanta; returns each quantum's RMS (left). */
  const frame = async (): Promise<number[]> => {
    globalMixer.update(FRAME_SECONDS);
    backend.update(FRAME_SECONDS);
    events().update(FRAME_SECONDS);
    const out = loop.renderQuanta(FRAME_QUANTA);
    for (let k = 0; k < 4; k++) await Promise.resolve();
    const rms: number[] = [];
    for (let q = 0; q < FRAME_QUANTA; q++) {
      let s = 0;
      for (let k = q * QUANTUM; k < (q + 1) * QUANTUM; k++) s += out.left[k]! ** 2;
      rms.push(Math.sqrt(s / QUANTUM));
    }
    return rms;
  };
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) await frame();
  };
  return { backend, frame, step };
}

const stateOf = (bus: string) => Audio.debug().voices.filter((v) => v.bus === bus).map((v) => v.state);

describe("voice selection includes bus automation (M2 F3, loopback)", () => {
  it("under a full budget, voices on a bus automated low (or below one) lose to a loud bus", { timeout: 30_000 }, async (ctx) => {
    const r = await rig(2);
    if (!r) return ctx.skip();
    Audio.play("plain.audioevent.json", { bus: "Quiet" });
    Audio.play("plain.audioevent.json", { bus: "Sub" });
    Audio.play("plain.audioevent.json", { bus: "Loud" });
    Audio.play("plain.audioevent.json", { bus: "Loud" });
    await r.step(4);
    Audio.setParameter("Level", 0.1);
    await r.step(40); // the 0.2 s seek is over
    expect(Audio.bus("Quiet").effectiveGain).toBeCloseTo(0.1, 5);
    expect(stateOf("Loud")).toEqual(["playing", "playing"]);
    expect(stateOf("Quiet").every((s) => s !== "playing")).toBe(true);
    expect(stateOf("Sub").every((s) => s !== "playing")).toBe(true); // the ancestor's automation counts too
    // Back up: all four are equally loud again; the cap still holds two.
    Audio.setParameter("Level", 1);
    await r.step(40);
    expect(Audio.debug().voices.filter((v) => v.state === "playing").length).toBe(2);
  });

  it("a bus automated down to silence stays mixed and audible until the fade ends; up again, mixed when it begins", { timeout: 30_000 }, async (ctx) => {
    const r = await rig(4);
    if (!r) return ctx.skip();
    Audio.play("plain.audioevent.json", { bus: "Sub" });
    await r.step(6);
    expect(stateOf("Sub")).toEqual(["playing"]);
    // Down: Level 1 -> 0 at 5/s is 0.2 s; the bus gain follows it 1 -> 0.
    Audio.setParameter("Level", 0);
    let silentRun = 0;
    let worstSilentMs = 0;
    let audibleChecked = 0;
    for (let f = 0; f < 24; f++) {
      const rms = await r.frame();
      const gain = Audio.bus("Quiet").effectiveGain;
      if (f < 12) expect(stateOf("Sub")).toEqual(["playing"]); // well before the fade's end (about 19 frames)
      for (const v of rms) {
        silentRun = v < SILENT && gain > 0.03 ? silentRun + 1 : 0;
        worstSilentMs = Math.max(worstSilentMs, silentRun * QUANTUM_MS);
        if (gain > 0.1) {
          expect(v).toBeGreaterThan(SILENT);
          audibleChecked++;
        }
      }
    }
    expect(audibleChecked).toBeGreaterThan(20);
    expect(worstSilentMs).toBeLessThanOrEqual(10);
    // Settled at silence: now it is demoted.
    await r.step(10);
    expect(Audio.bus("Quiet").effectiveGain).toBe(0);
    expect(stateOf("Sub").every((s) => s !== "playing")).toBe(true);
    // Up again: mixed when the fade begins.
    Audio.setParameter("Level", 1);
    await r.frame();
    expect(stateOf("Sub")).toEqual(["playing"]);
    let heard = false;
    for (let f = 0; f < 24; f++) for (const v of await r.frame()) if (v > SILENT) heard = true;
    expect(heard).toBe(true);
    expect(Audio.bus("Quiet").effectiveGain).toBeCloseTo(1, 5);
  });

  it("leaves the bus factor alone while nothing seeks", { timeout: 30_000 }, async (ctx) => {
    const r = await rig(4);
    if (!r) return ctx.skip();
    Audio.play("plain.audioevent.json", { bus: "Sub" });
    await r.step(6);
    const before = Array.from(r.backend.selection.busGain);
    await r.step(10);
    expect(Array.from(r.backend.selection.busGain)).toEqual(before);
  });
});
