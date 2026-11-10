// A3.4c, the rebuild into a new AudioContext (architecture §3.7, §7 "Device or rate change" and "Worklet stall" rows).
// End to end on the loopback host: the real `AudioHost` closes its fake context and makes a new one through `recreate`,
// which the loopback serves with a new core initialised at the new rate (`LoopbackHost.recreate`: frames from 0, the
// fake clock's context clock restarted); the real `CoreBackend` carries `Audio.time`, the playheads and the clips across.
import { fakeDecoder } from "./fakeDecoder";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import { ClipFormat } from "../wire.generated";
import { createClipRegistry } from "./clipRegistry";
import { AudioHost, presetFromSettings, type ContextParts, type LinkPort } from "./context";
import { createCoreBackend, type CoreBackend } from "./coreBackend";
import { limiterLatencyFrames } from "./limiterLatency";
import { contextRebuilds, rebuildHost, STALL_ESCALATE_WINDOW_MS, STALL_REBUILD_STATUS_TIMEOUT_MS, watchForTraps, type RebuildOutcome } from "./recovery";
import { Unlock, type UnlockContext } from "./unlock";

const RATE = 48_000;
const NEW_RATE = 44_100;
/** A 1 s clip at 48 kHz whose sample k is 0.9 k / CLIP_FRAMES: the output level tells the voice's position. */
const CLIP_FRAMES = 48_000;
const ramp = (): Float32Array => {
  const a = new Float32Array(CLIP_FRAMES);
  for (let k = 0; k < CLIP_FRAMES; k++) a[k] = (0.9 * k) / CLIP_FRAMES;
  return a;
};
const req = (path: string, extra: object = {}) => ({ path, url: path, loop: true, stream: false, bus: "SFX", ...extra });

const hosts: AudioHost[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const host of hosts.splice(0)) await host.close();
  vi.restoreAllMocks();
});

/** A fake context: a state, a rate, listeners that can be counted, and `statechange` fired by close / suspend / resume. */
function fakeContext(rate: number, state = "running") {
  const listeners = new Map<string, Set<() => void>>();
  const fire = (type: string) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn();
  };
  const ctx = {
    state,
    sampleRate: rate,
    destination: {},
    resume: () => {
      ctx.state = "running";
      fire("statechange");
      return Promise.resolve();
    },
    suspend: () => {
      ctx.state = "suspended";
      fire("statechange");
      return Promise.resolve();
    },
    close: () => {
      ctx.state = "closed";
      fire("statechange");
      return Promise.resolve();
    },
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  };
  return ctx;
}
type FakeContext = ReturnType<typeof fakeContext>;

interface RigOptions {
  /** The state the next context starts in (default "running"; "suspended" for autoplay). */
  newState?: string;
}

/**
 * The real host on the loopback with `recreate`: each new context is a fake at `nextRate` and a loopback core at that
 * rate. `deadRespawns` > 0 makes that many same-context respawns give a node whose core never answers (a stuck context).
 * A context that isn't running renders nothing (its clock stands still), as in a browser.
 */
async function rig(options: RigOptions = {}) {
  const testing = await import("../testing");
  const loop = await testing.createLoopbackHost();
  const target = new EventTarget();
  const contexts: FakeContext[] = [fakeContext(RATE)];
  const control = { nextRate: NEW_RATE, deadRespawns: 0 };
  const firstNode = Object.assign(new EventTarget(), { connect() {}, disconnect() {} }) as unknown as AudioWorkletNode;
  const respawn = () => {
    if (control.deadRespawns > 0) {
      control.deadRespawns--;
      const port: LinkPort = { onmessage: null, postMessage() {} };
      return { node: { connect() {}, disconnect() {} } as unknown as AudioWorkletNode, port };
    }
    return loop.respawn();
  };
  const recreate = async (): Promise<ContextParts> => {
    const context = fakeContext(control.nextRate, options.newState ?? "running");
    contexts.push(context);
    const { node, port } = loop.recreate(control.nextRate);
    const unlock = new Unlock({ target, context: context as unknown as UnlockContext });
    return { context: context as unknown as AudioContext, node, port, unlock, respawn };
  };
  const host = AudioHost._create({
    context: contexts[0] as unknown as AudioContext,
    node: firstNode,
    link: loop.link,
    unlock: new Unlock({ target, context: contexts[0] as unknown as UnlockContext }),
    preset: presetFromSettings(defaultAudioSettings()),
    respawn,
    recreate,
  });
  hosts.push(host);
  const link = loop.link;
  const decodes: { path: string }[] = [];
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async (path) => new TextEncoder().encode(path).buffer as ArrayBuffer,
    // Every clip decodes at 48 kHz (its own rate, as the worker gives it) whatever the context's: a constant 0.5 for paths starting "c".
    decodeWorker: fakeDecoder((encoded) => {
      const path = new TextDecoder().decode(encoded);
      decodes.push({ path });
      return { frames: CLIP_FRAMES, channels: 1, sampleRate: RATE, channelData: [path.startsWith("c") ? new Float32Array(CLIP_FRAMES).fill(0.5) : ramp()] };
    }),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const mixer = new Mixer(defaultAudioSettings());
  const backend: CoreBackend = createCoreBackend(host, { clips, clock: loop.clock, mixer });
  const now = { ms: 0 };
  const warn = vi.fn();
  watchForTraps(host, { now: () => now.ms, warn });
  const settle = async () => {
    for (let k = 0; k < 8; k++) await Promise.resolve();
  };
  /** Every `Audio.time` read, one per frame, across the whole test. */
  const times: number[] = [];
  /** The rAF time of each of those frames. */
  const walls: number[] = [];
  /**
   * `n` frames of 4 quanta. Returns every rendered left sample with its absolute frame on the context that rendered it
   * and the page time (rAF ms) it was rendered at, and the last sample's.
   */
  const step = async (n: number) => {
    const out: { v: number; frame: number; wall: number; rate: number }[] = [];
    for (let f = 0; f < n; f++) {
      mixer.update(0.003);
      backend.update(0.003);
      times.push(backend.time);
      walls.push(loop.clock.rafTime());
      for (let q = 0; q < 4; q++) {
        const rate = loop.sampleRate;
        if (host.context.state !== "running") {
          loop.clock.setRunning(false);
          loop.clock.advance((128 / rate) * 1000);
          continue;
        }
        loop.clock.setRunning(true);
        const wall = loop.clock.rafTime();
        const start = loop.frame;
        const { left } = loop.renderQuanta(1);
        left.forEach((v, j) => out.push({ v, frame: start + j, wall: wall + (j / rate) * 1000, rate }));
      }
      await settle();
    }
    return { out, last: out[out.length - 1] };
  };
  /** Starts a rebuild and steps until it settles (at most `max` frames). */
  const rebuildAndWait = async (reason: Parameters<typeof rebuildHost>[1], max = 80): Promise<RebuildOutcome | null> => {
    let outcome: RebuildOutcome | null = null;
    void rebuildHost(host, reason).then((o) => (outcome = o));
    for (let k = 0; k < max && outcome === null; k++) await step(1);
    return outcome;
  };
  /** Steps until the last sample is non-zero (at most `max` frames); returns how many frames that took. */
  const untilSound = async (max = 60) => {
    for (let f = 1; f <= max; f++) {
      const { last } = await step(1);
      if (last && last.v !== 0) return f;
    }
    return -1;
  };
  return { loop, host, backend, clips, mixer, now, warn, step, rebuildAndWait, untilSound, decodes, contexts, control, times, walls, target };
}

const monotonic = (xs: readonly number[]): boolean => xs.every((x, i) => i === 0 || x >= xs[i - 1]!);

describe("the rebuild into a new context on the loopback host (A3.4c)", () => {
  it("48 -> 44.1 kHz: the voices come back at the right positions, Audio.time stays monotonic and continuous", async () => {
    const r = await rig();
    const { host, backend, step, contexts } = r;
    const music = backend.play(req("music.wav"))!;
    await step(6);
    const before = (await step(1)).last!;
    const posBefore = (before.v / 0.9) * CLIP_FRAMES;
    const ids = backend.debug().voices.map((v) => v.id);
    const k0 = r.times.length - 1;

    expect(await r.rebuildAndWait("device")).toBe("rebuilt");
    // The old context is closed, the new one is the host's, at the device's rate; the core was rebuilt in it.
    expect(contexts).toHaveLength(2);
    expect(contexts[0]!.state).toBe("closed");
    expect(host.context).toBe(contexts[1]);
    expect(host.context.sampleRate).toBe(NEW_RATE);
    expect(r.loop.cores).toBe(2);
    expect(host.health.rebuilds).toBe(1);
    expect(contextRebuilds(host)).toBe(1);
    expect(backend.debug().sampleRate).toBe(NEW_RATE);
    // The clock map and the writer follow the new rate; the limiter latency is the new rate's.
    expect(backend.clockMap.sampleRate).toBe(NEW_RATE);
    expect(backend.clockMap.outputLatencyFrames).toBe(limiterLatencyFrames(NEW_RATE, host.preset.limiterLookaheadMs));
    expect(backend.writer.sampleRate).toBe(NEW_RATE);

    expect(await r.untilSound()).toBeGreaterThan(0);
    await step(3);
    const after = (await step(1)).last!;
    expect(after.rate).toBe(NEW_RATE);
    expect(music.playing).toBe(true);
    expect(backend.debug().voices.map((v) => v.id)).toEqual(ids);
    // The voice kept time across the swap: where it is now = where it was + the page time since, at its clip's 48 kHz.
    // (Both readings come out of the limiter's delay line, 72 frames at 48 kHz and 66 at 44.1 kHz: 1.5 ms either way.)
    const expected = posBefore + ((after.wall - before.wall) / 1000) * RATE;
    const posAfter = (after.v / 0.9) * CLIP_FRAMES;
    expect(expected).toBeLessThan(CLIP_FRAMES);
    // Measured: 127 clip frames, one quantum, as A3.4a's same-context rebuild (the tracker anchors the first PLAY at the
    // asap estimate); A3.4a's tolerance.
    expect(Math.abs(posAfter - expected)).toBeLessThan(384);
    // Audio.time never went backwards, and it advanced with the page's clock across the swap: the carry is exact.
    expect(monotonic(r.times)).toBe(true);
    const k1 = r.times.length - 1;
    const drift = r.times[k1]! - r.times[k0]! - (r.walls[k1]! - r.walls[k0]!) / 1000;
    expect(Math.abs(drift)).toBeLessThan(1e-4);
    backend.dispose();
  });

  it("an `at` scheduled after the swap lands on its frame; Audio.time reads `at` when it is heard", async () => {
    const r = await rig();
    const { backend, step, host } = r;
    // Hold the tone resident so the rebuild re-sends it, then rebuild at 44.1 kHz.
    const clip = r.clips.acquire("c-tone.wav");
    backend.play(req("music.wav", { volume: 0 }));
    await step(6);
    expect(await r.rebuildAndWait("rate")).toBe("rebuilt");
    expect(host.context.sampleRate).toBe(NEW_RATE);
    await step(20);
    expect(r.clips.state(clip)).toBe("ready");
    // The clip was decoded again by the worker, which gives the file's own rate (48 kHz), not the context's.
    expect(r.decodes.filter((d) => d.path === "c-tone.wav")).toHaveLength(2);
    expect(backend.clockMap.timeOffset).toBeGreaterThan(0);
    const at = backend.time + 0.3;
    backend.play(req("c-tone.wav", { at, loop: false }));
    const D = backend.clockMap.outputLatencyFrames;
    let first = -1;
    for (let k = 0; k < 60 && first < 0; k++) {
      const { out } = await step(1);
      const hit = out.find((s) => s.v !== 0);
      if (hit) first = hit.frame;
    }
    const offset = backend.clockMap.timeOffset;
    expect(first).toBe(Math.round((at - offset) * NEW_RATE) + D);
    // Heard when Audio.time = (first - D) / sr + offset = at, to a frame.
    expect(Math.abs((first - D) / NEW_RATE + offset - at)).toBeLessThan(1 / NEW_RATE);
    expect(r.loop.statuses.at(-1)!.lateCommands).toBe(0);
    expect(monotonic(r.times)).toBe(true);
    backend.dispose();
  });

  it("a context the browser closed is rebuilt into a new one, whatever the reason; the host's listeners move to it", async () => {
    const r = await rig();
    const { host, backend, step, contexts } = r;
    backend.play(req("c-tone.wav", { volume: 0.5 }));
    await step(6);
    // The background controller listens for statechange and sinkchange on the context (plus the host's own statechange).
    expect(contexts[0]!.count("statechange")).toBe(3);
    expect(contexts[0]!.count("sinkchange")).toBe(1);
    const oldUnlock = host.unlock;
    await contexts[0]!.close();
    expect(host.status).toBe("failed");
    expect(host.contextClosed).toBe(true);
    // Even a stall (or a trap) can't rebuild in a closed context: it goes to a new one.
    expect(await r.rebuildAndWait("stall")).toBe("rebuilt");
    expect(contexts).toHaveLength(2);
    expect(host.status).toBe("running");
    expect(contextRebuilds(host)).toBe(1);
    expect(contexts[0]!.count("statechange")).toBe(0);
    expect(contexts[0]!.count("sinkchange")).toBe(0);
    expect(contexts[1]!.count("sinkchange")).toBe(1);
    // The host's, the controller's and the new unlock layer's watch.
    expect(contexts[1]!.count("statechange")).toBe(3);
    expect(host.unlock).not.toBe(oldUnlock);
    expect(await r.untilSound()).toBeGreaterThan(0);
    await step(2);
    expect((await step(1)).last!.v).toBeCloseTo(0.25, 5);
    backend.dispose();
  });

  it("a stall rebuilds in the same context first; a core that never answers there escalates to a new context", async () => {
    const r = await rig();
    const { host, backend, step, contexts, control, loop } = r;
    backend.play(req("c-tone.wav"));
    await step(6);
    // A stall with a healthy context: a new node in the same one.
    expect(await r.rebuildAndWait("stall")).toBe("rebuilt");
    expect(contexts).toHaveLength(1);
    expect(loop.cores).toBe(2);
    expect(contextRebuilds(host)).toBe(0);
    expect(await r.untilSound()).toBeGreaterThan(0);

    // Outside the escalation window, a stall whose same-context node never answers: after its shorter first-STATUS
    // wait the rebuild makes a new context (and takes a second rebuild from the limit).
    r.now.ms += STALL_ESCALATE_WINDOW_MS;
    control.deadRespawns = 1;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let outcome: RebuildOutcome | null = null;
    void rebuildHost(host, "stall").then((o) => (outcome = o));
    await step(2);
    expect(contexts).toHaveLength(1);
    expect(host.status).toBe("running"); // Recovering reads as running, even while the stuck core's start fails
    vi.advanceTimersByTime(STALL_REBUILD_STATUS_TIMEOUT_MS);
    for (let k = 0; k < 40 && outcome === null; k++) await step(1);
    vi.useRealTimers();
    expect(outcome).toBe("rebuilt");
    expect(contexts).toHaveLength(2);
    expect(contextRebuilds(host)).toBe(1);
    expect(await r.untilSound()).toBeGreaterThan(0);
    await step(2);
    expect((await step(1)).last!.v).toBeCloseTo(0.5, 5);
    backend.dispose();
  });

  it("a stall soon after a same-context stall rebuild goes straight to a new context", async () => {
    const r = await rig();
    const { host, backend, step, contexts } = r;
    backend.play(req("c-tone.wav"));
    await step(6);
    expect(await r.rebuildAndWait("stall")).toBe("rebuilt");
    expect(contexts).toHaveLength(1);
    r.now.ms += 2_000;
    expect(await r.rebuildAndWait("stall")).toBe("rebuilt");
    expect(contexts).toHaveLength(2);
    expect(contextRebuilds(host)).toBe(1);
    expect(host.health.rebuilds).toBe(2);
    backend.dispose();
  });

  it("context rebuilds count against the 3 per 60 s limit: the 4th is refused, silent \"failed\", one warning", async () => {
    const r = await rig();
    const { host, backend, step, contexts, control, warn } = r;
    const voice = backend.play(req("c-tone.wav"))!;
    await step(6);
    for (const rate of [44_100, 48_000, 96_000]) {
      control.nextRate = rate;
      r.now.ms += 1_000;
      expect(await r.rebuildAndWait("device")).toBe("rebuilt");
      expect(host.context.sampleRate).toBe(rate);
      expect(await r.untilSound()).toBeGreaterThan(0);
    }
    expect(contexts).toHaveLength(4);
    r.now.ms += 1_000;
    expect(await rebuildHost(host, "device")).toBe("limited");
    expect(host.status).toBe("failed");
    expect(voice.playing).toBe(false);
    expect(voice.reason).toBe("failed");
    expect(await rebuildHost(host, "rate")).toBe("unavailable");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(contexts).toHaveLength(4);
    backend.dispose();
  });

  it("a stall's escalation is refused by the limit too", async () => {
    const r = await rig();
    const { host, backend, step, contexts, control, warn } = r;
    backend.play(req("c-tone.wav"));
    await step(6);
    for (let k = 0; k < 2; k++) {
      r.now.ms += 1_000;
      expect(await r.rebuildAndWait("device")).toBe("rebuilt");
    }
    // The 3rd rebuild is granted, but its stuck same-context core would need a 4th to escalate.
    r.now.ms += 1_000;
    control.deadRespawns = 1;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let outcome: RebuildOutcome | null = null;
    void rebuildHost(host, "stall").then((o) => (outcome = o));
    await step(2);
    vi.advanceTimersByTime(STALL_REBUILD_STATUS_TIMEOUT_MS);
    for (let k = 0; k < 10 && outcome === null; k++) await step(1);
    vi.useRealTimers();
    expect(outcome).toBe("limited");
    expect(contexts).toHaveLength(3);
    expect(host.status).toBe("failed");
    expect(warn).toHaveBeenCalledTimes(1);
    backend.dispose();
  });

  it("a new context that starts suspended (autoplay) arms the unlock layer; plays wait as locked until the gesture", async () => {
    const r = await rig({ newState: "suspended" });
    const { host, backend, step, target, contexts } = r;
    const music = backend.play(req("c-tone.wav", { volume: 0.5 }))!;
    await step(6);
    let outcome: RebuildOutcome | null = null;
    void rebuildHost(host, "device").then((o) => (outcome = o));
    await step(4);
    expect(contexts).toHaveLength(2);
    expect(host.unlock.armed).toBe(true);
    expect(host.status).toBe("locked");
    expect(outcome).toBeNull();
    const late = backend.play(req("c-late.wav", { volume: 0.25, loop: false, oneShot: true }))!;
    expect(late.reason).toBe("locked");
    expect(music.playing).toBe(true);
    // Nothing renders while suspended, and Audio.time holds.
    const held = backend.time;
    await step(4);
    expect(backend.time).toBe(held);
    target.dispatchEvent(new Event("pointerdown"));
    for (let k = 0; k < 40 && outcome === null; k++) await step(1);
    expect(outcome).toBe("rebuilt");
    expect(host.unlock.armed).toBe(false);
    expect(await r.untilSound()).toBeGreaterThan(0);
    await step(3);
    expect(late.reason).toBeNull();
    expect((await step(1)).last!.v).toBeCloseTo(0.25 + 0.125, 5);
    expect(monotonic(r.times)).toBe(true);
    backend.dispose();
  });

  it("the page's background suspend holds on the new context (pause policy, hidden)", async () => {
    const r = await rig();
    const { host, backend, step } = r;
    backend.play(req("c-tone.wav"));
    await step(6);
    expect(await host.suspendForBackground()).toBe(true);
    expect(host.pageSuspended).toBe(true);
    // A device rebuild while hidden: the new context answers once, then is suspended again for the page.
    expect(await r.rebuildAndWait("device")).toBe("rebuilt");
    expect(host.context.state).toBe("suspended");
    expect(host.pageSuspended).toBe(true);
    expect(host.unlock.armed).toBe(false);
    expect(await host.resumeFromBackground()).toBe(true);
    expect(host.context.state).toBe("running");
    expect(await r.untilSound()).toBeGreaterThan(0);
    backend.dispose();
  });
});
