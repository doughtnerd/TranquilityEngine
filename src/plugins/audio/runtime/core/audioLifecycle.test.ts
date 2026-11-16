import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../../../../engine/index";
import { mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import type { World } from "../../../../engine/core/World";
import { AudioHost, CoreLink, acquireAudioHost, currentAudioHost, presetFromSettings } from "./context";
import { busRemap } from "./busRemap";
import { AUDIO_SERVICE, AudioWorldService } from "./service";
import { Unlock, type UnlockContext } from "./unlock";

/** The host the service's `load` starts (`startAudioHost`), set by a test; the probe answers "supported" (Node has no worklet). */
const started = vi.hoisted(() => ({ host: null as unknown }));
vi.mock("./probe", () => ({ probeCoreSupport: async () => ({ supported: true }) }));
vi.mock("./context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./context")>()),
  startAudioHost: async () => started.host,
}));

// A0.8-L1 fills these (architecture §1, §3.9; api-and-models §3 "Bus state serialisation", §7): the page's one
// AudioHost across play, stop and replay cycles of two Engines, with fakes for Web Audio. Hosts are built with
// `AudioHost._create(parts)` and the page singleton with `acquireAudioHost`; closing the current host in afterEach.

/** A fake context: a mutable `state`, `resume`/`close` as `vi.fn`s, and a statechange listener set this file can fire. */
function fakeContext(state = "suspended") {
  const listeners = new Set<() => void>();
  const ctx = {
    state,
    destination: {},
    resume: vi.fn((): Promise<void> => Promise.resolve()),
    close: vi.fn((): Promise<void> => Promise.resolve()),
    addEventListener(_type: "statechange", listener: () => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: "statechange", listener: () => void) {
      listeners.delete(listener);
    },
    fireStateChange() {
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
  ctx.close.mockImplementation(() => {
    ctx.state = "closed";
    return Promise.resolve();
  });
  return ctx;
}

/** A fake worklet node: its port records posts, and connect/disconnect are `vi.fn`s. */
function fakeNode() {
  return {
    port: { postMessage: vi.fn(), onmessage: null as ((event: { data: unknown }) => void) | null },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

const hosts: AudioHost[] = [];
const engines: Engine[] = [];

/** A host built from fakes, closed by `cleanup` if the test leaves it open. */
function makeHost() {
  const context = fakeContext();
  const node = fakeNode();
  const link = new CoreLink(node.port);
  const unlock = new Unlock({ target: new EventTarget(), context: context as unknown as UnlockContext });
  const host = AudioHost._create({
    context: context as unknown as AudioContext,
    node: node as unknown as AudioWorkletNode,
    link,
    unlock,
    preset: presetFromSettings(defaultAudioSettings()),
  });
  hosts.push(host);
  return { host, context, node };
}

/** Calls `run` and returns what it threw. A stub's "not implemented" error is rethrown, so it fails the test as itself. */
function errorFrom(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error && error.message === "not implemented: A0.8") throw error;
    return error as Error;
  }
  throw new Error("expected the call to throw");
}

/** Settings whose bus tree is `names` (root first); every other bus is a child of the root. */
function settingsWith(names: string[], base: AudioSettings = defaultAudioSettings()): AudioSettings {
  return {
    ...base,
    buses: names.map((name, i) => ({ name, ...(i > 0 ? { parent: "Master" } : {}), volume: 1, mute: false, effects: [] })),
  };
}

/** Runs the service's real `load` (the probe and the host start stand in) with `host` as the host it starts. */
async function loadService(host: AudioHost): Promise<void> {
  started.host = host;
  const loaded = await AUDIO_SERVICE.load("core");
  expect(loaded).toMatchObject({ ready: true, host });
}

/** Creates a headless Engine whose project has the buses `names` (root first), and disposes it in cleanup. */
async function createEngine(names: string[]): Promise<Engine> {
  const engine = await Engine.create({
    headless: true,
    project: { audio: { buses: names.map((name, i) => (i === 0 ? { name } : { name, parent: "Master" })) } },
  });
  engines.push(engine);
  return engine;
}

async function cleanup(): Promise<void> {
  try {
    await currentAudioHost()?.close();
  } finally {
    for (const engine of engines.splice(0)) engine.dispose();
    for (const host of hosts.splice(0)) if (!host.closed) await host.close();
    mixer.configure(defaultAudioSettings());
  }
}

describe("busRemap", () => {
  it("maps each old index to the index of the same name in the new tree", () => {
    expect(busRemap(["Master", "Music", "SFX"], ["Master", "SFX", "Music"])).toEqual(new Uint8Array([0, 2, 1]));
  });

  it("maps names missing from the new tree to the root (0)", () => {
    expect(busRemap(["Master", "Music", "SFX"], ["Master", "SFX"])).toEqual(new Uint8Array([0, 0, 1]));
  });

  it("gives an empty map from an empty tree", () => {
    expect(busRemap([], [])).toEqual(new Uint8Array(0));
  });
});

describe("page singleton", () => {
  afterEach(cleanup);

  it("two acquires, even concurrent, call start once and give the same host", async () => {
    const { host } = makeHost();
    const start = vi.fn(async () => host);

    const [a, b] = await Promise.all([acquireAudioHost(start), acquireAudioHost(start)]);

    expect(start).toHaveBeenCalledTimes(1);
    expect(a).toBe(host);
    expect(b).toBe(host);
    expect(await acquireAudioHost(start)).toBe(host);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("a failed start isn't kept: the next acquire starts again", async () => {
    const failing = vi.fn(async (): Promise<AudioHost> => {
      throw new Error("start failed");
    });
    await expect(acquireAudioHost(failing)).rejects.toThrow("start failed");

    const { host } = makeHost();
    const start = vi.fn(async () => host);
    expect(await acquireAudioHost(start)).toBe(host);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("a closed host isn't kept: the next acquire starts a new one", async () => {
    const { host: first } = makeHost();
    expect(await acquireAudioHost(async () => first)).toBe(first);
    await first.close();
    expect(currentAudioHost()).toBeNull();

    const { host: second } = makeHost();
    const start = vi.fn(async () => second);
    expect(await acquireAudioHost(start)).toBe(second);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("currentAudioHost is null before, the host after, null once it is closed", async () => {
    expect(currentAudioHost()).toBeNull();

    const { host } = makeHost();
    await acquireAudioHost(async () => host);
    expect(currentAudioHost()).toBe(host);

    await host.close();
    expect(currentAudioHost()).toBeNull();
    expect(host.closed).toBe(true);
  });
});

describe("World shares", () => {
  afterEach(cleanup);

  it("attachWorld gives keys from 1, lowest free first; the same owner gets its existing share", () => {
    const { host } = makeHost();
    const owners = [{}, {}, {}];
    const shares = owners.map((owner) => host.attachWorld(owner));
    expect(shares.map((share) => share.key)).toEqual([1, 2, 3]);

    host.releaseWorld(2);
    expect(host.attachWorld({}).key).toBe(2);
    expect(host.attachWorld(owners[0]!)).toBe(shares[0]);
    expect(host.worldCount).toBe(3);
  });

  it("releaseWorld runs onWorldReleased, frees the key for reuse, and returns false for an unknown key", () => {
    const { host } = makeHost();
    const onWorldReleased = vi.fn();
    host.addLifecycleListener({ onWorldReleased });
    const ownerA = {};
    const a = host.attachWorld(ownerA);
    host.attachWorld({});

    expect(host.releaseWorld(a.key)).toBe(true);
    expect(onWorldReleased).toHaveBeenCalledWith(1, ownerA);
    expect(a.released).toBe(true);
    expect(host.worldShare(1)).toBeNull();
    expect(host.attachWorld({}).key).toBe(1);

    expect(host.releaseWorld(99)).toBe(false);
    expect(onWorldReleased).toHaveBeenCalledTimes(1);
  });

  it("onIdle runs once when the last World releases, not before", () => {
    const { host } = makeHost();
    const onIdle = vi.fn();
    host.addLifecycleListener({ onIdle });
    const a = host.attachWorld({});
    const b = host.attachWorld({});

    host.releaseWorld(a.key);
    expect(onIdle).not.toHaveBeenCalled();

    host.releaseWorld(b.key);
    expect(onIdle).toHaveBeenCalledTimes(1);

    expect(host.releaseWorld(b.key)).toBe(false);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("the 256th World throws; attachWorld after close throws", async () => {
    const { host } = makeHost();
    for (let i = 0; i < 255; i++) host.attachWorld({});
    expect(host.worldCount).toBe(255);
    expect(errorFrom(() => host.attachWorld({}))).toBeInstanceOf(Error);

    await host.close();
    expect(errorFrom(() => host.attachWorld({}))).toBeInstanceOf(Error);
  });

  it("close runs onClose, drops every share without onWorldReleased, and a second close does nothing", async () => {
    const { host, context } = makeHost();
    const onClose = vi.fn();
    const onWorldReleased = vi.fn();
    host.addLifecycleListener({ onClose, onWorldReleased });
    host.attachWorld({});
    host.attachWorld({});

    await host.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onWorldReleased).not.toHaveBeenCalled();
    expect(host.worldCount).toBe(0);
    expect(host.closed).toBe(true);

    await host.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("the context is never closed by releaseWorld (the core stays for the page)", () => {
    const { host, context } = makeHost();
    const key = host.attachWorld({}).key;

    expect(host.releaseWorld(key)).toBe(true);
    expect(host.worldCount).toBe(0);
    expect(context.close).not.toHaveBeenCalled();
  });
});

describe("AudioWorldService", () => {
  afterEach(cleanup);

  it("create attaches the World and dispose releases it; a second dispose does nothing", () => {
    const { host } = makeHost();
    const onWorldReleased = vi.fn();
    host.addLifecycleListener({ onWorldReleased });
    const world = {} as World;

    const service = new AudioWorldService(world, { ready: true, host });
    const key = service.key;
    expect(service.share).not.toBeNull();
    expect(service.share?.owner).toBe(world);
    expect(key).toBeGreaterThan(0);
    expect(host.worldCount).toBe(1);
    expect(host.worldShare(key)).toBe(service.share);

    service.dispose();
    expect(host.worldCount).toBe(0);
    expect(onWorldReleased).toHaveBeenCalledTimes(1);
    expect(onWorldReleased).toHaveBeenCalledWith(key, world);

    // The key is free again; a second dispose must not release the World that now holds it.
    const other = host.attachWorld({});
    expect(other.key).toBe(key);
    service.dispose();
    expect(onWorldReleased).toHaveBeenCalledTimes(1);
    expect(host.worldShare(other.key)).toBe(other);
  });

  it("without a host (core didn't load) it holds no share and key is 0", () => {
    const service = new AudioWorldService({} as World, { ready: false, reason: "no probe" });

    expect(service.share).toBeNull();
    expect(service.key).toBe(0);
    expect(() => service.dispose()).not.toThrow();
  });
});

describe("reconfigure", () => {
  afterEach(cleanup);

  it("the first reconfigure sets busNames and bumps busEpoch with an empty map", () => {
    const { host } = makeHost();
    const onBusRemap = vi.fn();
    host.addLifecycleListener({ onBusRemap });
    const names = ["Master", "Music"];

    const remap = host.reconfigure(settingsWith(names));

    expect(host.busNames).toEqual(names);
    expect(host.busEpoch).toBe(1);
    expect(remap).not.toBeNull();
    expect(remap?.map.length).toBe(0);
    expect(onBusRemap).toHaveBeenCalledWith(remap);
  });

  it("different bus names bump busEpoch and give onBusRemap the remap; the same names return null", () => {
    const { host } = makeHost();
    const onBusRemap = vi.fn();
    host.addLifecycleListener({ onBusRemap });
    host.reconfigure(settingsWith(["Master", "Music", "SFX", "UI", "Voice"]));
    expect(host.busEpoch).toBe(1);

    expect(host.reconfigure(settingsWith(["Master", "Music", "SFX", "UI", "Voice"]))).toBeNull();
    expect(host.busEpoch).toBe(1);
    expect(onBusRemap).toHaveBeenCalledTimes(1);

    const remap = host.reconfigure(settingsWith(["Master", "Music", "Ambience"]));
    expect(remap).not.toBeNull();
    expect(host.busEpoch).toBe(2);
    expect(remap?.epoch).toBe(2);
    expect(remap?.from).toEqual(["Master", "Music", "SFX", "UI", "Voice"]);
    expect(remap?.to).toEqual(["Master", "Music", "Ambience"]);
    expect(remap?.map).toEqual(new Uint8Array([0, 1, 0, 0, 0]));
    expect(onBusRemap).toHaveBeenLastCalledWith(remap);
    expect(onBusRemap).toHaveBeenCalledTimes(2);
  });

  it("a stand-in voice table's bus indices remap by name through onBusRemap, unknown names to the root", () => {
    const { host } = makeHost();
    host.reconfigure(settingsWith(["Master", "Music", "SFX", "UI", "Voice"]));
    // Voices on Music, SFX, Voice and UI.
    const voices = Uint8Array.from([1, 2, 4, 3]);
    host.addLifecycleListener({
      onBusRemap: (remap) => {
        for (let i = 0; i < voices.length; i++) voices[i] = remap.map[voices[i]!]!;
      },
    });

    // SFX is gone, so its voice goes to the root; Voice moves from 4 to 2; Music stays at 1; UI (gone) goes to the root.
    host.reconfigure(settingsWith(["Master", "Music", "Voice"]));

    expect(Array.from(voices)).toEqual([1, 0, 2, 0]);
  });

  it("a preset change sets pendingPreset and leaves preset alone; the same preset clears it", () => {
    const { host } = makeHost();
    const base = defaultAudioSettings();
    const running = presetFromSettings(base);
    const bigger = { ...base, voices: { ...base.voices, mixed: 256 } };

    host.reconfigure(bigger);
    expect(host.pendingPreset).toEqual(presetFromSettings(bigger));
    expect(host.preset).toEqual(running);

    host.reconfigure(base);
    expect(host.pendingPreset).toBeNull();
    expect(host.preset).toEqual(running);
  });
});

describe("two Engines on one page (§3.9)", () => {
  afterEach(cleanup);

  it("the service's load applies the mixer's settings to the host, then follows each Engine.create's audio settings", async () => {
    const { host } = makeHost();
    await createEngine(["Master", "Music"]);

    await loadService(host);
    expect(host.busNames).toEqual(["Master", "Music"]);
    const epoch = host.busEpoch;

    await createEngine(["Master", "Music", "SFX"]);
    expect(host.busNames).toEqual(["Master", "Music", "SFX"]);
    expect(host.busEpoch).toBe(epoch + 1);
  });

  it("loading again with the same host follows once; closing the host stops following", async () => {
    const { host } = makeHost();
    await loadService(host);
    await loadService(host);
    const reconfigure = vi.spyOn(host, "reconfigure");
    await createEngine(["Master", "Music"]);
    expect(reconfigure).toHaveBeenCalledTimes(1);

    await host.close();
    await createEngine(["Master", "Music", "SFX"]);
    expect(reconfigure).toHaveBeenCalledTimes(1);
  });

  it("play, stop and replay cycles across an editor World and play Worlds keep one host and one context", async () => {
    const { host, context } = makeHost();
    const editor = await createEngine(["Master", "Music"]);
    await loadService(host);

    // The editor's edit World registers and holds no voices.
    const editWorld = new AudioWorldService(editor.world, { ready: true, host });
    expect(editWorld.key).toBe(1);
    expect(host.worldCount).toBe(1);

    // A voice on Music, in a table the host remaps by name.
    const voices = Uint8Array.from([1]);
    host.addLifecycleListener({
      onBusRemap: (remap) => {
        for (let i = 0; i < voices.length; i++) voices[i] = remap.map[voices[i]!]!;
      },
    });

    // Play: the play World (with SFX added to the tree) takes the view and its share.
    const play = await createEngine(["Master", "SFX", "Music"]);
    const playWorld = new AudioWorldService(play.world, { ready: true, host });
    expect(playWorld.key).toBe(2);
    expect(host.worldCount).toBe(2);
    expect(voices[0]).toBe(2);
    const playEpoch = host.busEpoch;

    // Stop: releaseWorld for the play World; the editor's World and the context stay.
    playWorld.dispose();
    expect(host.worldCount).toBe(1);
    expect(host.worldShare(2)).toBeNull();
    expect(context.close).not.toHaveBeenCalled();

    // Replay: same tree, so no remap; the key is reused.
    const replay = await createEngine(["Master", "SFX", "Music"]);
    const replayWorld = new AudioWorldService(replay.world, { ready: true, host });
    expect(replayWorld.key).toBe(2);
    expect(host.busEpoch).toBe(playEpoch);
    replayWorld.dispose();

    // The editor reconfigures the one mixer again: the voice remaps back to Music's index.
    await createEngine(["Master", "Music"]);
    expect(voices[0]).toBe(1);

    editWorld.dispose();
    expect(host.worldCount).toBe(0);
    expect(context.close).not.toHaveBeenCalled();
    expect(host.closed).toBe(false);
  });

  it("on the \"babylon\" backend no host starts and Engine.create behaves as before", async () => {
    expect(currentAudioHost()).toBeNull();

    const engine = await Engine.create({ headless: true, project: { audio: { backend: "babylon" } } });
    engines.push(engine);

    expect(engine.world).toBeDefined();
    expect(currentAudioHost()).toBeNull();
  });
});
