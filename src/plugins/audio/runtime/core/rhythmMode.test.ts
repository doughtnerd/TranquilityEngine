// ADR 0166 Rh1 (api-and-models §1.5, architecture §4.6): the host's half of rhythm mode on fakes. The numeric
// `latencyHint`, the latency read-back and its `reliable` rule, the mode rebuild a settings change queues (rate-limited,
// last change wins), and the `latency` rebuild reason in `recovery.ts` (a new context; never the limit's last rebuild).
// The loopback half, where the mode change really rebuilds and the music re-enters aligned, is `rhythmModeLoopback.test.ts`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import {
  AudioHost, CoreLink, DEFAULT_LATENCY_HINT, LATENCY_EVIDENCE_WINDOW_MS, latencyHintFor, MODE_REBUILD_INTERVAL_MS, MODE_REBUILD_RETRY_MS,
  presetFromSettings, RHYTHM_LATENCY_HINT, type ContextParts, type LinkPort,
} from "./context";
import { rebuildHost, watchForTraps, type RebuildableHost } from "./recovery";
import { Unlock, type UnlockContext } from "./unlock";
import type { CoreWasm } from "./loader";

const hosts: AudioHost[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const host of hosts.splice(0)) await host.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const flush = async () => {
  for (let k = 0; k < 6; k++) await Promise.resolve();
};

interface FakeCtx {
  state: string;
  sampleRate: number;
  baseLatency?: unknown;
  outputLatency?: unknown;
  getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number };
  destination: object;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
  addEventListener(): void;
  removeEventListener(): void;
}

function fakeContext(extra: Partial<FakeCtx> = {}): FakeCtx {
  const ctx: FakeCtx = {
    state: "running",
    sampleRate: 48_000,
    destination: {},
    resume: () => Promise.resolve(),
    suspend: () => Promise.resolve(),
    close: () => {
      ctx.state = "closed";
      return Promise.resolve();
    },
    addEventListener() {},
    removeEventListener() {},
    ...extra,
  };
  return ctx;
}

const fakePort = (): LinkPort => ({ postMessage() {}, onmessage: null });
const fakeNode = () => Object.assign(new EventTarget(), { connect() {}, disconnect() {} }) as unknown as AudioWorkletNode;

/** A host on fakes: `recreate` given unless `recreate: false`; the clock is `clock.now`. */
function host(options: { ctx?: FakeCtx; rhythmMode?: boolean; recreate?: boolean } = {}) {
  const clock = { now: 0 };
  const ctx = options.ctx ?? fakeContext();
  const recreate = vi.fn(async (): Promise<ContextParts> => {
    throw new Error("not in these tests");
  });
  const h = AudioHost._create({
    context: ctx as unknown as AudioContext,
    node: fakeNode(),
    link: new CoreLink(fakePort()),
    unlock: new Unlock({ target: new EventTarget(), context: ctx as unknown as UnlockContext }),
    preset: presetFromSettings(defaultAudioSettings()),
    recreate: options.recreate === false ? undefined : recreate,
    rhythmMode: options.rhythmMode,
    now: () => clock.now,
  });
  hosts.push(h);
  return { h, ctx, clock, recreate };
}

const settings = (rhythmMode: boolean): AudioSettings => ({ ...defaultAudioSettings(), rhythmMode });

describe("the latency hint (ADR 0166 §4.6)", () => {
  it("is 0 in rhythm mode and \"interactive\" otherwise", () => {
    expect(RHYTHM_LATENCY_HINT).toBe(0);
    expect(latencyHintFor(true)).toBe(0);
    expect(latencyHintFor(false)).toBe("interactive");
    expect(DEFAULT_LATENCY_HINT).toBe("interactive");
  });

  it("the host reports the mode and hint its context was made with", () => {
    expect(host().h.rhythmMode).toBe(false);
    expect(host().h.latencyHint).toBe("interactive");
    const r = host({ rhythmMode: true });
    expect(r.h.rhythmMode).toBe(true);
    expect(r.h.latencyHint).toBe(0);
    expect(r.h.pendingRhythmMode).toBeNull();
  });

  it("_startNew makes the context with latencyHint 0 in rhythm mode, \"interactive\" otherwise, and falls back when a number is refused", async () => {
    const made: unknown[] = [];
    let refuseNumbers = false;
    class FakeAudioContext {
      state = "suspended";
      sampleRate = 48_000;
      destination = {};
      audioWorklet = { addModule: () => Promise.resolve() };
      constructor(options: { latencyHint?: unknown }) {
        if (refuseNumbers && typeof options.latencyHint === "number") throw new TypeError("numeric hint");
        made.push(options.latencyHint);
      }
      addEventListener() {}
      removeEventListener() {}
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    }
    class FakeNode extends EventTarget {
      port = fakePort();
      connect() {}
      disconnect() {}
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeNode);
    const wasm = { bytes: new ArrayBuffer(8) } as unknown as CoreWasm;
    const preset = presetFromSettings(defaultAudioSettings());
    const rhythm = await AudioHost._startNew(wasm, "core.js", preset, new EventTarget(), true);
    hosts.push(rhythm);
    expect(made).toEqual([0]);
    expect(rhythm.rhythmMode).toBe(true);
    const plain = await AudioHost._startNew(wasm, "core.js", preset, new EventTarget());
    hosts.push(plain);
    expect(made).toEqual([0, "interactive"]);
    expect(plain.rhythmMode).toBe(false);
    refuseNumbers = true;
    const old = await AudioHost._startNew(wasm, "core.js", preset, new EventTarget(), true);
    hosts.push(old);
    expect(made).toEqual([0, "interactive", "interactive"]);
  });
});

describe("the latency read-back and the reliable rule (§1.3, §4.6)", () => {
  it("reads baseLatency and outputLatency; a missing, non-finite or negative figure reads 0", () => {
    const { h, ctx } = host({ ctx: fakeContext({ baseLatency: 0.0029, outputLatency: 0.008 }) });
    expect(h.latency()).toMatchObject({ base: 0.0029, output: 0.008 });
    ctx.baseLatency = Number.NaN;
    ctx.outputLatency = -1;
    expect(h.latency()).toMatchObject({ base: 0, output: 0, reliable: false });
    delete ctx.baseLatency;
    ctx.outputLatency = "0.01";
    expect(h.latency()).toMatchObject({ base: 0, output: 0 });
  });

  it("reliable with a valid getOutputTimestamp and 0 < output < 0.5", () => {
    const valid = () => ({ contextTime: 1.5, performanceTime: 1234 });
    expect(host({ ctx: fakeContext({ outputLatency: 0.032, getOutputTimestamp: valid }) }).h.latency().reliable).toBe(true);
    expect(host({ ctx: fakeContext({ outputLatency: 0.5, getOutputTimestamp: valid }) }).h.latency().reliable).toBe(false);
    expect(host({ ctx: fakeContext({ outputLatency: 0, getOutputTimestamp: valid }) }).h.latency().reliable).toBe(false);
    // A timestamp of a context that hasn't rendered (times 0) is no evidence.
    const idle = host({ ctx: fakeContext({ outputLatency: 0.032, getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }) }) });
    expect(idle.h.latency().reliable).toBe(false);
    // One that throws is none either.
    const throws = host({ ctx: fakeContext({ outputLatency: 0.032, getOutputTimestamp: () => { throw new Error("closed"); } }) });
    expect(throws.h.latency().reliable).toBe(false);
  });

  it("without a timestamp: reliable once outputLatency changed within the first 10 s; a constant value never is", () => {
    const live = host({ ctx: fakeContext({ outputLatency: 0.02 }) });
    expect(live.h.latency().reliable).toBe(false);
    live.clock.now = 4_000;
    expect(live.h.latency().reliable).toBe(false); // same value
    live.ctx.outputLatency = 0.021;
    expect(live.h.latency().reliable).toBe(true);
    live.ctx.outputLatency = 0.02;
    live.clock.now = 60_000;
    expect(live.h.latency().reliable).toBe(true); // the evidence stays
    const late = host({ ctx: fakeContext({ outputLatency: 0.02 }) });
    expect(late.h.latency().reliable).toBe(false);
    late.clock.now = LATENCY_EVIDENCE_WINDOW_MS + 1;
    late.ctx.outputLatency = 0.03;
    expect(late.h.latency().reliable).toBe(false); // a change after the window doesn't count
  });
});

describe("a change of audio.rhythmMode queues a mode rebuild (§4.6, rate-limited)", () => {
  it("nothing without a starter, or when the mode matches the context's", async () => {
    const { h } = host();
    h.reconfigure(settings(false));
    h.reconfigure(settings(true));
    await flush();
    expect(h.modeRebuilds).toBe(0);
    expect(h.pendingRhythmMode).toBe(true);
    const start = vi.fn(async () => "rebuilt");
    h.reconfigure(settings(false));
    h._setModeRebuild(start);
    await flush();
    expect(start).not.toHaveBeenCalled();
  });

  it("a waiting change starts once a starter is installed; a host that can't make a context never starts one", async () => {
    const { h } = host();
    h.reconfigure(settings(true));
    const start = vi.fn(async () => "rebuilt");
    h._setModeRebuild(start);
    expect(start).not.toHaveBeenCalled(); // a microtask later, never inside the caller
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    expect(h.modeRebuilds).toBe(1);
    const fixed = host({ recreate: false }).h;
    const never = vi.fn(async () => "rebuilt");
    fixed._setModeRebuild(never);
    fixed.reconfigure(settings(true));
    await flush();
    expect(never).not.toHaveBeenCalled();
  });

  it("toggling back before it runs builds nothing; the same setting again queues nothing more", async () => {
    const { h } = host();
    const start = vi.fn(async () => "rebuilt");
    h._setModeRebuild(start);
    h.reconfigure(settings(true));
    h.reconfigure(settings(false));
    await flush();
    expect(start).not.toHaveBeenCalled();
    h.reconfigure(settings(true));
    h.reconfigure(settings(true));
    h.reconfigure(settings(true));
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("a second change within the interval waits for its rest, and the settings then decide", async () => {
    vi.useFakeTimers();
    const r = host();
    const ctxMode = r.h as unknown as { contextRhythm: boolean; wantRhythm: boolean };
    // As a real rebuild does: the new context has the mode wanted when it was made.
    const start = vi.fn(async () => {
      ctxMode.contextRhythm = ctxMode.wantRhythm;
      return "rebuilt";
    });
    r.h._setModeRebuild(start);
    r.h.reconfigure(settings(true));
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    expect(r.h.rhythmMode).toBe(true);
    r.clock.now = 300;
    r.h.reconfigure(settings(false));
    r.h.reconfigure(settings(true));
    r.h.reconfigure(settings(false)); // the last change wins
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    r.clock.now = MODE_REBUILD_INTERVAL_MS;
    vi.advanceTimersByTime(MODE_REBUILD_INTERVAL_MS - 300 - 1);
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await flush();
    expect(start).toHaveBeenCalledTimes(2);
    expect(r.h.rhythmMode).toBe(false);
    expect(r.h.pendingRhythmMode).toBeNull();
  });

  it("a deferred rebuild is tried again later; close cancels what is queued", async () => {
    vi.useFakeTimers();
    const r = host();
    const start = vi.fn(async () => "deferred");
    r.h._setModeRebuild(start);
    r.h.reconfigure(settings(true));
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    r.clock.now = MODE_REBUILD_RETRY_MS;
    vi.advanceTimersByTime(MODE_REBUILD_RETRY_MS);
    await flush();
    expect(start).toHaveBeenCalledTimes(2);
    await r.h.close();
    r.clock.now = 2 * MODE_REBUILD_RETRY_MS;
    vi.advanceTimersByTime(MODE_REBUILD_RETRY_MS);
    await flush();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("a rebuild that kept the context (a trap already in flight) is followed by the mode rebuild after the interval", async () => {
    vi.useFakeTimers();
    const r = host();
    // `rebuildHost` hands back the trap's rebuild in flight: same context, so the mode is still due.
    const start = vi.fn(async () => "rebuilt");
    r.h._setModeRebuild(start);
    r.h._beginRebuild("trap");
    r.h.reconfigure(settings(true));
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    r.h._endRebuild();
    r.clock.now = MODE_REBUILD_INTERVAL_MS;
    vi.advanceTimersByTime(MODE_REBUILD_INTERVAL_MS);
    await flush();
    expect(start).toHaveBeenCalledTimes(2);
    expect(r.h.pendingRhythmMode).toBe(true);
  });
});

describe("the latency rebuild reason (recovery.ts)", () => {
  function fakeRebuildable() {
    let setter: (() => Promise<string>) | null = null;
    const h = {
      closed: false,
      recoveryHasFailed: false,
      health: { traps: 0, recoveries: 0, rebuilds: 0 },
      link: { onShellEvent: () => () => {}, fail() {} },
      contextClosed: false,
      canRecreate: true,
      _beginRebuild: vi.fn(),
      _replaceCore: vi.fn(async () => {}),
      _replaceContext: vi.fn(async () => {}),
      _endRebuild: vi.fn(),
      _markRecoveryFailed: vi.fn(),
      _setModeRebuild: vi.fn((fn: (() => Promise<string>) | null) => void (setter = fn)),
      get starter() {
        return setter;
      },
    };
    return h;
  }

  it("watchForTraps installs the starter (and removes it on disarm); a latency rebuild makes a new context", async () => {
    const h = fakeRebuildable();
    const disarm = watchForTraps(h as unknown as RebuildableHost, { now: () => 0, warn: () => {} });
    expect(h.starter).not.toBeNull();
    expect(await h.starter!()).toBe("rebuilt");
    expect(h._replaceContext).toHaveBeenCalledTimes(1);
    expect(h._replaceCore).not.toHaveBeenCalled();
    expect(h.health.rebuilds).toBe(1);
    disarm();
    expect(h.starter).toBeNull();
  });

  it("never spends the limit's last rebuild: deferred, and the host stays healthy", async () => {
    const h = fakeRebuildable();
    const warn = vi.fn();
    watchForTraps(h as unknown as RebuildableHost, { now: () => 0, warn });
    expect(await rebuildHost(h as unknown as RebuildableHost, "trap")).toBe("rebuilt");
    expect(await rebuildHost(h as unknown as RebuildableHost, "latency")).toBe("rebuilt");
    expect(await rebuildHost(h as unknown as RebuildableHost, "latency")).toBe("deferred");
    expect(h._markRecoveryFailed).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    // The last one is still there for a trap.
    expect(await rebuildHost(h as unknown as RebuildableHost, "trap")).toBe("rebuilt");
    expect(h._replaceContext).toHaveBeenCalledTimes(1);
  });
});
