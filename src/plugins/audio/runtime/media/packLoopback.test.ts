// W12 (ADR 0337 §7, §9): package playback end to end. A small project is exported by the real export (the real encoder,
// in worker threads) into a temp folder; the build's media table is installed as the player installs it, and the game's
// side runs on the loopback host: the core as production assembles it, the real decoder handler in process and the real
// mixer, reached through the public `Audio` API only (`Audio.package(name).load()`, `Audio.playOneShot`, `Audio.debug()`).
//
// - a package with an ADPCM `compressed` sound loads, commits the sound to the clip arena at load (its memory and the
//   core's arena figure rise before anything plays), and plays above 30 dB SNR against its source;
// - unloading releases the package and frees the arena, and the sound is refused again (`notLoaded`);
// - a `compressed` Vorbis sound plays from the decoder's copy; the decoder crashing mid-play stops it, and the next play
//   recovers on a respawned worker that fetched the package again (the main thread keeps no copy).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { encodeWavFloat32 } from "../../../../engine/audio/sample/wavEncode";
import type { GameManifest } from "../../../../export/format";
import { exportProject } from "../../../../export/node";
import { QPF, rig } from "../../testing/streamRig";
import { closeLoopbackAudio } from "../testing";
import { installAudioMedia } from "./mediaTable";

const RATE = 48_000;
const temps: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "myco-pack-loopback-"));
  temps.push(dir);
  return dir;
};

/** The click's source: two tones, mono, 0.5 s at 48 kHz. */
function clickPcm(): Float32Array {
  const frames = RATE / 2;
  return Float32Array.from({ length: frames }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / RATE) + 0.15 * Math.sin((2 * Math.PI * 1250 * i) / RATE));
}

/** A stereo tone of `seconds` at 48 kHz. */
function tone(seconds: number, hz: number): Uint8Array {
  const frames = Math.round(seconds * RATE);
  const pcm = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) for (let c = 0; c < 2; c++) pcm[i * 2 + c] = 0.25 * Math.sin((2 * Math.PI * (hz + 55 * c) * i) / RATE);
  return encodeWavFloat32(pcm, 2, RATE);
}

function fakePlayer(): string {
  const dir = temp();
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "files.json"), JSON.stringify({ files: ["assets/player-x.js", "myco.js", "player.html"] }));
  writeFileSync(join(dir, "assets", "player-x.js"), "// player");
  writeFileSync(join(dir, "myco.js"), "export {};");
  writeFileSync(join(dir, "player.html"), "<!DOCTYPE html><title>player</title>");
  return dir;
}

const AUDIO_JSON = {
  format: "myco.audio@1",
  encoding: {
    default: "Default",
    profiles: {
      Default: { codec: "auto", quality: 0.5 },
      UI: { codec: "adpcm", load: "compressed" },
      Amb: { codec: "vorbis", quality: 0.5, load: "compressed" },
      Music: { codec: "vorbis", quality: 0.5, load: "stream", prefetchMs: 250 },
    },
    rules: [{ path: "audio/ui/**", profile: "UI" }, { path: "audio/amb/**", profile: "Amb" }, { path: "audio/music/**", profile: "Music" }],
  },
  packages: [{ name: "Core", include: ["audio/ui/**"] }, { name: "Level", include: ["audio/amb/**", "audio/music/**"] }],
};

/** The exported build's folder and manifest (one export for every test). */
let build: { out: string; manifest: GameManifest };

beforeAll(async () => {
  const dir = temp();
  const write = (path: string, data: string | Uint8Array) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), data);
  };
  write("project.json", JSON.stringify({ name: "Packs" }));
  write("scenes/main.scene.json", "{}");
  write("audio.json", JSON.stringify(AUDIO_JSON));
  write("audio/ui/click.wav", encodeWavFloat32(clickPcm(), 1, RATE));
  write("audio/amb/wind.wav", tone(1, 300));
  write("audio/music/theme.wav", tone(2, 220));
  const out = join(temp(), "web");
  await exportProject({ projectDir: dir, out, playerDir: fakePlayer(), platform: "web", audioWorkers: 2 });
  build = { out, manifest: JSON.parse(readFileSync(join(out, "game.json"), "utf8")) as GameManifest };
}, 120_000);

afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The build's files over HTTP, as the player fetches them; counts each package fetch. */
function serveBuild() {
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const path = String(url).replace("https://game.test/", "");
    fetched.push(path);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(join(build.out, path)));
    } catch {
      return new Response(null, { status: 404 });
    }
    return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
  });
  return fetched;
}

/** The build installed as the player installs it, and the rig on the page's mixer. */
async function game() {
  const fetched = serveBuild();
  Assets.clearSources();
  // The player lists every project file the build ships (`manifest.files`); packaged ones have no loose copy to fetch.
  const files: Record<string, unknown> = { "audio.json": AUDIO_JSON, "s.json": { format: "myco.scene@1", nodes: [] } };
  for (const path of Object.keys(build.manifest.audio!.media)) files[path] = `https://game.test/project/${path}`;
  Assets.addSource(Assets.fromObject(files));
  installAudioMedia(build.manifest.audio, (p) => `https://game.test/${p}`);
  // A World that plays sound (as a running game's), so the public API plays.
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }] } } });
  engines.push(engine);
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
  const r = await rig({}, { clipFormat: 1, pageMixer: true });
  return r ? { r, fetched } : null;
}

type Rig = NonNullable<Awaited<ReturnType<typeof rig>>>;

/** Steps the rig until `done()` holds (real time for the worker's turns), at most `frames` frames. */
async function stepUntil(r: Rig, done: () => boolean, frames = 400): Promise<void> {
  for (let f = 0; f < frames && !done(); f++) {
    await r.step(1);
    await r.settle();
  }
  expect(done()).toBe(true);
}

/** The best-fitting gain and lag of `got` against `want` and the SNR there, in dB. */
function fitSnr(want: Float32Array, got: readonly number[], start: number): { snr: number; lag: number } {
  let best = { snr: -Infinity, lag: 0 };
  for (let lag = Math.max(0, start - 32); lag <= start + 32; lag++) {
    let wg = 0;
    let gg = 0;
    for (let i = 0; i < want.length; i++) {
      const g = got[lag + i] ?? 0;
      wg += want[i]! * g;
      gg += g * g;
    }
    const k = gg > 0 ? wg / gg : 0;
    let sig = 0;
    let err = 0;
    for (let i = 0; i < want.length; i++) {
      const g = (got[lag + i] ?? 0) * k;
      sig += want[i]! * want[i]!;
      err += (want[i]! - g) ** 2;
    }
    const snr = 10 * Math.log10(sig / Math.max(err, 1e-30));
    if (snr > best.snr) best = { snr, lag };
  }
  return best;
}

const engines: { dispose(): void }[] = [];

afterEach(async () => {
  await closeLoopbackAudio();
  for (const e of engines.splice(0)) e.dispose();
  installAudioMedia(null);
  Assets.clearSources();
  vi.unstubAllGlobals();
});

describe("packages on the core (W12)", () => {
  it("an ADPCM compressed sound commits to the arena at load, plays above 30 dB SNR, and unloading frees it", { timeout: 60_000 }, async (ctx) => {
    const g = await game();
    if (!g) return ctx.skip();
    const { r } = g;
    const { Audio } = r.audio;
    expect(build.manifest.audio!.media["audio/ui/click.wav"]).toMatchObject({ package: "Core", codec: "adpcm", load: "compressed" });
    // Strict packaging: refused before its package loads.
    expect(Audio.playOneShot("audio/ui/click.wav").reason).toBe("notLoaded");
    await r.step(2);
    const arenaBefore = r.link.lastStatus!.arenaUsedKB;

    const core = Audio.package("Core");
    const loaded = core.load();
    await stepUntil(r, () => core.state === "loaded");
    await loaded;
    expect(g.fetched).toEqual(["audio/packages/Core.mycopak"]);
    // Committed at load: 12 blocks of 516 bytes (1,024 mono frames each) for 24,000 frames, in the arena before any play.
    const blocks = Math.ceil(RATE / 2 / 1024);
    expect(core.memoryBytes).toBe(blocks * 516);
    expect(Audio.debug().packages.find((p) => p.name === "Core")).toMatchObject({ state: "loaded", refs: 1, memoryBytes: blocks * 516 });
    await r.step(2);
    const arenaLoaded = r.link.lastStatus!.arenaUsedKB;
    console.log(`Core: memoryBytes ${core.memoryBytes} B; core arena ${arenaBefore} KB → ${arenaLoaded} KB (int16 would be ${(RATE / 2) * 2} B)`);
    expect(arenaLoaded).toBeGreaterThan(arenaBefore);
    expect(arenaLoaded - arenaBefore).toBeLessThan(((RATE / 2) * 2) / 1024 / 2);

    // Plays at once (resident), against the source.
    const from = r.left.length;
    const h = Audio.playOneShot("audio/ui/click.wav");
    expect(h.reason).toBeNull();
    await r.step(Math.ceil(RATE / 2 / (QPF * 128)) + 6);
    expect(h.playing).toBe(false);
    const out = r.left.slice(from);
    const start = out.findIndex((s) => s !== 0);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start).toBeLessThan(QPF * 128 * 2);
    const { snr } = fitSnr(clickPcm(), out, start);
    console.log(`ADPCM package sound on the core: SNR ${snr.toFixed(1)} dB against its source`);
    expect(snr).toBeGreaterThan(30);

    // Unload: the package goes, the arena is freed, the sound is refused again.
    core.unload();
    expect(core.state).toBe("unloaded");
    expect(core.memoryBytes).toBe(0);
    // The clip unloads a frame (a 16 ms timer here) after the hold and its voice let go.
    await stepUntil(r, () => r.link.lastStatus!.arenaUsedKB === arenaBefore);
    expect(Audio.playOneShot("audio/ui/click.wav").reason).toBe("notLoaded");
  });

  it("a compressed Vorbis sound streams from the decoder's copy, and recovers after the decoder crashes mid-play", { timeout: 60_000 }, async (ctx) => {
    const g = await game();
    if (!g) return ctx.skip();
    const { r } = g;
    const { Audio } = r.audio;
    expect(build.manifest.audio!.media["audio/amb/wind.wav"]).toMatchObject({ package: "Level", codec: "vorbis", load: "compressed" });
    const level = Audio.package("Level");
    const loaded = level.load();
    await stepUntil(r, () => level.state === "loaded");
    await loaded;
    expect(g.fetched).toEqual(["audio/packages/Level.mycopak"]);

    const play = async () => {
      const from = r.left.length;
      const h = Audio.playOneShot("audio/amb/wind.wav");
      await stepUntil(r, () => r.left.slice(from).some((s) => s !== 0));
      return h;
    };
    const first = await play();
    expect(first.playing).toBe(true);
    // The worker dies mid-play: its stream goes with it (the voice stops), and nothing was fetched again yet.
    r.worker().onerror!({ message: "test crash" });
    await stepUntil(r, () => !first.playing);
    expect(g.fetched).toEqual(["audio/packages/Level.mycopak"]);

    // The next play spawns a worker, which fetches the package again before it decodes; the sound plays to its end.
    const second = await play();
    expect(r.spawned()).toBe(2);
    expect(g.fetched).toEqual(["audio/packages/Level.mycopak", "audio/packages/Level.mycopak"]);
    await stepUntil(r, () => !second.playing, 200);
    expect(second.reason).toBeNull();
  });
});
