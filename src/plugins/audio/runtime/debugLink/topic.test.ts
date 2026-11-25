// The debug link's `audio` topic (plan task A1) through its interface: subscribe, sample into a RecordWriter, request,
// command, dispose. The capture side runs the real `captureLiveHost`, recorder and take on a fake core backend (the
// capture tests' rig); the reassembled head and segments are read back by the live capture decoder a tool uses. The
// upload and mix-op modules (A2, A3) are stood in for, so these cases check what the topic hands them.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRecords, RecordWriter, type LinkRecord } from "../../../../engine/debugLink/records";
import type { DebugSubscription, DebugTopic, DebugTopicHost } from "../../../../engine/debugLink/topics";
import { mixer } from "../../../../engine/audio/mixer";
import { Audio } from "../Audio";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, type FakeBackend } from "../testing";
import { captureDebug, releaseCapture } from "../capture/capture";
import { openLiveCapture } from "../capture/reader";
import { takeFileBytes } from "../capture/take";
import { openTakeFile } from "../capture/takeFile";
import { keyframeCodecForTests, statusBytes, statusBytesWithVoices, type CaptureChunkControl } from "../capture/testSupport";
import { audioTopic } from "./topic";
import { AUDIO_SAMPLE_BYTES, AudioLinkRecord, CAPTURE_PIECE_BYTES, decodeCapturePiece, type CapturePiece } from "./schema";
import type { TakeUploadSource } from "./upload";

const chunk = vi.hoisted((): CaptureChunkControl => ({ options: {}, recorders: [], saveEnv: null }));
vi.mock("../capture/recorder", async (real) => (await import("../capture/testSupport")).captureRecorderModule(await real(), chunk));
vi.mock("../capture/save", async (real) => (await import("../capture/testSupport")).captureSaveModule(await real(), chunk));

/** What the topic handed the upload and mix-op modules. */
const seen = vi.hoisted(() => ({
  sources: [] as unknown[],
  begun: [] as unknown[],
  subscribed: [] as number[],
  disposed: 0,
  mixOps: [] as { params: unknown; target: unknown }[],
}));
vi.mock("./upload", () => ({
  createTakeUploads(source: unknown) {
    seen.sources.push(source);
    return {
      begin: async (params: unknown) => {
        seen.begun.push(params);
        return { upload: 7, bytes: 10, chunks: 1, chunkBytes: 65_000, seconds: 1 };
      },
      subscribe: (upload: number) => {
        seen.subscribed.push(upload);
        return upload === 7 ? { sample() {}, close() {} } : { refused: "not that upload" };
      },
      dispose: () => void seen.disposed++,
    };
  },
}));
vi.mock("./mixCommands", () => ({
  applyMixOpCommand(params: unknown, target: unknown) {
    seen.mixOps.push({ params, target });
    if ((params as { bad?: boolean }).bad) throw new Error("refused op");
    return { ok: true };
  },
}));

const BLOCK = 768;
const RATE = 48_000;
const SECOND = Math.ceil(RATE / BLOCK);
const MiB = 1024 * 1024;

function rig(opts: { voices?: number } = {}) {
  const fb = makeFakeBackend() as FakeBackend & { frame: number };
  fb.frame = 0;
  const baseDebug = fb.debug.bind(fb);
  fb.debug = () => {
    const d = baseDebug();
    return { ...d, time: fb.frame / RATE, sampleRate: RATE, core: { ...d.core, currentFrame: fb.frame } };
  };
  fb.ready = true;
  setAudioBackend(fb);
  chunk.options = { ringBytes: 8 * MiB, codec: keyframeCodecForTests() };
  const feed = (n: number): void => {
    for (let k = 0; k < n; k++) {
      fb.frame += BLOCK;
      const block = opts.voices ? statusBytesWithVoices(fb.frame, opts.voices) : statusBytes(fb.frame);
      const data = block.slice().buffer as ArrayBuffer;
      fb.recorderTap?.(data, block.byteLength, new DataView(data));
    }
  };
  // The topic reads nothing of its host: the take and the capture are the build's own services.
  const topic = audioTopic({} as DebugTopicHost);
  return { fb, feed, topic };
}

afterEach(() => {
  Audio.take.stop();
  releaseCapture();
  chunk.saveEnv = null;
  setAudioBackend(null);
  seen.sources.length = 0;
  seen.begun.length = 0;
  seen.subscribed.length = 0;
  seen.disposed = 0;
  seen.mixOps.length = 0;
});

const settle = (cond: () => boolean) => vi.waitFor(() => expect(cond()).toBe(true));

function subscribe(topic: DebugTopic, params: unknown): DebugSubscription {
  const s = topic.subscribe(params);
  if ("refused" in s) throw new Error(s.refused);
  return s;
}

/** One sample's records, and the sample's size. */
function sampleOnce(sub: DebugSubscription, frame = 1): { records: LinkRecord[]; bytes: number } {
  const out = new RecordWriter();
  sub.sample(out, frame);
  const bytes = out.take();
  const { records, stopped } = readRecords(bytes);
  expect(stopped).toBeNull();
  return { records, bytes: bytes.byteLength };
}

/** Samples until one is empty; every record, each sample's size. */
function drain(sub: DebugSubscription): { records: LinkRecord[]; sizes: number[] } {
  const records: LinkRecord[] = [];
  const sizes: number[] = [];
  for (;;) {
    const s = sampleOnce(sub);
    if (s.records.length === 0) return { records, sizes };
    records.push(...s.records);
    sizes.push(s.bytes);
  }
}

/** The capture records reassembled into parts, in arrival order, checking each part's pieces run 0..count-1. */
function parts(records: LinkRecord[]): { type: number; part: number; count: number; bytes: Uint8Array }[] {
  const out: { type: number; part: number; count: number; bytes: Uint8Array }[] = [];
  let open: { type: number; pieces: CapturePiece[] } | null = null;
  for (const r of records) {
    if (r.type === AudioLinkRecord.captureLost) continue;
    const p = decodeCapturePiece(r.payload);
    if ("refused" in p) throw new Error(p.refused);
    if (!open) open = { type: r.type, pieces: [] };
    expect(p.index, "pieces arrive in order").toBe(open.pieces.length);
    expect(r.type).toBe(open.type);
    open.pieces.push({ ...p, bytes: p.bytes.slice() });
    if (open.pieces.length === p.count) {
      const total = open.pieces.reduce((n, q) => n + q.bytes.byteLength, 0);
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const q of open.pieces) {
        bytes.set(q.bytes, at);
        at += q.bytes.byteLength;
      }
      out.push({ type: open.type, part: p.part, count: p.count, bytes });
      open = null;
    }
  }
  expect(open, "no part is left half sent").toBeNull();
  return out;
}

describe("the audio topic", () => {
  it("serves on the reliable channel and refuses what it doesn't serve", () => {
    const { topic } = rig();
    expect(topic.channel).toBe("reliable");
    expect(topic.subscribe({ kind: "frames" })).toEqual({ refused: 'the audio topic has no "frames" subscription (capture, upload, take or takeLive)' });
    expect(topic.subscribe({ kind: "upload" })).toMatchObject({ refused: expect.stringContaining("upload's id") });
    expect(() => topic.command!("mute", {})).toThrow('The audio topic has no "mute" command.');
    return expect(topic.request!("take.pause", {})).rejects.toThrow('The audio topic has no "take.pause" request.');
  });
});

describe("the capture subscription", () => {
  it("joins the ring as an owner and sends the head, then each sealed segment in order, which a live decoder reads", async () => {
    const r = rig();
    const sub = subscribe(r.topic, { kind: "capture" });
    expect(sampleOnce(sub).records, "nothing before the ring is joined").toEqual([]);
    await settle(() => captureDebug() !== null);
    expect(captureDebug()).toMatchObject({ state: "recording", owners: 1 });
    expect(Audio.capture.state, "the link's hold isn't a take").toBe("idle");
    r.feed(3 * SECOND + 5); // three segments seal
    const { records } = drain(sub);
    expect(records.map((x) => x.seq)).toEqual(records.map((_, i) => i));
    const ps = parts(records);
    expect(ps.map((p) => p.type)).toEqual([AudioLinkRecord.captureHead, AudioLinkRecord.captureSegment, AudioLinkRecord.captureSegment, AudioLinkRecord.captureSegment]);
    expect(ps.map((p) => p.part)).toEqual([0, 1, 2, 3]);
    const decoder = openLiveCapture(ps[0]!.bytes);
    for (const seg of ps.slice(1)) decoder.appendRecords(seg.bytes);
    expect(decoder.contents.warnings).toEqual([]);
    expect(decoder.contents.keyframes.length).toBe(3);
    // More segments arrive on later samples, continuing the order.
    r.feed(SECOND);
    const later = parts(drain(sub).records);
    expect(later.map((p) => p.part)).toEqual([4]);
    decoder.appendRecords(later[0]!.bytes);
    expect(decoder.contents.warnings).toEqual([]);
    sub.close();
  });

  it("splits a segment past one message into CAPTURE_PIECE_BYTES pieces, and no sample passes AUDIO_SAMPLE_BYTES", async () => {
    const r = rig({ voices: 1024 }); // ≈ 6.6 KB a STATUS block: a one-second segment is ≈ 400 KB
    const sub = subscribe(r.topic, { kind: "capture" });
    await settle(() => captureDebug() !== null);
    r.feed(2 * SECOND + 5);
    const { records, sizes } = drain(sub);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(AUDIO_SAMPLE_BYTES);
    const ps = parts(records);
    const segments = ps.filter((p) => p.type === AudioLinkRecord.captureSegment);
    expect(segments.length).toBe(2);
    for (const seg of segments) {
      expect(seg.count).toBe(Math.ceil(seg.bytes.byteLength / CAPTURE_PIECE_BYTES));
      expect(seg.count).toBeGreaterThan(1);
    }
    // Every piece but each part's last is full.
    for (const rec of records) {
      const p = decodeCapturePiece(rec.payload) as CapturePiece;
      if (p.index < p.count - 1) expect(p.bytes.byteLength).toBe(CAPTURE_PIECE_BYTES);
    }
    const decoder = openLiveCapture(ps[0]!.bytes);
    for (const seg of segments) decoder.appendRecords(seg.bytes);
    expect(decoder.contents.warnings).toEqual([]);
    sub.close();
  });

  it("packs small pieces into one sample while they fit", async () => {
    const r = rig();
    const sub = subscribe(r.topic, { kind: "capture" });
    await settle(() => captureDebug() !== null);
    r.feed(2 * SECOND + 5); // the head and two small segments: one sample holds them all
    const first = sampleOnce(sub);
    expect(first.records.map((x) => x.type)).toEqual([AudioLinkRecord.captureHead, AudioLinkRecord.captureSegment, AudioLinkRecord.captureSegment]);
    expect(sampleOnce(sub).records).toEqual([]);
    sub.close();
  });

  it("closing with no take ends the hold and frees the ring", async () => {
    const r = rig();
    const sub = subscribe(r.topic, { kind: "capture" });
    await settle(() => captureDebug() !== null);
    r.feed(SECOND + 5);
    sub.close();
    expect(captureDebug()).toBeNull();
    expect(r.fb.recorderTap).toBeNull();
    r.feed(SECOND);
    expect(sampleOnce(sub).records, "nothing after close").toEqual([]);
  });

  it("closing with a take running keeps the ring for the take", async () => {
    const r = rig();
    await Audio.take.start();
    const sub = subscribe(r.topic, { kind: "capture" });
    await settle(() => (captureDebug()?.owners ?? 0) === 2);
    r.feed(SECOND + 5);
    sub.close();
    expect(captureDebug()).toMatchObject({ state: "recording", owners: 1 });
    expect(Audio.take.state).toBe("recording");
  });

  it("closing before the ring is joined releases the hold once the join lands", async () => {
    const r = rig();
    const sub = subscribe(r.topic, { kind: "capture" });
    sub.close();
    // A later owner's join loads the chunk too; once it settles the closed subscription holds nothing.
    await Audio.capture.start();
    expect(captureDebug()).toMatchObject({ owners: 1 });
    Audio.capture.stop();
    r.feed(1);
    expect(sampleOnce(sub).records).toEqual([]);
  });

  it("ends the feed with one captureLost record when the ring can't be joined", async () => {
    setAudioBackend(null);
    const topic = audioTopic({} as DebugTopicHost);
    const sub = subscribe(topic, { kind: "capture" });
    let records: LinkRecord[] = [];
    await vi.waitFor(() => {
      records = sampleOnce(sub).records;
      expect(records.length).toBeGreaterThan(0);
    });
    expect(records.map((x) => x.type)).toEqual([AudioLinkRecord.captureLost]);
    expect(sampleOnce(sub).records).toEqual([]);
    sub.close();
  });
});

describe("take control", () => {
  it("take.start, take.mark and take.stop drive Audio.take and answer its state", async () => {
    const r = rig();
    await expect(r.topic.request!("take.start", undefined)).resolves.toMatchObject({ state: "recording", seconds: expect.any(Number) });
    r.feed(SECOND);
    await expect(r.topic.request!("take.mark", { text: "boss" })).resolves.toMatchObject({ state: "recording" });
    r.feed(SECOND);
    const stopped = (await r.topic.request!("take.stop", undefined)) as { state: string; seconds: number };
    expect(stopped.state).toBe("stopped");
    expect(stopped.seconds, "the take's own length, kept once stopped").toBe(Audio.take.seconds);
    expect(Audio.take.state).toBe("stopped");
    // The mark is in the take a tool would upload.
    const { take } = await openTakeFile(await takeFileBytes());
    expect(take.requests.filter((q) => q.kind === "mark")).toHaveLength(1);
  });

  it("take.mark needs text", async () => {
    const r = rig();
    await expect(r.topic.request!("take.mark", {})).rejects.toThrow("take.mark needs the marker's text");
    await expect(r.topic.request!("take.mark", { text: 3 })).rejects.toThrow("take.mark needs the marker's text");
  });

  it("take.stop with no take answers idle", async () => {
    const r = rig();
    await expect(r.topic.request!("take.stop", undefined)).resolves.toEqual({ state: Audio.take.state, seconds: Audio.take.seconds });
  });

  it("take.start answers an error when the core can't record", async () => {
    setAudioBackend(null);
    const topic = audioTopic({} as DebugTopicHost);
    await expect(topic.request!("take.start", undefined)).rejects.toThrow();
  });
});

describe("uploads and mix ops", () => {
  it("take.upload and upload subscriptions go to one createTakeUploads, whose source is the build's take; dispose drops it", async () => {
    const r = rig();
    expect(seen.sources, "made on first use, not with the topic").toHaveLength(0);
    await expect(r.topic.request!("take.upload", {})).resolves.toMatchObject({ upload: 7 });
    expect(seen.begun).toEqual([{}]);
    expect(r.topic.subscribe({ kind: "upload", upload: 7 })).toHaveProperty("sample");
    expect(r.topic.subscribe({ kind: "upload", upload: 8 })).toEqual({ refused: "not that upload" });
    expect(seen.subscribed).toEqual([7, 8]);
    expect(seen.sources).toHaveLength(1);
    // The source reads the build's take: its seconds, and its bytes (the take file Audio.take.save writes).
    const source = seen.sources[0] as TakeUploadSource;
    await Audio.take.start();
    r.feed(SECOND);
    Audio.take.mark("upload me");
    Audio.take.stop();
    expect(source.seconds()).toBe(Audio.take.seconds);
    const { take } = await openTakeFile(await source.bytes({}));
    expect(take.requests.filter((q) => q.kind === "mark")).toHaveLength(1);
    r.topic.dispose!();
    expect(seen.disposed).toBe(1);
  });

  it("mix.op goes to applyMixOpCommand with the live mixer; its refusal is the command's error", () => {
    const r = rig();
    const params = { op: 1, class: 0, words: [], names: [], buses: [] };
    r.topic.command!("mix.op", params);
    expect(seen.mixOps).toEqual([{ params, target: mixer }]);
    expect(() => r.topic.command!("mix.op", { bad: true })).toThrow("refused op");
  });
});
