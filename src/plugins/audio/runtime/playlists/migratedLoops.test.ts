// ADR 0342, 0343: an old looping clip, migrated in memory (`migrateProjectAudioEvents`), keeps sounding past one pass of
// its sample on the real audio core. The first mapping made a looping clip an async clip in a looping Sequence; an async
// clip plays its sample once on the core, so a migrated engine went silent after one pass until the playhead re-entered
// the clip (gaps of about 750 ms in the Sound Lab). The migration now puts the loop in the sample's sidecar and the clip
// plays it. Played through the real playlist runtime and the real `CoreBackend` on the loopback host (the committed
// wasm), with the Sound Lab's WAVs (samples/sound-lab), measuring the output per quantum (128 frames).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { audioFileSeconds } from "../../../../engine/audio/migrate/audioDuration";
import { migrateProjectAudioEvents } from "../../../../engine/audio/migrate";
import { setAudioBackend, type AudioEventHandle } from "../backend";
import { Audio } from "../index";
import { fakeDecoder, type PlanarClip } from "../core/fakeDecoder";
import { endAudioSession, loopbackAudio, closeLoopbackAudio } from "../testing";

const SAMPLE = fileURLToPath(new URL("../../../../../samples/sound-lab/", import.meta.url));
const RATE = 48_000;
const QUANTUM = 128;
const FRAME_QUANTA = 4;
const FRAME_SECONDS = (FRAME_QUANTA * QUANTUM) / RATE;
const QUANTUM_MS = (QUANTUM / RATE) * 1000;
/** A quantum quieter than this (RMS, about -60 dBFS) counts as silence. */
const SILENT = 1e-3;

const IDLE = "audio/events/engine-idle.wav"; // 1.3 s
const SINGLE = "audio/events/engine-single.wav"; // 2.5 s

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
const decode = fakeDecoder(async (b) => parseWav(b));
const fetchBytes = async (path: string) => {
  const b = readFileSync(SAMPLE + path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

/** The old events, migrated as `npm run audio:migrate` would (lengths from the WAV headers): every file it writes. */
function migrated(events: Record<string, unknown>): Record<string, unknown> {
  const texts = new Map(Object.entries(events).map(([p, root]) => [p, JSON.stringify({ format: "myco.audioevent@1", bus: "Engine", root })]));
  const out = migrateProjectAudioEvents(texts, { sampleSeconds: (p) => audioFileSeconds(new Uint8Array(readFileSync(SAMPLE + p))) });
  return Object.fromEntries([...out.writes].map(([p, text]) => [p, JSON.parse(text)]));
}

/** Plays `playlist` for `frames` frames (releasing it at `releaseAt`) and returns the RMS of each quantum. */
async function render(assets: Record<string, unknown>, playlist: string, frames: number, releaseAt = Infinity): Promise<number[] | null> {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  endAudioSession();
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, [IDLE]: "data:,", [SINGLE]: "data:,", ...assets }));
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }, { name: "Engine", parent: "Master" }], seed: 7, backend: "core" } } });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
  const loop = await loopbackAudio({
    register: false,
    preset: { maxLogical: 64, maxMixed: 32, maxBuses: 8, arenaInitialBytes: 1 << 20, clipCeilingBytes: 16 << 20, limiterLookaheadMs: 0, maxBeds: 0, maxZoneSlots: 0, zoneMaxSeconds: 0, maxWide: 0, maxMusicRings: 0 },
    clipRegistry: { fetchBytes, decodeWorker: decode },
  });
  if (!loop) {
    engine.dispose();
    return null;
  }
  setAudioBackend(loop.backend);
  const rms: number[] = [];
  let h!: AudioEventHandle;
  try {
    for (let f = 0; f < frames; f++) {
      if (f === 0) h = Audio.play(playlist, { bus: "Engine" });
      if (f === releaseAt) h.release();
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
  }
  return rms;
}

/** The longest run of silent quanta, in ms, between quanta `from` and `to`. */
function longestGapMs(rms: readonly number[], from: number, to = rms.length): number {
  let run = 0;
  let worst = 0;
  for (let i = from; i < to; i++) {
    run = rms[i]! < SILENT ? run + 1 : 0;
    worst = Math.max(worst, run);
  }
  return worst * QUANTUM_MS;
}

const quantaAt = (seconds: number) => Math.round((seconds * 1000) / QUANTUM_MS);
const framesFor = (seconds: number) => Math.ceil(seconds / FRAME_SECONDS);

afterEach(() => {
  vi.restoreAllMocks();
});
afterEach(closeLoopbackAudio);

describe("migrated looping clips keep sounding on the audio core (ADR 0342, 0343)", () => {
  it("a looping clip with a loop region sounds without a gap for three passes of its sample", { timeout: 60_000 }, async (ctx) => {
    const assets = migrated({ "audio/hum.audioevent.json": { type: "clip", clip: IDLE, loop: true, loopRegion: [0.15, 1.15] } });
    const rms = await render(assets, "audio/hum.playlist.json", framesFor(4));
    if (!rms) return ctx.skip();
    // 1.3 s of sample: after its first pass the old mapping went silent until the playhead re-entered the clip.
    expect(Math.max(...rms.slice(quantaAt(0.1), quantaAt(0.5)))).toBeGreaterThan(0.05);
    expect(longestGapMs(rms, quantaAt(0.1), quantaAt(3.9))).toBeLessThan(10);
  });

  it("a sustain clip holds its loop past its sample's length until release, then plays its tail and ends", { timeout: 60_000 }, async (ctx) => {
    const assets = migrated({ "audio/run.audioevent.json": { type: "clip", clip: SINGLE, sustain: true, loopRegion: [0.5, 1.5] } });
    const rms = await render(assets, "audio/run.playlist.json", framesFor(7), framesFor(4));
    if (!rms) return ctx.skip();
    // Held for 4 s (the sample is 2.5 s long): no gap; after release the pass finishes, the 1 s tail plays and it ends.
    expect(longestGapMs(rms, quantaAt(0.1), quantaAt(4))).toBeLessThan(10);
    expect(Math.max(...rms.slice(quantaAt(6.5)))).toBeLessThan(SILENT);
  });
});
