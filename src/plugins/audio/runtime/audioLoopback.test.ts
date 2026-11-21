// api-and-models §8, "Loopback" row: the real wasm with a fake HostClock, through `createLoopbackHost` (testing.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, SceneManager } from "../../../myco";
import { AudioSource } from "./AudioSource";
import { closeLoopbackAudio, createLoopbackHost, loopbackAudio, LOOPBACK_RATE, type LoopbackHost } from "./testing";
import {
  ASAP,
  Kind,
  PLAY_FLAGS_MIXED,
  QUANTUM_FRAMES,
  writeBatchHeader,
  writeClipBegin,
  writeClipChunk,
  writeEnvelope,
  writePlay,
  type Play,
} from "./wire.generated";

const QUANTUM_MS = (QUANTUM_FRAMES / LOOPBACK_RATE) * 1000;
const CLIP_ID = 1;
/** Index 7, generation 1: ids are `(gen << 16) | index` and generation 0 is invalid (api-and-models §3). */
const VOICE_ID = 0x0001_0007;
const CLIP_SECONDS = 0.1;
const CLIP_FRAMES = Math.round(CLIP_SECONDS * LOOPBACK_RATE); // 4800

let seq = 0;
const nextSeq = (): number => seq++;

/** An empty BATCH: envelope, then the 16-byte batch header with no records. */
function emptyBatch(firstFrame: number): ArrayBuffer {
  const buffer = new ArrayBuffer(16 + 16);
  const view = new DataView(buffer);
  writeEnvelope(view, 0, { kind: Kind.BATCH, seq: nextSeq(), bodyBytes: 16 });
  writeBatchHeader(view, 0, { firstFrame, count: 0, flags: 0 });
  return buffer;
}

/** A BATCH of one PLAY record (asap): a mixed voice on bus 0 playing `clip`. */
function playBatch(firstFrame: number, voiceId: number, clip: number): ArrayBuffer {
  const buffer = new ArrayBuffer(16 + 16 + 56);
  const view = new DataView(buffer);
  writeEnvelope(view, 0, { kind: Kind.BATCH, seq: nextSeq(), bodyBytes: 16 + 56 });
  writeBatchHeader(view, 0, { firstFrame, count: 1, flags: 0 });
  const play: Play = {
    voiceId,
    frameOffset: ASAP,
    clip,
    bus: 0,
    flags: PLAY_FLAGS_MIXED,
    group: 0,
    gate: 0,
    gain: 1,
    pitch: 1,
    dirX: 0,
    dirY: 0,
    dirZ: -1,
    lpHz: 24_000,
    score: 0,
    startOffsetFrames: 0,
  };
  writePlay(view, 32, play);
  return buffer;
}

/** A 0.1 s, 440 Hz sine, mono, 48 kHz, f32, sent as CLIP_BEGIN then CLIP_CHUNK (each its own message). */
function loadSineClip(host: LoopbackHost, clipId: number): void {
  const begin = new ArrayBuffer(16 + 20);
  const beginView = new DataView(begin);
  writeEnvelope(beginView, 0, { kind: Kind.CLIP_BEGIN, seq: nextSeq(), bodyBytes: 20 });
  writeClipBegin(beginView, 0, { clipId, frames: CLIP_FRAMES, channels: 1, sampleRate: LOOPBACK_RATE, format: 0 });
  host.send(begin);

  const samples = new Float32Array(CLIP_FRAMES);
  for (let i = 0; i < CLIP_FRAMES; i++) samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / LOOPBACK_RATE);
  const chunk = new ArrayBuffer(16 + 16 + samples.byteLength);
  const chunkView = new DataView(chunk);
  writeEnvelope(chunkView, 0, { kind: Kind.CLIP_CHUNK, seq: nextSeq(), bodyBytes: 16 + samples.byteLength });
  writeClipChunk(chunkView, 0, { clipId, frameOffset: 0, frames: CLIP_FRAMES, reserved: 0 });
  new Float32Array(chunk, 32, CLIP_FRAMES).set(samples);
  host.send(chunk);
}

/** No STATUS post was skipped for an empty pool: consecutive blocks are one cadence apart (6 quanta, or 48 once idle). */
function expectNoSkips(statuses: readonly { readonly currentFrame: number }[]): void {
  for (let i = 1; i < statuses.length; i++) expect([6 * QUANTUM_FRAMES, 48 * QUANTUM_FRAMES]).toContain(statuses[i]!.currentFrame - statuses[i - 1]!.currentFrame);
}

function peak(samples: Float32Array): number {
  let max = 0;
  for (const s of samples) max = Math.max(max, Math.abs(s));
  return max;
}

describe("loopback host: raw BATCH records (runs now)", () => {
  it("a Play record makes a voice play: the render is non-silent and the STATUS block counts the voice", async () => {
    const host = await createLoopbackHost();
    loadSineClip(host, CLIP_ID);
    host.send(playBatch(host.frame, VOICE_ID, CLIP_ID));
    const { left, right } = host.renderQuanta(10);
    expect(Math.max(peak(left), peak(right))).toBeGreaterThan(0.01);
    const last = host.statuses.at(-1)!;
    expect(last.liveVoices).toBeGreaterThanOrEqual(1);
    expect(last.mixedVoices).toBeGreaterThanOrEqual(1);
  });

  it("a voice that reaches the end of its clip appears in STATUS ended within 6 quanta, and liveVoices drops to 0", async () => {
    const host = await createLoopbackHost();
    loadSineClip(host, CLIP_ID);
    host.send(playBatch(host.frame, VOICE_ID, CLIP_ID));
    // The clip ends at frame 4800, inside quantum 37; the next STATUS point is quantum 42 (frame 5376).
    host.renderQuanta(Math.ceil(CLIP_FRAMES / QUANTUM_FRAMES) + 6);
    const ended = host.statuses.find((s) => s.ended.includes(VOICE_ID));
    expect(ended).toBeDefined();
    expect(ended!.currentFrame).toBeLessThanOrEqual(CLIP_FRAMES + 6 * QUANTUM_FRAMES);
    expect(host.statuses.at(-1)!.liveVoices).toBe(0);
  });

  it("status buffers return at once: 10,000 quanta, none skipped, the STATUS pool back at 8", async () => {
    const host = await createLoopbackHost();
    host.renderQuanta(10_000);
    expectNoSkips(host.statuses);
    expect(host.driver.pool.available).toBe(8);
  });

  it("no starvation with frames stopped: an idle host keeps STATUS flowing every 48 quanta", async () => {
    const host = await createLoopbackHost();
    // Past the 250 ms idle threshold (94 quanta), so posts are on the 48-quantum cadence.
    host.renderQuanta(Math.ceil(250 / QUANTUM_MS) + 2);
    const before = host.statuses.length;
    host.renderQuanta(48 * 100);
    const grown = host.statuses.slice(before);
    expect(grown.length).toBeGreaterThanOrEqual(99);
    expect(grown.length).toBeLessThanOrEqual(101);
    for (let i = 1; i < grown.length; i++) {
      expect(grown[i]!.currentFrame - grown[i - 1]!.currentFrame).toBe(48 * QUANTUM_FRAMES);
    }
    expectNoSkips(host.statuses);
  });

  it("no starvation at 20 Hz frames: a batch every 50 ms keeps the 6-quantum cadence and the pool at 8", async () => {
    const host = await createLoopbackHost();
    const quantaPerFrame = 19; // 50 ms of fake time is about 18.75 quanta
    const frames = 40;
    for (let i = 0; i < frames; i++) {
      host.send(emptyBatch(host.frame));
      host.renderQuanta(quantaPerFrame);
    }
    const quanta = frames * quantaPerFrame;
    expect(host.statuses).toHaveLength(Math.floor(quanta / 6));
    for (let i = 1; i < host.statuses.length; i++) {
      expect(host.statuses[i]!.currentFrame - host.statuses[i - 1]!.currentFrame).toBe(6 * QUANTUM_FRAMES);
    }
    expectNoSkips(host.statuses);
    expect(host.driver.pool.available).toBe(8);
  });

  it("a hidden page (clock.setRunning(false), no batches) still receives STATUS", async () => {
    const host = await createLoopbackHost();
    host.clock.setRunning(false);
    const before = host.statuses.length;
    host.renderQuanta(300);
    expect(host.statuses.length - before).toBeGreaterThanOrEqual(5);
    expectNoSkips(host.statuses);
    expect(host.driver.pool.available).toBe(8);
  });
});

// The core backend's own cases live with it: virtual voices promoting (`core/selectionLoopback.test.ts`), REPLAY after a
// rebuild (`core/zonesLoopback.test.ts`, `core/session.contract.test.ts`, `core/musicRecoveryLoopback.test.ts`) and a
// seek's new epoch (`core/streamLoopback.test.ts`, `core/clipSeekLoopback.test.ts`).
describe("loopback host: an AudioSource on the core backend", () => {
  afterEach(async () => {
    await closeLoopbackAudio();
    Assets.clearSources();
    vi.restoreAllMocks();
  });

  it("an AudioSource plays a generated WAV, and its end reaches playing = false", { timeout: 60_000 }, async (ctx) => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, "tone.wav": "data:audio/wav;base64,AAAA" }));
    const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }] } } });
    await SceneManager.load("s.json");
    engine.world.render = {} as never;
    const tone = new Float32Array(CLIP_FRAMES).map((_, i) => 0.25 * Math.sin((2 * Math.PI * 440 * i) / LOOPBACK_RATE));
    const loop = await loopbackAudio({ decode: () => ({ channelData: [tone] }), recovery: { now: () => 0, warn: () => {} } });
    if (!loop) return ctx.skip();
    const source = GameObject.create("Tone").addBehavior(AudioSource, { clip: "asset:tone.wav", playOnAwake: false });
    source.play();
    let heard = 0;
    let frames = 0;
    // Frames of 6 quanta (16 ms) until the source reports it ended; the 0.1 s clip ends within a few.
    for (; frames < 60 && (frames === 0 || source.isPlaying); frames++) {
      loop.tick(0.016);
      const { left } = loop.render(6);
      for (const v of left) heard = Math.max(heard, Math.abs(v));
      for (let k = 0; k < 8; k++) await Promise.resolve();
    }
    expect(heard, "the clip was heard").toBeGreaterThan(0.1);
    expect(source.isPlaying).toBe(false);
    expect(frames).toBeLessThan(60);
    engine.dispose();
  });
});
