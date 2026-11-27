// ADR 0342, 0343: a playlist entry, a one-shot and an `AudioSource` naming a derived sample (`*.sample.json`) play its
// source audio file with its resolved edits: a snippet's range as the trim, a following fork's loops read from its
// parent's sidecar, the migration's derived loop samples. Through the public API on the fake backend, then heard on the
// real audio core (the loopback host with the committed wasm) with a Sound Lab WAV.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, SceneManager } from "../../../../myco";
import { migrateProjectAudioEvents } from "../../../../engine/audio/migrate";
import { audioFileSeconds } from "../../../../engine/audio/migrate/audioDuration";
import { setAudioBackend } from "../backend";
import { fakeDecoder, type PlanarClip } from "../core/fakeDecoder";
import { Audio, AudioSource } from "../index";
import { closeLoopbackAudio, endAudioSession, loopbackAudio } from "../testing";
import { playlistHost } from "./host";
import { eventKit, pla, sample } from "./testKit";

const kit = eventKit();
const fake = kit.fake;
const IMPORT = "myco.import@1";
const SAMPLE = "myco.sample@1";
const LOOP = { id: "l1", start: 0.5, end: 1.5, active: "held", exit: "jump" };

const snippet = (source: string, range: [number, number], sampleBlock: Record<string, unknown> = {}) =>
  ({ format: SAMPLE, source, range, lineage: { kind: "snippet", parent: source, mode: "pin" }, sample: sampleBlock });

describe("a playlist entry naming a derived sample (ADR 0342)", () => {
  it("a snippet plays its source file from its range's start and stops at its end", async () => {
    await kit.boot({
      "audio/skid.wav": "data:skid", "audio/skid.wav.meta.json": { format: IMPORT, volume: 0.5 },
      "audio/skid.brake.sample.json": snippet("audio/skid.wav", [0.8, 1.6]),
      "p.playlist.json": pla("clip", [sample("audio/skid.brake.sample.json")]),
    });
    fake.durations.set("audio/skid.wav", 3);
    const h = Audio.play("p.playlist.json");
    expect(fake.plays).toHaveLength(1);
    expect(fake.plays[0]).toMatchObject({ path: "audio/skid.wav", url: "data:skid", offset: 0.8, volume: 0.5 });
    const v = fake.voices[0]!;
    expect(h.playing).toBe(true);
    kit.setTime(0.7);
    kit.frame();
    playlistHost().update(1 / 60);
    expect(v.stopped).toBe(false);
    kit.setTime(0.85);
    kit.frame();
    playlistHost().update(1 / 60);
    expect(v.stopped).toBe(true);
  });

  it("a following fork loops by its parent's sidecar loop, and follows an edit to it", async () => {
    const files: Record<string, unknown> = {
      "a.wav.meta.json": { format: IMPORT, sample: { kind: "loop", loops: [LOOP] } },
      "a.fork.sample.json": { format: SAMPLE, source: "a.wav", range: null, lineage: { kind: "fork", parent: "a.wav", mode: "follow", baseline: { kind: "loop", loops: [LOOP] } }, sample: { kind: "loop", loops: [LOOP] } },
      "p.playlist.json": pla("clip", [sample("a.fork.sample.json")]),
    };
    await kit.boot({});
    Assets.addSource(Assets.fromObject(files));
    Audio.play("p.playlist.json");
    expect(fake.voices[0]!.request.path).toBe("a.wav");
    expect(fake.voices[0]!.events).toContainEqual({ kind: "loop", start: 0.5, end: 1.5, looping: true });
    files["a.wav.meta.json"] = { format: IMPORT, sample: { kind: "loop", loops: [{ ...LOOP, start: 0.25, end: 1 }] } };
    Audio.play("p.playlist.json");
    expect(fake.voices[1]!.events).toContainEqual({ kind: "loop", start: 0.25, end: 1, looping: true });
  });

  it("the migration's derived loop sample (two events wanting different loops on one file) plays its own loop", async () => {
    const texts = new Map([
      ["audio/hum.audioevent.json", JSON.stringify({ format: "myco.audioevent@1", bus: "SFX", root: { type: "clip", clip: "a.wav", loop: true, loopRegion: [0.1, 0.9] } })],
      ["audio/drone.audioevent.json", JSON.stringify({ format: "myco.audioevent@1", bus: "SFX", root: { type: "clip", clip: "a.wav", loop: true, loopRegion: [0.3, 0.6] } })],
    ]);
    const out = migrateProjectAudioEvents(texts, { sampleSeconds: () => 2 });
    const assets = Object.fromEntries([...out.writes].map(([p, text]) => [p, JSON.parse(text)]));
    const derived = Object.keys(assets).filter((p) => p.endsWith(".sample.json"));
    expect(derived).toEqual(["a.loop1.sample.json"]);
    await kit.boot(assets);
    Audio.play("audio/hum.playlist.json", { bus: "SFX" });
    Audio.play("audio/drone.playlist.json", { bus: "SFX" });
    const loops = fake.voices.map((v) => [v.request.path, v.events.find((e) => e.kind === "loop")]);
    expect(loops).toEqual(expect.arrayContaining([
      ["a.wav", { kind: "loop", start: 0.1, end: 0.9, looping: true }],
      ["a.wav", { kind: "loop", start: 0.3, end: 0.6, looping: true }],
    ]));
  });

  it("a missing source warns once with the path and plays nothing", async () => {
    await kit.boot({
      "m.sample.json": { format: SAMPLE, source: "gone.wav", range: null, lineage: { kind: "duplicate", parent: "gone.wav", mode: "pin" } },
      "p.playlist.json": pla("clip", [sample("m.sample.json")]),
    });
    Audio.play("p.playlist.json");
    Audio.play("p.playlist.json");
    expect(fake.plays).toHaveLength(0);
    const lines = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('m.sample.json: its source "gone.wav" isn\'t in the project'))).toHaveLength(1);
  });
});

describe("one-shots and sources naming a derived sample (ADR 0342)", () => {
  it("Audio.playOneShot and AudioSource play the source file", async () => {
    await kit.boot({ "x.sample.json": snippet("b.wav", [0.2, 0.4]) });
    Audio.playOneShot("x.sample.json");
    expect(fake.plays.at(-1)).toMatchObject({ path: "b.wav", url: "data:,", oneShot: true });
    const src = GameObject.create("n").addBehavior(AudioSource, { clip: "x.sample.json", playOnAwake: false, volume: 0.5 });
    src.play();
    kit.frame();
    expect(fake.plays.at(-1)).toMatchObject({ path: "b.wav", url: "data:," });
    expect(src.isPlaying).toBe(true);
    expect(fake.voices.at(-1)!.volume).toBeCloseTo(0.5, 6);
  });
});

// --- heard on the audio core -----------------------------------------------------------------------------------------

const SOUND_LAB = fileURLToPath(new URL("../../../../../samples/sound-lab/", import.meta.url));
const IDLE = "audio/events/engine-idle.wav"; // 1.3 s
const RATE = 48_000;
const QUANTUM = 128;
const FRAME_QUANTA = 4;
const FRAME_SECONDS = (FRAME_QUANTA * QUANTUM) / RATE;

function parseWav(bytes: ArrayBuffer): PlanarClip {
  const v = new DataView(bytes);
  let off = 12;
  let rate = 0;
  let channels = 1;
  for (;;) {
    const id = String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
    const size = v.getUint32(off + 4, true);
    if (id === "fmt ") {
      channels = v.getUint16(off + 10, true);
      rate = v.getUint32(off + 12, true);
    } else if (id === "data") {
      const frames = size / 2 / channels;
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) data[c]![f] = v.getInt16(off + 8 + (f * channels + c) * 2, true) / 32768;
      return { frames, channels, sampleRate: rate, channelData: data };
    }
    off += 8 + size + (size & 1);
  }
}

/**
 * Plays `play()` at the first frame on the real audio core (the loopback host with the committed wasm) over `files` plus
 * the Sound Lab's idle WAV, for 1.5 s: the left channel's RMS per quantum, or null when the core can't load here.
 */
async function heardOnCore(files: Record<string, unknown>, play: () => void): Promise<number[] | null> {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  setAudioBackend(null);
  endAudioSession();
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, [IDLE]: "data:,", ...files }));
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }], seed: 7, backend: "core" } } });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
  const fetchBytes = async (path: string) => {
    const b = readFileSync(SOUND_LAB + path);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  };
  const loop = await loopbackAudio({
    register: false,
    preset: { maxLogical: 64, maxMixed: 32, maxBuses: 8, arenaInitialBytes: 1 << 20, clipCeilingBytes: 16 << 20, limiterLookaheadMs: 0, maxBeds: 0, maxZoneSlots: 0, zoneMaxSeconds: 0, maxWide: 0, maxMusicRings: 0 },
    clipRegistry: { fetchBytes, decodeWorker: fakeDecoder(async (b) => parseWav(b)) },
  });
  if (!loop) {
    engine.dispose();
    return null;
  }
  setAudioBackend(loop.backend);
  const rms: number[] = [];
  try {
    const frames = Math.ceil(1.5 / FRAME_SECONDS);
    for (let f = 0; f < frames; f++) {
      if (f === 0) play();
      loop.mainFrame(FRAME_SECONDS);
      const out = loop.render(FRAME_QUANTA);
      for (let q = 0; q < FRAME_QUANTA; q++) {
        let s = 0;
        for (let k = q * QUANTUM; k < (q + 1) * QUANTUM; k++) s += out.left[k]! ** 2;
        rms.push(Math.sqrt(s / QUANTUM));
      }
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  } finally {
    loop.backend.dispose();
    endAudioSession();
    setAudioBackend(null);
    engine.dispose();
    await closeLoopbackAudio();
  }
  return rms;
}

const quantaAt = (s: number) => Math.round((s * RATE) / QUANTUM);

/** A 0.5 s snippet of the idle WAV: heard while it plays, then silent well after its 0.5 s (the whole file is 1.3 s). */
function expectSnippetLength(rms: readonly number[]): void {
  // Heard while the snippet plays (0.5 s of it, from wherever the clip resident starts it)…
  expect(Math.max(...rms.slice(0, quantaAt(0.9)))).toBeGreaterThan(0.02);
  // …and silent well after its 0.5 s have passed.
  const firstHeard = rms.findIndex((x) => x > 1e-3);
  expect(firstHeard).toBeGreaterThanOrEqual(0);
  expect(Math.max(...rms.slice(firstHeard + quantaAt(0.65)))).toBeLessThan(1e-3);
  // …and not cut much short of them.
  let lastHeard = rms.length - 1;
  while (lastHeard > 0 && rms[lastHeard]! <= 1e-3) lastHeard--;
  expect(lastHeard - firstHeard).toBeGreaterThan(quantaAt(0.4));
}

describe("a derived sample heard on the audio core (ADR 0342)", () => {
  const SNIPPET = { "audio/idle.part.sample.json": snippet(IDLE, [0.2, 0.7]) };

  it("the WAV is longer than its snippet", () => {
    expect(audioFileSeconds(new Uint8Array(readFileSync(SOUND_LAB + IDLE)))).toBeGreaterThan(1.2);
  });

  it("a playlist naming a snippet of a WAV sounds for the snippet's length, then goes quiet", { timeout: 60_000 }, async (ctx) => {
    const rms = await heardOnCore({ ...SNIPPET, "audio/part.playlist.json": pla("clip", [sample("audio/idle.part.sample.json")]) }, () => Audio.play("audio/part.playlist.json"));
    if (!rms) return ctx.skip();
    expectSnippetLength(rms);
  });

  it("a one-shot of a snippet of a WAV sounds for the snippet's length, then goes quiet", { timeout: 60_000 }, async (ctx) => {
    const rms = await heardOnCore(SNIPPET, () => Audio.playOneShot("audio/idle.part.sample.json"));
    if (!rms) return ctx.skip();
    expectSnippetLength(rms);
  });
});
