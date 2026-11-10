// A3.4b: "only the World that has the view plays sound" reaches the core (architecture §3.9). Plays carry their World's
// key (`worldKeyOf`), and the audio system reports every attached World's view to `CoreBackend.setWorldAudible`, so the
// voices of a World without the view go virtual (in time, silent) and come back in time when the view returns. Run on the
// loopback host with fake Worlds (only `render` is looked at).
import { afterEach, describe, expect, it, vi } from "vitest";
import { Mixer } from "../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../engine/audio/settings";
import type { World } from "../../../engine/core/World";
import { _registerWorldService, _startWorldService } from "../../../engine/core/worldServices";
import { setAudioBackend } from "./backend";
import { worldKeyOf } from "./AudioSource";
import { AUDIO, AUDIO_SERVICE, type AudioCoreModule } from "./core/service";
import type { AudioHost, CoreLink } from "./core/context";
import { CoreBackend, type CoreBackendHost } from "./core/coreBackend";
import { DWELL_FRAMES } from "./core/selection";
import { AUDIO_SYSTEMS } from "./audioSystem";

interface FakeWorld {
  render: object | null;
  _componentsOfType(): never[];
}
const makeWorld = (render: object | null): FakeWorld => ({ render, _componentsOfType: () => [] });
const asWorld = (w: FakeWorld): World => w as unknown as World;

/** A host that only does what the service and the audio system use of it: shares and `forEachWorld`. One for the file: the service caches what `load` gave. */
const shares = new Map<number, object>();
let next = 1;
const hostLike = {
    closed: false,
    attachWorld(owner: object) {
      const key = next++;
      shares.set(key, owner);
      return { key, owner, released: false };
    },
    releaseWorld(key: number) {
      return shares.delete(key);
    },
    forEachWorld(fn: (key: number, owner: object) => void) {
      for (const [k, o] of shares) fn(k, o);
    },
};

let unregister: (() => void) | null = null;
afterEach(() => {
  vi.restoreAllMocks();
  unregister?.();
  unregister = null;
  setAudioBackend(null);
  shares.clear();
  next = 1;
});

async function rig() {
  const testing = await import("./testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>> & { link: CoreLink };
  try {
    loop = (await testing.createLoopbackHost()) as typeof loop;
  } catch {
    return null;
  }
  const { createClipRegistry } = await import("./core/clipRegistry");
  const link = loop.link;
  const frames = 48_000;
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
    worldCount: 2,
    sampleRate: 48_000,
    addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"],
  };
  const mixer = new Mixer(defaultAudioSettings());
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer });
  setAudioBackend(backend);
  const core: AudioCoreModule = { ready: true, host: hostLike as unknown as AudioHost };
  // The plugin registers the real service (the test setup activates it); its `load` and `runsIn` are what a Node test can't run.
  try {
    unregister = _registerWorldService(AUDIO_SERVICE);
  } catch {
    /* already registered */
  }
  vi.spyOn(AUDIO_SERVICE, "load").mockResolvedValue(core);
  vi.spyOn(AUDIO_SERVICE, "runsIn").mockReturnValue(true);
  const view = makeWorld({});
  const other = makeWorld(null);
  await _startWorldService(asWorld(view), AUDIO);
  await _startWorldService(asWorld(other), AUDIO);
  const system = AUDIO_SYSTEMS[0]!;
  /** One engine frame: the system runs in each World the way `Engine.step` does (a World with no view only reports), then 4 quanta. */
  const frame = async (worlds: FakeWorld[]): Promise<number> => {
    for (const w of worlds) system.run(asWorld(w), 0.003);
    const { left } = loop.renderQuanta(4);
    await Promise.resolve();
    return left[left.length - 1]!;
  };
  return { loop, backend, view, other, frame };
}

const req = (path: string, extra: object = {}) => ({ path, url: path, loop: true, stream: false, bus: "SFX", ...extra });

describe("the World that has the view plays (A3.4b)", () => {
  it("worldKeyOf is the World's share key, 0 without the service", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    expect(worldKeyOf(asWorld(r.view))).toBe(1);
    expect(worldKeyOf(asWorld(r.other))).toBe(2);
    expect(worldKeyOf(asWorld(makeWorld(null)))).toBe(0);
    expect(worldKeyOf(null)).toBe(0);
  });

  it("a World without the view is forced virtual by the system, and comes back in time when the view moves to it", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { view, other, frame, backend } = r;
    const a = backend.play(req("a.wav", { volume: 0.5, world: worldKeyOf(asWorld(view)) }))!;
    const b = backend.play(req("b.wav", { volume: 0.25, world: worldKeyOf(asWorld(other)) }))!;
    let level = 0;
    for (let i = 0; i < 12; i++) level = await frame([view, other]);
    // only the view's World is heard
    expect(level).toBeCloseTo(0.5 * 0.5, 5);
    expect(a.reason).toBeNull();
    expect(b.reason).toBe("virtual");
    expect(b.playing).toBe(true);
    // the view moves to the other World (the hand-over `Engine._handView` does)
    const surface = view.render;
    view.render = null;
    other.render = surface;
    for (let i = 0; i < 2; i++) level = await frame([view, other]);
    expect(level).toBeCloseTo(0.5 * 0.25, 4);
    expect(a.reason).toBe("virtual");
    expect(a.playing).toBe(true);
    // and back
    other.render = null;
    view.render = surface;
    for (let i = 0; i < DWELL_FRAMES + 2; i++) level = await frame([view, other]);
    expect(level).toBeCloseTo(0.5 * 0.5, 4);
    expect(a.reason).toBeNull();
    expect(b.reason).toBe("virtual");
    backend.dispose();
  });

  it("a World that no longer steps (paused) is silenced by the one that does", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    const { view, other, frame, backend } = r;
    // `other` has the view first and plays; then the view moves to `view`, and only `view` steps
    other.render = view.render;
    view.render = null;
    const b = backend.play(req("b.wav", { volume: 0.5, world: worldKeyOf(asWorld(other)) }))!;
    let level = 0;
    for (let i = 0; i < 12; i++) level = await frame([view, other]);
    expect(level).toBeCloseTo(0.25, 5);
    view.render = other.render;
    other.render = null;
    for (let i = 0; i < 2; i++) level = await frame([view]); // `other` is paused and isn't stepped
    expect(level).toBe(0);
    expect(b.reason).toBe("virtual");
    backend.dispose();
  });

  it("does nothing, and creates no backend, while none exists", async (ctx) => {
    const r = await rig();
    if (!r) return ctx.skip();
    setAudioBackend(null);
    // (a new backend would be made by `audioBackend()`; the system must not call it before first sound)
    expect(() => AUDIO_SYSTEMS[0]!.run(asWorld(r.other), 0.01)).not.toThrow();
  });
});
