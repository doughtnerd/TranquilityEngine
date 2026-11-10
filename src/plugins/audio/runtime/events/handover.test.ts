// ADR 0158 E3.3: PendingCoreBackend hand-over (loop, group, bindings) and the backend-switch re-send, on fakes and on the
// real CoreBackend over the loopback host (the wasm core in Node).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { mixer as globalMixer, registerCoreBackend, resetCoreFallbackState, setAudioBackend, type AudioBackend } from "../backend";
import { Audio } from "../index";
import { _resetHandleWarningsForTests } from "../core/handle";
import { createClipRegistry } from "../core/clipRegistry";
import { fakeDecoder, type PlanarClip } from "../core/fakeDecoder";
import type { AudioHost } from "../core/context";
import { CoreBackend, type CoreBackendHost } from "../core/coreBackend";
import { makeFakeBackend } from "../testing";
import { events } from "./eventRuntime";
import { TsAutomation, type AutomationSink } from "./automation";

const F = "myco.audioevent@1";
const RATE = 48_000;
const CLIP_FRAMES = 96_000;
const STEP = 3;
const ramp = Float32Array.from({ length: CLIP_FRAMES }, (_, k) => Math.floor(k / STEP) / 32767);
const frameOf = (v: number): number => Math.round(v * 32768) * STEP;
const decode = fakeDecoder(async (): Promise<PlanarClip> => ({ frames: CLIP_FRAMES, channels: 1, sampleRate: RATE, channelData: [ramp] }));

async function boot(assets: Record<string, unknown>): Promise<void> {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, "a.wav": "data:,", ...assets }));
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }, { name: "SFX", parent: "Master" }], seed: 7, backend: "core" } } });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
}

const SUSTAIN = { "e.audioevent.json": { format: F, bus: "SFX", parameters: [{ name: "Speed", min: 0, max: 1, default: 1 }], automation: [{ parameter: "Speed", target: "volume", curve: [[0, 0], [1, 1]] }], root: { type: "clip", clip: "a.wav", sustain: true, loopRegion: [0.5, 0.6] } } };

let undo: (() => void) | null = null;
beforeEach(() => {
  setAudioBackend(null);
  resetCoreFallbackState();
  events()._reset();
  _resetHandleWarningsForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  undo?.();
  undo = null;
  events()._reset();
  setAudioBackend(null);
  resetCoreFallbackState();
  vi.restoreAllMocks();
});

describe("PendingVoice", () => {
  it("records setLoop without a TsAutomation warning while the core loads, and keeps group and bindings across the hand-over", async () => {
    await boot(SUSTAIN);
    const h = Audio.play("e.audioevent.json");
    expect(h.reason).toBe("locked");
    h.release(); // setLoop(looping false) lands on the pending voice
    expect(console.warn).not.toHaveBeenCalled();

    const target = makeFakeBackend();
    const bound: number[] = [];
    const sinkLog: string[] = [];
    const sink: AutomationSink = {
      defineCurve() {}, setParam() {}, bindBus() {},
      bindVoice(v, group, bindings, base) { bound.push(v.id); sinkLog.push(`bind:g${group}:n${bindings.length}:v${base.volume}`); },
      setLoop(v, s, e, l) { sinkLog.push(`loop:${s}:${e}:${l}`); void v; },
    };
    const withSink: AudioBackend = Object.assign(Object.create(target) as AudioBackend, { automation: sink });
    undo = registerCoreBackend(() => withSink);
    expect(target.plays).toHaveLength(1);
    expect(target.plays[0]!.group).toBeGreaterThan(0);
    const group = target.plays[0]!.group!;
    events().update(1 / 60); // the runtime notices the new backend and re-sends
    // Resolved by the voice's id on the new backend; group, bindings and the released loop arrive once each.
    expect(bound).toEqual([target.voices[0]!.id]);
    expect(sinkLog).toEqual([`bind:g${group}:n1:v1`, "loop:0.5:0.6:false"]);
    // Base volume/pitch were put back before binding, once.
    expect(target.voices[0]!.events.filter((e) => e.kind === "volume")).toHaveLength(2); // the request's, then the base reset
    void TsAutomation;
  });

  it("hands the recorded loop on to a voice that takes setLoop itself (once from the hand-over, then the re-send repeats the same state)", async () => {
    await boot({ "e.audioevent.json": { format: F, root: { type: "clip", clip: "a.wav", sustain: true, loopRegion: [0.5, 1.5] } } });
    const h = Audio.play("e.audioevent.json");
    h.release();
    const target = makeFakeBackend();
    undo = registerCoreBackend(() => target);
    const loops = () => target.voices[0]!.events.filter((e) => e.kind === "loop");
    expect(loops()).toEqual([{ kind: "loop", start: 0.5, end: 1.5, looping: false }]);
    events().update(1 / 60);
    // Same state again (a state set, not a delta); nothing else moved.
    expect(new Set(loops().map((e) => JSON.stringify(e))).size).toBe(1);
    expect(target.voices[0]!.stopped).toBe(false);
  });
});

async function rig() {
  const testing = await import("../testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>>;
  try {
    loop = await testing.createLoopbackHost({ preset: { ...testing.LOOPBACK_PRESET, limiterLookaheadMs: 0 } });
  } catch {
    return null;
  }
  const link = loop.link;
  const clips = createClipRegistry({ send: (m) => link.post(m), nextSeq: () => link.nextSeq(), fetchBytes: async () => new ArrayBuffer(8), decodeWorker: decode, nextFrame: (cb) => cb(), nextQuantum: (cb) => cb() });
  const host: CoreBackendHost = { link, status: "running", preset: { maxLogical: 16, maxMixed: 8 }, worldCount: 1, sampleRate: RATE, addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"] };
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer: globalMixer });
  const out: number[] = [];
  const step = async (n: number, perFrame?: () => void) => {
    for (let f = 0; f < n; f++) {
      perFrame?.();
      backend.update(0.0107);
      for (const s of loop.renderQuanta(4).left) out.push(s);
      for (let k = 0; k < 4; k++) await Promise.resolve();
    }
  };
  return { backend, step, out };
}

/** Steps until the clip has loaded (decoding takes real turns of the event loop) and sound comes out. */
async function loaded(step: (n: number, f?: () => void) => Promise<void>, out: number[], tick: () => void): Promise<void> {
  await vi.waitFor(async () => {
    await step(1, tick);
    expect(out.some((s) => s !== 0)).toBe(true);
  }, { timeout: 10_000, interval: 5 });
}

describe("hand-over to the real CoreBackend (loopback host)", () => {
  it("a region loop and a release recorded while pending reach the core by the voice's id, and the group survives", { timeout: 30_000 }, async (ctx) => {
    await boot(SUSTAIN);
    const r = await rig();
    if (!r) return ctx.skip();
    const { backend, step, out } = r;
    const h = Audio.play("e.audioevent.json");
    expect(h.reason).toBe("locked");
    undo = registerCoreBackend(() => backend); // hand-over: the PLAY goes to the core with its group
    const tick = () => events().update(0.0107);
    await loaded(step, out, tick);
    expect(h.playing).toBe(true);
    expect(backend.debug().voices[0]!.event).toBeGreaterThan(0);
    expect(events().automation).toBe(backend.automation);
    await step(90); // past 0.6 s: looping 0.5..0.6, still bound to the pending voice's holder
    const inRegion = out.slice(-RATE / 4).map(frameOf);
    expect(Math.min(...inRegion)).toBeGreaterThanOrEqual(24_000);
    expect(Math.max(...inRegion)).toBeLessThan(28_800);
    h.release();
    await step(20, tick);
    expect(Math.max(...out.slice(-RATE / 4).map(frameOf))).toBeGreaterThan(28_800);
    backend.dispose();
  });

  it("a release made before the hand-over plays the tail on the core (no loop), and TsAutomation never ran", { timeout: 30_000 }, async (ctx) => {
    await boot(SUSTAIN);
    const r = await rig();
    if (!r) return ctx.skip();
    const { backend, step, out } = r;
    const evaluated = vi.spyOn(TsAutomation.prototype, "bindVoice");
    const h = Audio.play("e.audioevent.json");
    const boundWhilePending = evaluated.mock.calls.length; // the fallback evaluator bound it while waiting
    h.release();
    undo = registerCoreBackend(() => backend);
    const tick = () => events().update(0.0107);
    await loaded(step, out, tick);
    await step(80, tick); // past 0.6 s of clip
    const frames = out.map(frameOf).filter((_, k) => out[k] !== 0);
    // Released: the voice runs on past the region's end instead of wrapping inside it.
    expect(Math.max(...frames)).toBeGreaterThan(28_800);
    expect(evaluated.mock.calls.length).toBe(boundWhilePending); // nothing bound on the fallback evaluator after the hand-over
    expect(console.warn).not.toHaveBeenCalled();
    backend.dispose();
  });
});

describe("backend switch re-send", () => {
  it("a running instance re-sends its voices on the new backend: voices resolved by id, bindings once, base volume restored", async () => {
    await boot(SUSTAIN);
    const first = makeFakeBackend();
    setAudioBackend(first);
    const h = Audio.play("e.audioevent.json");
    expect(h.playing).toBe(true);
    const second = makeFakeBackend();
    const log: string[] = [];
    const sink: AutomationSink = {
      defineCurve() {}, setParam(g, slot, v) { log.push(`param:${g}:${slot}:${v}`); }, bindBus() {},
      bindVoice(_v, g, b) { log.push(`bind:${g}:${b.length}`); },
      setLoop(_v, s, e, l) { log.push(`loop:${s}:${e}:${l}`); },
    };
    setAudioBackend(Object.assign(Object.create(second) as AudioBackend, { automation: sink }));
    events().update(1 / 60);
    const g = first.plays[0]!.group!;
    expect(log).toEqual([`param:${g}:0:1`, `bind:${g}:1`, "loop:0.5:0.6:true"]);
    events().update(1 / 60);
    expect(log).toHaveLength(3); // the same backend again: nothing more
  });
});
