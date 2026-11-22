// ADR 0337 §7, §9 (A5): audio packages at runtime on the fake backend, through the public `Audio` API, scene loading and
// the `AudioPackageLoader` component: the strict rule (`notLoaded`) and the lenient one, reference counts (per package
// and per clip across packages), unload's fade and `finish`, preload packages before the first scene, a build's package
// fetched with progress, the media table's URLs, codecs the backend can't play yet, `Audio.debug().packages` and the PKG
// capture events.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { Assets, Audio, AudioPackageLoader, Engine, GameObject, SceneManager } from "../../../../myco";
import { writeAudioPack } from "../../../../engine/audio/packaging/format";
import type { AudioManifest } from "../../../../export/format";
import { setAudioBackend } from "../backend";
import { endAudioSession, makeFakeBackend, type FakeVoice } from "../testing";
import { taps } from "../mix/profileTaps";
import { NULL_PROFILE_SINK, type ProfileSink } from "../mix/profileSink";
import { installAudioMedia } from "./mediaTable";

const fake = makeFakeBackend();
let warn: MockInstance<typeof console.warn>;
let engine: Engine;
const warnings = (needle: string) => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(needle));
const WAV = "data:audio/wav;base64,AAAA";

/** `audio.json` with a preload package, a level package (a playlist and its samples) and a shared sound. */
function audioJson(extra: Record<string, unknown> = {}) {
  return {
    format: "myco.audio@1",
    packages: [
      { name: "Core", preload: true, include: ["audio/ui/**"] },
      { name: "Forest", include: ["playlists/forest.playlist.json", "audio/shared.wav"] },
      { name: "Cave", include: ["audio/shared.wav"] },
    ],
    ...extra,
  };
}

function assets(audio: unknown = audioJson(), more: Record<string, unknown> = {}) {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({
    "audio.json": audio,
    "s.json": { format: "myco.scene@1", nodes: [] },
    "level.scene.json": { format: "myco.scene@1", nodes: [{ id: "loader", name: "Loader", components: [{ type: "engine.AudioPackageLoader", data: { packages: ["Forest"] } }] }] },
    "audio/ui/click.wav": WAV,
    "audio/forest/bird.wav": WAV,
    "audio/shared.wav": WAV,
    "audio/loose.wav": WAV,
    "playlists/forest.playlist.json": { format: "myco.playlist@1", type: "clip", entries: [{ sample: "audio/forest/bird.wav" }] },
    ...more,
  }));
}

beforeEach(async () => {
  endAudioSession();
  installAudioMedia(null);
  fake.clear();
  fake.ready = true;
  fake.clipCache = undefined;
  setAudioBackend(fake);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  assets();
  engine = await Engine.create({ headless: true });
  engine.world.render = {} as never; // a World that plays sound (headless Worlds never load packages)
});

afterEach(() => {
  engine.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  installAudioMedia(null);
  setAudioBackend(null);
  taps.sink = NULL_PROFILE_SINK;
  endAudioSession();
});

const lastVoice = () => fake.voices.at(-1) as FakeVoice;
const stops = (v: FakeVoice) => v.events.filter((e) => e.kind === "stop");

describe("packages over the sources (editor Play)", () => {
  it("refuses a packaged sound until its package loads (strict), with reason notLoaded and one warning", async () => {
    const h = Audio.playOneShot("audio/forest/bird.wav");
    expect(h.playing).toBe(false);
    expect(h.reason).toBe("notLoaded");
    Audio.playOneShot("audio/forest/bird.wav");
    expect(fake.plays).toHaveLength(0);
    expect(warnings('"audio/forest/bird.wav" is in package "Forest", which isn\'t loaded')).toHaveLength(1);
    // A playlist in a package is refused too; a loose sound plays.
    expect(Audio.play("playlists/forest.playlist.json").reason).toBe("notLoaded");
    expect(Audio.playOneShot("audio/loose.wav").playing).toBe(true);

    const forest = Audio.package("Forest");
    expect(forest.state).toBe("unloaded");
    await forest.load();
    expect(forest).toMatchObject({ name: "Forest", state: "loaded", progress: 1 });
    expect(Audio.playOneShot("audio/forest/bird.wav").playing).toBe(true);
    expect(fake.plays.at(-1)).toMatchObject({ path: "audio/forest/bird.wav", url: WAV });
  });

  it("plays it from its file with a warning when packaging isn't strict", () => {
    assets(audioJson({ packaging: { strict: false } }));
    expect(Audio.playOneShot("audio/forest/bird.wav").playing).toBe(true);
    expect(warnings("packaging.strict is off")).toHaveLength(1);
  });

  it("counts references: the last unload stops the package's voices with a 50 ms fade", async () => {
    const forest = Audio.package("Forest");
    await forest.load();
    await forest.load();
    Audio.playOneShot("audio/forest/bird.wav");
    const v = lastVoice();
    forest.unload();
    expect(forest.state).toBe("loaded");
    expect(stops(v)).toEqual([]);
    forest.unload();
    expect(forest.state).toBe("unloaded");
    expect(stops(v)).toEqual([{ kind: "stop", fadeSeconds: 0.05 }]);
    expect(Audio.playOneShot("audio/forest/bird.wav").reason).toBe("notLoaded");
  });

  it("unload({ finish: true }) lets the voices end, and frees the clip once they have", async () => {
    fake.clipCache = fake;
    const invalidate = vi.spyOn(fake, "invalidateClip");
    const forest = Audio.package("Forest");
    await forest.load();
    Audio.playOneShot("audio/forest/bird.wav");
    const v = lastVoice();
    vi.useFakeTimers();
    try {
      forest.unload({ finish: true });
      expect(forest.state).toBe("unloaded");
      expect(stops(v)).toEqual([]);
      vi.advanceTimersByTime(1000);
      expect(invalidate).not.toHaveBeenCalled();
      v.end();
      vi.advanceTimersByTime(300);
    } finally {
      vi.useRealTimers();
    }
    expect(invalidate).toHaveBeenCalledWith("audio/forest/bird.wav");
  });

  it("shares a sound across packages: it plays while any one holds it and stops with the last", async () => {
    fake.clipCache = fake;
    const invalidate = vi.spyOn(fake, "invalidateClip");
    await Audio.package("Forest").load();
    await Audio.package("Cave").load();
    Audio.playOneShot("audio/shared.wav");
    const v = lastVoice();
    Audio.package("Forest").unload();
    expect(stops(v)).toEqual([]);
    expect(Audio.playOneShot("audio/shared.wav").playing).toBe(true);
    Audio.package("Cave").unload();
    expect(stops(v)).toEqual([{ kind: "stop", fadeSeconds: 0.05 }]);
    expect(invalidate).toHaveBeenCalledWith("audio/shared.wav");
    expect(Audio.playOneShot("audio/shared.wav").reason).toBe("notLoaded");
  });

  it("rejects an unknown package's load with one warning", async () => {
    const nope = Audio.package("Nope");
    await expect(nope.load()).rejects.toThrow(/no package by that name/);
    await expect(nope.load()).rejects.toThrow();
    expect(warnings('Audio.package("Nope")')).toHaveLength(1);
    expect(nope.state).toBe("unloaded");
  });

  it("loads the preload packages and a scene's loader packages before the scene starts, and drops them with it", async () => {
    expect(Audio.packages.map((p) => p.name)).toEqual(["Core", "Forest", "Cave"]);
    const scene = SceneManager.load("level.scene.json");
    await scene;
    expect(Audio.package("Core").state).toBe("loaded");
    expect(Audio.package("Forest").state).toBe("loaded");
    expect(Audio.playOneShot("audio/ui/click.wav").playing).toBe(true);
    // The loader adopted the scene's reference: one reference, not two.
    expect(Audio.debug().packages).toEqual([
      { name: "Core", state: "loaded", refs: 1, bytes: 0, memoryBytes: 0, preload: true },
      { name: "Forest", state: "loaded", refs: 1, bytes: 0, memoryBytes: 0, preload: false },
      { name: "Cave", state: "unloaded", refs: 0, bytes: 0, memoryBytes: 0, preload: false },
    ]);
    const loader = engine.world.sceneNodes[0]!.find("Loader") as GameObject;
    expect(loader.getBehavior(AudioPackageLoader)!.packages).toEqual(["Forest"]);
    GameObject.destroy(loader);
    engine.step(1 / 60);
    expect(Audio.package("Forest").state).toBe("unloaded");
    // Tearing the World down drops what it held (the preload package).
    engine.dispose();
    expect(Audio.package("Core").state).toBe("unloaded");
    engine = await Engine.create({ headless: true });
  });

  it("never loads packages in a headless World", async () => {
    engine.world.render = null as never;
    await SceneManager.load("level.scene.json");
    expect(Audio.package("Core").state).toBe("unloaded");
    expect(Audio.package("Forest").state).toBe("unloaded");
  });
});

// --- a build ------------------------------------------------------------------------------------------------------------

/** A build's packages: Forest (a decoded Vorbis entry, a shared one, a streamed head), Cave (the shared one), UI (ADPCM). */
function buildPacks() {
  const entry = (path: string, over: Partial<Parameters<typeof writeAudioPack>[2][number]["entry"]> = {}) => ({ path, codec: "vorbis" as const, rate: 48000, channels: 2, frames: 48000, load: "decode" as const, hash: "h", prefetch: null, ...over });
  const forest = writeAudioPack("Forest", "web", [
    { entry: entry("audio/forest/bird.wav"), data: new Uint8Array(4000).fill(1) },
    { entry: entry("audio/shared.wav", { frames: 24000 }), data: new Uint8Array(2000).fill(2) },
    { entry: entry("audio/music/theme.wav", { codec: "pcm", load: "stream", prefetch: { frames: 4800 } }), data: new Uint8Array(19200).fill(3) },
  ]);
  const cave = writeAudioPack("Cave", "web", [{ entry: entry("audio/shared.wav", { frames: 24000 }), data: new Uint8Array(2000).fill(2) }]);
  const ui = writeAudioPack("UI", "web", [{ entry: entry("audio/ui/click.wav", { codec: "adpcm", load: "compressed", frames: 4800, channels: 1 }), data: new Uint8Array(2400).fill(4) }]);
  const manifest: AudioManifest = {
    platform: "web",
    packages: [
      { name: "Forest", url: "audio/packages/Forest.mycopak", bytes: forest.length, preload: false },
      { name: "Cave", url: "audio/packages/Cave.mycopak", bytes: cave.length, preload: false },
      { name: "UI", url: "audio/packages/UI.mycopak", bytes: ui.length, preload: false },
    ],
    media: {
      "audio/forest/bird.wav": { package: "Forest", codec: "vorbis", load: "decode", rate: 48000, channels: 2, frames: 48000 },
      "audio/shared.wav": { package: "Forest", packages: ["Forest", "Cave"], codec: "vorbis", load: "decode", rate: 48000, channels: 2, frames: 24000 },
      "audio/music/theme.wav": { package: "Forest", url: "audio/stream/0123456789abcdef.ogg", codec: "vorbis", load: "stream", rate: 48000, channels: 2, frames: 480000 },
      "audio/ui/click.wav": { package: "UI", codec: "adpcm", load: "compressed", rate: 48000, channels: 1, frames: 4800 },
      "audio/loose.wav": { codec: "vorbis", load: "decode", rate: 44100, channels: 2, frames: 1000 },
    },
  };
  return { files: { [manifest.packages[0].url]: forest, [manifest.packages[1].url]: cave, [manifest.packages[2].url]: ui }, manifest };
}

/** `fetch` serving `files` in two chunks, the second held back until `release()`. */
function stubFetch(files: Record<string, Uint8Array>) {
  const held: (() => void)[] = [];
  const fetched: string[] = [];
  let released = false;
  vi.stubGlobal("fetch", async (url: string) => {
    fetched.push(url);
    const bytes = files[url.replace(/^https:\/\/game\.test\//, "")];
    if (!bytes) return { ok: false, status: 404 };
    const half = bytes.length >> 1;
    let gate!: () => void;
    const opened = new Promise<void>((r) => (gate = r));
    if (released) gate();
    else held.push(gate);
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(bytes.slice(0, half));
        await opened;
        c.enqueue(bytes.slice(half));
        c.close();
      },
    });
    return { ok: true, status: 200, headers: new Headers({ "content-length": String(bytes.length) }), body };
  });
  return {
    fetched,
    release: () => {
      released = true;
      held.splice(0).forEach((g) => g());
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("packages in a build (the media table)", () => {
  it("fetches a package with progress, plays its sounds from memory and streams its streamed sound from its loose media", async () => {
    const { files, manifest } = buildPacks();
    assets(audioJson({ packages: undefined }));
    installAudioMedia(manifest, (p) => `https://game.test/${p}`);
    const net = stubFetch(files);
    const forest = Audio.package("Forest");
    expect(forest.bytes).toBe(files["audio/packages/Forest.mycopak"].length);
    const loading = forest.load();
    expect(forest.state).toBe("loading");
    await tick();
    expect(forest.progress).toBeGreaterThan(0.4);
    expect(forest.progress).toBeLessThan(0.6);
    net.release();
    await loading;
    expect(net.fetched).toEqual(["https://game.test/audio/packages/Forest.mycopak"]);
    expect(forest).toMatchObject({ state: "loaded", progress: 1 });
    // Decoded PCM of both decode entries plus the stream's prefetch head.
    expect(forest.memoryBytes).toBe(48000 * 2 * 2 + 24000 * 2 * 2 + 4800 * 2 * 2);
    expect(Audio.playOneShot("audio/forest/bird.wav").playing).toBe(true);
    expect(fake.plays.at(-1)!.url).toMatch(/^blob:/);
    expect(fake.plays.at(-1)!.stream).toBe(false);
    Audio.playOneShot("audio/music/theme.wav");
    expect(fake.plays.at(-1)).toMatchObject({ url: "https://game.test/audio/stream/0123456789abcdef.ogg", stream: true });
    // A converted loose sound plays from its project file.
    expect(Audio.playOneShot("audio/loose.wav").playing).toBe(true);
    expect(fake.plays.at(-1)!.url).toBe(WAV);
  });

  it("refuses ADPCM media the backend can't decode yet (reason failed), once-warned", async () => {
    const { files, manifest } = buildPacks();
    installAudioMedia(manifest, (p) => `https://game.test/${p}`);
    stubFetch(files).release();
    const ui = Audio.package("UI");
    const loading = ui.load();
    await tick();
    await loading;
    expect(Audio.playOneShot("audio/ui/click.wav").reason).toBe("failed");
    Audio.playOneShot("audio/ui/click.wav");
    expect(warnings("shipped as ADPCM")).toHaveLength(1);
    expect(fake.plays).toHaveLength(0);
  });

  it("refuses a packaged sound before its package loads, and lenient packaging starts the load", async () => {
    const { files, manifest } = buildPacks();
    installAudioMedia(manifest, (p) => `https://game.test/${p}`);
    const net = stubFetch(files);
    expect(Audio.playOneShot("audio/forest/bird.wav").reason).toBe("notLoaded");
    expect(net.fetched).toEqual([]);
    assets(audioJson({ packaging: { strict: false } }));
    expect(Audio.playOneShot("audio/forest/bird.wav").reason).toBe("notLoaded");
    expect(net.fetched).toEqual(["https://game.test/audio/packages/Forest.mycopak"]);
    expect(Audio.package("Forest").state).toBe("loading");
    // Plays while it loads start no second load and take no more references.
    Audio.playOneShot("audio/forest/bird.wav");
    expect(net.fetched).toHaveLength(1);
    expect(Audio.debug().packages.find((p) => p.name === "Forest")!.refs).toBe(1);
  });

  it("reports a failed fetch: load rejects, the state is failed, and a later load tries again", async () => {
    const { manifest } = buildPacks();
    installAudioMedia(manifest, (p) => `https://game.test/${p}`);
    stubFetch({});
    await expect(Audio.package("Forest").load()).rejects.toThrow(/HTTP 404/);
    expect(Audio.package("Forest").state).toBe("failed");
    const { files } = buildPacks();
    stubFetch(files).release();
    const again = Audio.package("Forest").load();
    await tick();
    await again;
    expect(Audio.package("Forest").state).toBe("loaded");
  });

  it("holds the first scene back until the preload packages are in", async () => {
    const { files, manifest } = buildPacks();
    installAudioMedia({ ...manifest, packages: manifest.packages.map((p) => (p.name === "Cave" ? { ...p, preload: true } : p)) }, (p) => `https://game.test/${p}`);
    const net = stubFetch(files);
    let started = false;
    const loading = SceneManager.load("s.json").then(() => void (started = true));
    await tick();
    expect(net.fetched).toEqual(["https://game.test/audio/packages/Cave.mycopak"]);
    expect(Audio.package("Cave").state).toBe("loading");
    expect(started).toBe(false);
    expect(engine.world.sceneNodes).toEqual([]);
    net.release();
    await loading;
    expect(started).toBe(true);
    expect(Audio.package("Cave").state).toBe("loaded");
    expect(Audio.playOneShot("audio/shared.wav").playing).toBe(true);
  });

  it("writes PKG capture events: load start, loaded, unload", async () => {
    const { files, manifest } = buildPacks();
    installAudioMedia(manifest, (p) => `https://game.test/${p}`);
    stubFetch(files).release();
    const events: [string, string, number][] = [];
    taps.sink = { ...NULL_PROFILE_SINK, audioPackage: (name, event, bytes) => void events.push([name, event, bytes]) } as ProfileSink;
    const cave = Audio.package("Cave");
    const loading = cave.load();
    await tick();
    await loading;
    cave.unload();
    const bytes = files["audio/packages/Cave.mycopak"].length;
    expect(events).toEqual([["Cave", "loadStart", bytes], ["Cave", "loaded", bytes], ["Cave", "unload", bytes]]);
  });
});
