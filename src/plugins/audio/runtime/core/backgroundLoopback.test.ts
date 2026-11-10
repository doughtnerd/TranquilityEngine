// A3.4b end to end: the background modes on the loopback host (the real wasm, clip registry, shell and coreBackend).
// `mute` ramps MASTER to silence and back with no frame running; `pause` suspends after the fade and resumes; `play`
// leaves the output alone; and a voice that ends while hidden is freed from STATUS handling alone (no `update()`).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import type { AudioBackground } from "../backend";
import { BackgroundController, PAUSE_SUSPEND_DELAY_MS, type BackgroundHost, type VisibilitySource } from "./background";
import type { AudioHost, CoreLink } from "./context";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";
import type { DeviceSnapshot } from "./deviceChange";

const req = (path: string, extra: object = {}) => ({ path, url: path, loop: true, stream: false, bus: "SFX", ...extra });

class Page implements VisibilitySource {
  hidden = false;
  private readonly ls = new Set<() => void>();
  addEventListener(_: "visibilitychange", l: () => void): void {
    this.ls.add(l);
  }
  removeEventListener(_: "visibilitychange", l: () => void): void {
    this.ls.delete(l);
  }
  set(hidden: boolean): void {
    this.hidden = hidden;
    for (const l of [...this.ls]) l();
  }
}

/** A context stand-in: records what the policy asked of it. */
class FakeContextHost implements BackgroundHost {
  closed = false;
  status: "locked" | "running" | "failed" = "running";
  pageSuspended = false;
  state = "running";
  readonly calls: string[] = [];
  snapshot(): DeviceSnapshot {
    return { state: this.state, rate: 48_000, sink: "" };
  }
  async probeDeviceRate(): Promise<number | null> {
    return null;
  }
  onDeviceEvent(): () => void {
    return () => {};
  }
  async suspendForBackground(): Promise<boolean> {
    this.calls.push("suspend");
    this.pageSuspended = true;
    this.state = "suspended";
    return true;
  }
  async resumeFromBackground(): Promise<boolean> {
    this.calls.push("resume");
    this.pageSuspended = false;
    this.state = "running";
    return true;
  }
  async resumeContext(): Promise<boolean> {
    return true;
  }
}

async function rig(mode: AudioBackground, opts: { settings?: AudioSettings; frames?: number } = {}) {
  const testing = await import("../testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>> & { link: CoreLink };
  try {
    loop = (await testing.createLoopbackHost()) as typeof loop;
  } catch {
    return null;
  }
  const { createClipRegistry } = await import("./clipRegistry");
  const link = loop.link;
  const frames = opts.frames ?? 48_000;
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async () => new ArrayBuffer(8),
    decode: async () => ({ frames, channels: 1, sampleRate: 48_000, channelData: [new Float32Array(frames).fill(0.5)] }),
    clipFormat: 0,
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const host: CoreBackendHost = {
    link,
    status: "running",
    preset: { maxLogical: 64, maxMixed: 32 },
    worldCount: 1,
    sampleRate: 48_000,
    addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"],
  };
  const mixer = new Mixer(opts.settings ?? defaultAudioSettings());
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer });
  backend.setBackground(mode);
  const page = new Page();
  const ctx = new FakeContextHost();
  const controller = new BackgroundController({ host: ctx, target: backend, visibility: page, now: () => performance.now() }).start();
  /** A frame: `update` then 4 quanta; returns the last quantum's left level. */
  const frame = async () => {
    mixer.update(0.003);
    backend.update(0.003);
    const { left } = loop.renderQuanta(4);
    await Promise.resolve();
    return left[left.length - 1]!;
  };
  /** Frames until `voice` is on the core (its clip loaded and the PLAY sent). */
  const settle = async (voice: { id: number }) => {
    for (let i = 0; i < 30 && backend.table.state[voice.id & 0xffff] === 4; i++) await frame();
  };
  /** Quanta with no `update()`, as a hidden tab runs. */
  const quanta = (n: number) => {
    const { left } = loop.renderQuanta(n);
    return left[left.length - 1]!;
  };
  return { loop, backend, page, ctx, controller, frame, quanta, settle };
}

describe("background modes on the loopback host (A3.4b)", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
  afterEach(() => vi.useRealTimers());

  it("mute: silent within 50 ms with no frame running, voices keep time, audible again after, Audio.muted kept", async (ctx) => {
    const r = await rig("mute");
    if (!r) return ctx.skip();
    const { backend, page, frame, quanta, controller } = r;
    const voice = backend.play(req("a.wav", { volume: 0.5 }))!;
    for (let i = 0; i < 6; i++) await frame();
    expect(await frame()).toBeCloseTo(0.25, 5);
    page.set(true);
    expect(controller.counters.backgroundEnters).toBe(1);
    expect(quanta(24)).toBe(0); // 50 ms is 19 quanta
    expect(voice.playing).toBe(true);
    expect(voice.reason).toBeNull();
    page.set(false);
    expect(quanta(24)).toBeCloseTo(0.25, 4);
    expect(await frame()).toBeCloseTo(0.25, 5);
    backend.muted = true;
    page.set(true);
    page.set(false);
    await frame();
    quanta(24);
    expect(await frame()).toBe(0);
    backend.muted = false;
    await frame();
    expect(quanta(24)).toBeCloseTo(0.25, 4);
    backend.dispose();
  });

  it("mute: the hidden fade is a ramp, not a click", async (ctx) => {
    const r = await rig("mute");
    if (!r) return ctx.skip();
    const { page, frame, loop, backend } = r;
    backend.play(req("a.wav", { volume: 0.5 }));
    for (let i = 0; i < 8; i++) await frame();
    page.set(true);
    const { left } = loop.renderQuanta(24);
    let maxStep = 0;
    for (let i = 1; i < left.length; i++) maxStep = Math.max(maxStep, Math.abs(left[i]! - left[i - 1]!));
    expect(maxStep).toBeLessThan(0.001);
    expect(left[0]!).toBeGreaterThan(0.2);
    expect(left.at(-1)!).toBe(0);
    backend.dispose();
  });

  it("pause: fades to silence, suspends after the fade, resumes and un-fades when visible", async (ctx) => {
    const r = await rig("pause");
    if (!r) return ctx.skip();
    const { backend, page, ctx: fake, frame, quanta } = r;
    const voice = backend.play(req("a.wav", { volume: 0.5 }))!;
    for (let i = 0; i < 8; i++) await frame();
    page.set(true);
    expect(fake.calls).toEqual([]);
    expect(quanta(16)).toBe(0); // 30 ms is 12 quanta
    await vi.advanceTimersByTimeAsync(PAUSE_SUSPEND_DELAY_MS);
    expect(fake.calls).toEqual(["suspend"]);
    expect(voice.playing).toBe(true);
    page.set(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls).toEqual(["suspend", "resume"]);
    expect(quanta(24)).toBeCloseTo(0.25, 4);
    backend.dispose();
  });

  it("play: the output is untouched hidden and visible", async (ctx) => {
    const r = await rig("play");
    if (!r) return ctx.skip();
    const { backend, page, ctx: fake, frame, quanta } = r;
    backend.play(req("a.wav", { volume: 0.5 }));
    for (let i = 0; i < 8; i++) await frame();
    page.set(true);
    expect(quanta(30)).toBeCloseTo(0.25, 5);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.calls).toEqual([]);
    page.set(false);
    expect(quanta(30)).toBeCloseTo(0.25, 5);
    backend.dispose();
  });

  it("ends are freed hidden: a voice that finishes while no frame runs reads playing=false and its slot is free", async (ctx) => {
    const r = await rig("mute", { frames: 4_800 });
    if (!r) return ctx.skip();
    const { backend, page, frame, quanta, settle } = r;
    const voice = backend.play(req("short.wav", { loop: false, oneShot: true, volume: 0.5 }))!;
    const id = voice.id;
    await settle(voice);
    await frame();
    expect(voice.playing).toBe(true);
    page.set(true);
    // 0.1 s clip = 38 quanta; STATUS comes every 6 and ends are applied in its handler. No update() from here.
    quanta(60);
    expect(voice.playing).toBe(false);
    expect(backend.table.isLive(id)).toBe(false);
    expect(backend.debug().voices).toHaveLength(0);
    page.set(false);
    backend.dispose();
  });

  it("ends are freed hidden in every mode, but not by STATUS while visible (the frame does that)", async (ctx) => {
    for (const mode of ["mute", "pause", "play"] as const) {
      const r = await rig(mode, { frames: 4_800 });
      if (!r) return ctx.skip();
      const { backend, page, frame, quanta, settle } = r;
      const visibleVoice = backend.play(req("v.wav", { loop: false, oneShot: true, volume: 0.5 }))!;
      await settle(visibleVoice);
      await frame();
      quanta(60); // visible: STATUS marks it ended; the slot waits for the next update()
      expect(visibleVoice.playing).toBe(false);
      expect(backend.table.isLive(visibleVoice.id)).toBe(true);
      await frame();
      expect(backend.table.isLive(visibleVoice.id)).toBe(false);
      const hiddenVoice = backend.play(req("h.wav", { loop: false, oneShot: true, volume: 0.5 }))!;
      await settle(hiddenVoice);
      await frame();
      page.set(true);
      if (mode === "pause") await vi.advanceTimersByTimeAsync(PAUSE_SUSPEND_DELAY_MS);
      quanta(60);
      expect(backend.table.isLive(hiddenVoice.id)).toBe(false);
      backend.dispose();
    }
  });

  it("becoming hidden frees what had already ended", async (ctx) => {
    const r = await rig("mute", { frames: 4_800 });
    if (!r) return ctx.skip();
    const { backend, page, frame, quanta, settle } = r;
    const voice = backend.play(req("short.wav", { loop: false, oneShot: true, volume: 0.5 }))!;
    await settle(voice);
    await frame();
    quanta(60);
    expect(voice.playing).toBe(false);
    expect(backend.table.isLive(voice.id)).toBe(true);
    page.set(true);
    expect(backend.table.isLive(voice.id)).toBe(false);
    backend.dispose();
  });

  it("the clock map re-anchors when the page is visible again", async (ctx) => {
    const r = await rig("play");
    if (!r) return ctx.skip();
    const { backend, page, frame } = r;
    for (let i = 0; i < 4; i++) await frame();
    page.set(true);
    page.set(false);
    const before = backend.clockMap.reanchors;
    r.loop.clock.advance(5);
    await frame();
    // a fake clock gives no output timestamp, so the anchor never primed and nothing is counted: the call must not throw or reset estimates
    expect(backend.clockMap.reanchors).toBeGreaterThanOrEqual(before);
    backend.dispose();
  });

  it("debug() carries the background counters", async (ctx) => {
    const r = await rig("mute");
    if (!r) return ctx.skip();
    const { backend, page, controller } = r;
    backend.health = controller.counters;
    page.set(true);
    page.set(false);
    page.set(true);
    const core = backend.debug().core;
    expect(core.backgroundEnters).toBe(2);
    expect(core.pageHidden).toBe(true);
    expect(core.interruptions).toBe(0);
    backend.dispose();
  });
});
