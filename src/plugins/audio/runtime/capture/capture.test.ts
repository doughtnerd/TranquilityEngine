// ADR 0171 amended by 0172 (M5a, K0 then Rc4; api-and-models §1.2, architecture §2.1, §3.7): `Audio.capture`. A game that
// never calls `start()` loads no recorder (the loader is never called and no source imports the chunk statically); a start
// loads it once, begins a take over the shared ring, `stop` holds the ring, a start from Held begins a new take after a GAP,
// `mark` writes a marker, `save` writes the latest take (web download and Tauri `Storage`, against fakes), and the Profiler
// panel's `LiveHost` is an owner distinct from a take. Timing is the STATUS frames the tests feed, never a wall clock.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Audio } from "../Audio";
import { setAudioBackend } from "../backend";
import { NULL_PROFILE_SINK } from "../mix/profileSink";
import { makeFakeBackend, type FakeBackend } from "../testing";
import { _setRecorderLoader, _setSaveEnv, captureDebug, captureLiveHost, captureOwners, NOTHING_RECORDED, releaseCapture, setCaptureProject, type CaptureLiveHost, type RecorderModule } from "./capture";
import {
  CAPTURE_FLAG_COMPRESSED, CAPTURE_FLAG_MAIN_SIDE_ONLY, CAPTURE_MARKER_MAX_BYTES, EpochReason, GapReason, RecordType, assembleCapture, readCaptureHeader,
} from "./format";
import { decodeRecordAt, openCapture, openLiveCapture, type CaptureContents } from "./reader";
import type { Recorder } from "./recorder";
import { _resetSaveState, deflateRawCompress, type SaveEnv } from "./save";
import { SAMPLE_HEADER, SAMPLE_META, keyframeCodecForTests, statusBytes, statusBytesWithVoices } from "./testSupport";

const SRC = join(__dirname, "../../../..");
const MiB = 1024 * 1024;
const BLOCK = 768;
const RATE = 48_000;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|bench)\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** Everything a case needs: a fake core backend that reports a frame, a loader that counts, a save environment of fakes. */
function rig(opts: { ringBytes?: number; tauri?: boolean } = {}) {
  const fb = makeFakeBackend() as FakeBackend & { frame: number };
  fb.frame = 0;
  const baseDebug = fb.debug.bind(fb);
  fb.debug = () => {
    const d = baseDebug();
    return { ...d, time: fb.frame / RATE, sampleRate: RATE, core: { ...d.core, currentFrame: fb.frame } };
  };
  setAudioBackend(fb);
  const recorders: Recorder[] = [];
  const loads = vi.fn(async (): Promise<RecorderModule> => {
    const m = await import("./recorder");
    return { ...m, createRecorder: (o) => { const r = m.createRecorder({ ringBytes: opts.ringBytes ?? 4 * MiB, codec: keyframeCodecForTests(), ...o }); recorders.push(r); return r; } };
  });
  _setRecorderLoader(loads);
  const downloads: { bytes: Uint8Array; fileName: string }[] = [];
  const saved: { key: string; bytes: Uint8Array }[] = [];
  const env: SaveEnv = {
    tauri: opts.tauri ?? false,
    storage: { save: async (key, value) => void saved.push({ key, bytes: value as Uint8Array }), list: async () => saved.map((s) => s.key), delete: async () => {} },
    appDataDir: async () => "/data/app",
    download: (bytes, fileName) => void downloads.push({ bytes, fileName }),
    compress: deflateRawCompress,
    now: () => new Date(2026, 10, 13, 10, 15, 0),
  };
  _setSaveEnv(env);
  /** `n` STATUS blocks through the tap the backend holds now (none while Held: nothing records). */
  const feed = (n: number, voices = 0): void => {
    for (let k = 0; k < n; k++) {
      fb.frame += BLOCK;
      const block = voices > 0 ? statusBytesWithVoices(fb.frame, voices) : statusBytes(fb.frame);
      const data = block.slice().buffer as ArrayBuffer;
      fb.recorderTap?.(data, block.byteLength, new DataView(data));
    }
  };
  const open = async (bytes: Uint8Array): Promise<CaptureContents> => openCapture(bytes);
  const types = (c: CaptureContents): number[] => Array.from(c.records.type.subarray(0, c.records.count));
  return { fb, loads, recorders, downloads, saved, env, feed, open, types };
}

/** Blocks for one second of rendered frames. */
const SECOND = Math.ceil(RATE / BLOCK);

function framesOf(c: CaptureContents): number[] {
  const out: number[] = [];
  for (let i = 0; i < c.records.count; i++) if (c.records.type[i] === RecordType.STATUS) out.push(c.records.frame[i]!);
  return out;
}

let restoreLoader: (() => Promise<RecorderModule>) | null = null;

beforeEach(() => {
  _resetSaveState();
  restoreLoader = null;
});

afterEach(() => {
  releaseCapture();
  if (restoreLoader) _setRecorderLoader(restoreLoader);
  _setSaveEnv(null);
  setAudioBackend(null);
  vi.restoreAllMocks();
});

describe("Audio.capture: a game that never calls start loads no recorder", () => {
  it("never calls the chunk loader, and every member answers as idle", async () => {
    const r = rig();
    restoreLoader = r.loads;
    const capture = Audio.capture;
    expect(capture.state).toBe("idle");
    expect(capture.seconds).toBe(0);
    expect(capture.bytes).toBe(0);
    expect(capture.truncated).toBe(false);
    capture.mark("no ring");
    capture.stop();
    await expect(capture.save("take")).rejects.toThrow(NOTHING_RECORDED);
    expect(captureDebug()).toBeNull();
    expect(captureOwners()).toEqual({ take: false, panels: 0 });
    expect(r.loads).not.toHaveBeenCalled();
    expect(r.fb.recorderTap).toBeNull();
    expect(r.fb.profileSink).toBeNull();
  });

  it("start() is what loads the chunk, once: a second start, a stop and a restart load nothing more", async () => {
    const r = rig();
    await Audio.capture.start();
    expect(r.loads).toHaveBeenCalledTimes(1);
    await Audio.capture.start();
    Audio.capture.stop();
    await Audio.capture.start();
    expect(r.loads).toHaveBeenCalledTimes(1);
    expect(r.recorders.length).toBe(1);
  });

  it("no runtime source imports capture/recorder statically (only capture.ts, through import())", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      // A static import or re-export naming the recorder module (any relative spelling).
      if (/^\s*(import|export)\b[^;]*from\s+["'][^"']*capture\/recorder["']/m.test(text) || /^\s*(import|export)\b[^;]*from\s+["']\.\/recorder["']/m.test(text) && file.includes(`${sep}capture${sep}`)) {
        offenders.push(relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("capture.ts reaches the rest of the chunk (events, save, ring, format) only as types or by import()", () => {
    const text = readFileSync(join(__dirname, "capture.ts"), "utf8");
    const staticValueImports = text.split("\n").filter((l) => /^\s*(import|export)\b(?!\s+type\b)/.test(l) && /from\s+["']\.\/(recorder|events|save|ring|format|reader|worker)["']/.test(l));
    expect(staticValueImports).toEqual([]);
    expect(text).toMatch(/import\("\.\/recorder"\)/);
    expect(text).toMatch(/import\("\.\/save"\)/);
    expect(text).toMatch(/import\("\.\/events"\)/);
  });
});

describe("start, stop, mark and save", () => {
  it("start loads, writes EPOCH start and a KEYFRAME, takes the tap and the sink; state is loading, then recording", async () => {
    const r = rig();
    const started = Audio.capture.start();
    expect(Audio.capture.state, "the chunk is loading").toBe("loading");
    expect(r.fb.recorderTap, "nothing records before the ring exists").toBeNull();
    await started;
    expect(Audio.capture.state).toBe("recording");
    expect(r.fb.recorderTap).toBeTypeOf("function");
    expect(r.fb.profileSink).not.toBeNull();
    expect(captureOwners()).toEqual({ take: true, panels: 0 });
    expect(captureDebug()).toMatchObject({ state: "recording", owners: 1 });
    r.feed(2 * SECOND);
    expect(Audio.capture.seconds).toBeGreaterThan(1.5);
    expect(Audio.capture.bytes).toBeGreaterThan(0);
    expect(Audio.capture.truncated).toBe(false);
    await Audio.capture.save("first");
    const c = await r.open(r.downloads[0]!.bytes);
    expect(c.warnings).toEqual([]);
    expect(r.types(c).slice(0, 2)).toEqual([RecordType.EPOCH, RecordType.KEYFRAME]);
    const epoch = decodeRecordAt(c, 0);
    expect(epoch.kind === "epoch" && epoch.payload.reason).toBe(EpochReason.start);
    expect(epoch.kind === "epoch" && epoch.payload.sampleRate).toBe(RATE);
    expect(framesOf(c).length).toBe(2 * SECOND);
  });

  it("stop holds the ring: the tap and the sink are removed, the take stays savable, nothing more is recorded", async () => {
    const r = rig();
    await Audio.capture.start();
    r.feed(SECOND);
    Audio.capture.stop();
    expect(Audio.capture.state).toBe("stopped");
    expect(r.fb.recorderTap).toBeNull();
    expect(r.fb.profileSink, "the null object is the backend's own when the sink goes").toBeNull();
    expect(NULL_PROFILE_SINK).toBeTruthy();
    expect(captureDebug()).toMatchObject({ state: "held", owners: 0 });
    const before = Audio.capture.bytes;
    r.feed(SECOND); // the tap is gone: these blocks go nowhere
    expect(Audio.capture.bytes).toBe(before);
    await Audio.capture.save();
    const c = await r.open(r.downloads[0]!.bytes);
    expect(framesOf(c).length).toBe(SECOND);
    expect(Audio.capture.state, "saving doesn't end the take").toBe("stopped");
    await Audio.capture.save("again");
    expect(r.downloads.length).toBe(2);
  });

  it("a second start while recording joins it: it resolves at once and writes a marker, no second take or load", async () => {
    const r = rig();
    await Audio.capture.start();
    r.feed(5);
    await Audio.capture.start();
    expect(r.loads).toHaveBeenCalledTimes(1);
    expect(captureOwners()).toEqual({ take: true, panels: 0 });
    await Audio.capture.save();
    const c = await r.open(r.downloads[0]!.bytes);
    const markers = r.types(c).flatMap((t, i) => (t === RecordType.MARKER ? [decodeMarker_(c, i)] : []));
    expect(markers).toEqual(["Audio.capture.start"]);
  });

  it("two starts during the load share it: one load, one ring, both resolve recording", async () => {
    const r = rig();
    const a = Audio.capture.start();
    const b = Audio.capture.start();
    await Promise.all([a, b]);
    expect(r.loads).toHaveBeenCalledTimes(1);
    expect(r.recorders.length).toBe(1);
    expect(Audio.capture.state).toBe("recording");
    expect(captureOwners()).toEqual({ take: true, panels: 0 });
  });

  it("mark writes a MARKER at the current frame, cut to 120 UTF-8 bytes on a character boundary; before a ring it is a no-op", async () => {
    const r = rig();
    Audio.capture.mark("too early");
    await Audio.capture.start();
    r.feed(10);
    Audio.capture.mark("drop #1");
    Audio.capture.mark("é".repeat(100)); // 200 bytes
    await Audio.capture.save();
    const c = await r.open(r.downloads[0]!.bytes);
    const texts = r.types(c).flatMap((t, i) => (t === RecordType.MARKER ? [decodeMarker_(c, i)] : []));
    expect(texts[0]).toBe("drop #1");
    expect(new TextEncoder().encode(texts[1]!).byteLength).toBeLessThanOrEqual(CAPTURE_MARKER_MAX_BYTES);
    expect(texts[1]).toBe("é".repeat(60));
    expect(texts.length).toBe(2);
    const marker = c.records.type.findIndex((t) => t === RecordType.MARKER);
    expect(c.records.frame[marker], "at the newest STATUS frame").toBe(10 * BLOCK);
  });

  it("mark after stop writes nothing (no ring runs for this owner)", async () => {
    const r = rig();
    await Audio.capture.start();
    r.feed(5);
    Audio.capture.stop();
    Audio.capture.mark("late");
    await Audio.capture.save();
    const c = await r.open(r.downloads[0]!.bytes);
    expect(r.types(c)).not.toContain(RecordType.MARKER);
  });

  it("save with no take rejects with the message, before any start and after the ring was released", async () => {
    const r = rig();
    await expect(Audio.capture.save()).rejects.toThrow("nothing recorded: call Audio.capture.start() first");
    await Audio.capture.start();
    r.feed(5);
    Audio.capture.stop();
    releaseCapture();
    expect(Audio.capture.state).toBe("idle");
    await expect(Audio.capture.save()).rejects.toThrow(NOTHING_RECORDED);
    expect(r.downloads).toEqual([]);
  });

  it("start rejects with a message while the core isn't there (a pending or absent backend), and leaves state idle", async () => {
    const r = rig();
    delete (r.fb as { recorderTap?: unknown }).recorderTap;
    await expect(Audio.capture.start()).rejects.toThrow(/audio core/);
    expect(Audio.capture.state).toBe("idle");
    expect(r.loads).not.toHaveBeenCalled();
    expect(captureDebug()).toBeNull();
  });

  it("start rejects with the chunk's error when the recorder can't load, and works once it can", async () => {
    const r = rig();
    _setRecorderLoader(() => Promise.reject(new Error("chunk failed to load")));
    await expect(Audio.capture.start()).rejects.toThrow("chunk failed to load");
    expect(Audio.capture.state).toBe("idle");
    expect(captureOwners()).toEqual({ take: false, panels: 0 });
    _setRecorderLoader(r.loads);
    await Audio.capture.start();
    expect(Audio.capture.state).toBe("recording");
  });

  it("stop while the chunk loads abandons the start: no take, no tap, no ring; start resolves", async () => {
    const r = rig();
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    _setRecorderLoader(async () => {
      await gate;
      return r.loads();
    });
    const started = Audio.capture.start();
    expect(Audio.capture.state).toBe("loading");
    Audio.capture.stop();
    release();
    await started;
    expect(Audio.capture.state).toBe("idle");
    expect(r.fb.recorderTap).toBeNull();
    expect(r.fb.profileSink).toBeNull();
    expect(captureDebug()).toBeNull();
    await expect(Audio.capture.save()).rejects.toThrow(NOTHING_RECORDED);
  });

  it("the Babylon fallback (no recorder tap, capture mainSideOnly) records main-side events and says so in the header", async () => {
    const r = rig();
    delete (r.fb as { recorderTap?: unknown }).recorderTap;
    r.fb.mixCaps = { ...r.fb.mixCaps, capture: "mainSideOnly" };
    await Audio.capture.start();
    expect(Audio.capture.state).toBe("recording");
    Audio.capture.mark("main side");
    Audio.capture.stop();
    await Audio.capture.save();
    const bytes = r.downloads[0]!.bytes;
    expect(readCaptureHeader(bytes).flags & CAPTURE_FLAG_MAIN_SIDE_ONLY).toBeTruthy();
    const c = await r.open(bytes);
    expect(c.mainSideOnly).toBe(true);
    expect(r.types(c)).toContain(RecordType.MARKER);
    expect(r.types(c)).not.toContain(RecordType.STATUS);
  });
});

/** A live decoder over the first recorder's whole ring (records the take's file leaves out are in it). */
function wholeRing(r: ReturnType<typeof rig>): CaptureContents {
  const d = openLiveCapture(assembleCapture({ ...SAMPLE_HEADER, sampleRate: RATE }, SAMPLE_META, []));
  d.appendRecords(r.recorders[0]!.ring.copyRecords(0).bytes);
  return d.contents;
}

/** The text of marker record `i`. */
function decodeMarker_(c: CaptureContents, i: number): string {
  const rec = decodeRecordAt(c, i);
  return rec.kind === "marker" ? rec.payload.text : "";
}

describe("save: the web Blob and the Tauri Storage paths, deflate-raw or stored", () => {
  it("on the web it downloads a deflate-raw file named from the sanitised name and resolves with the file name", async () => {
    const r = rig();
    await Audio.capture.start();
    r.feed(2 * SECOND);
    const name = await Audio.capture.save("my take / 1");
    expect(name).toBe("my_take_1.mycap");
    expect(r.downloads.map((d) => d.fileName)).toEqual(["my_take_1.mycap"]);
    expect(r.saved).toEqual([]);
    const h = readCaptureHeader(r.downloads[0]!.bytes);
    expect(h.flags & CAPTURE_FLAG_COMPRESSED).toBeTruthy();
    expect((await r.open(r.downloads[0]!.bytes)).warnings).toEqual([]);
  });

  it("an absent name is capture-YYYYMMDD-HHMMSS.mycap", async () => {
    const r = rig();
    await Audio.capture.start();
    r.feed(3);
    expect(await Audio.capture.save()).toBe("capture-20261113-101500.mycap");
  });

  it("on Tauri it saves through Storage into cache and resolves with the app-data path", async () => {
    const r = rig({ tauri: true });
    await Audio.capture.start();
    r.feed(SECOND);
    const path = await Audio.capture.save("arena");
    expect(path).toBe("/data/app/cache/arena.mycap.bin");
    expect(r.saved.map((s) => s.key)).toEqual(["arena.mycap"]);
    expect(r.downloads).toEqual([]);
    expect((await r.open(r.saved[0]!.bytes)).warnings).toEqual([]);
  });

  it("without a CompressionStream the file is stored raw and still opens", async () => {
    const r = rig();
    vi.stubGlobal("CompressionStream", undefined);
    try {
      await Audio.capture.start();
      r.feed(SECOND);
      await Audio.capture.save("raw");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(readCaptureHeader(r.downloads[0]!.bytes).flags & CAPTURE_FLAG_COMPRESSED).toBe(0);
    expect((await r.open(r.downloads[0]!.bytes)).warnings).toEqual([]);
  });

  it("save while recording writes up to the call; the take goes on and a later save has more", async () => {
    const r = rig();
    await Audio.capture.start();
    r.feed(SECOND);
    const saving = Audio.capture.save("a"); // the span is copied now
    r.feed(SECOND);
    await saving;
    await Audio.capture.save("b");
    const a = framesOf(await r.open(r.downloads[0]!.bytes));
    const b = framesOf(await r.open(r.downloads[1]!.bytes));
    expect(a.length).toBe(SECOND);
    expect(b.length).toBe(2 * SECOND);
    expect(Audio.capture.state).toBe("recording");
  });

  it("META carries the project, the audio section, the target and the names; a name the sink interned is in META and in a NAMES record", async () => {
    const r = rig();
    setCaptureProject(() => ({ name: "Sound Lab", version: "1.2.3" }));
    try {
      await Audio.capture.start();
      r.feed(5);
      r.fb.profileSink!.voiceStart(1, "audio/jump.wav", 0, 0, 0, 1);
      r.feed(5);
      await Audio.capture.save();
    } finally {
      setCaptureProject(() => ({ name: "", version: "" }));
    }
    const c = await r.open(r.downloads[0]!.bytes);
    expect(c.meta.project).toEqual({ name: "Sound Lab", version: "1.2.3" });
    expect(c.meta.engine).toBe("myco");
    expect(c.meta.audio).toBeTypeOf("object");
    expect([...c.meta.names.clips.values()]).toContain("audio/jump.wav");
    expect(r.types(c)).toContain(RecordType.NAMES);
  });
});

describe("Held: a start from Held begins a new take after a GAP", () => {
  it("writes GAP held and a fresh keyframe; the file holds the new take only, the ring keeps the old one", async () => {
    const r = rig();
    await Audio.capture.start();
    r.feed(2 * SECOND);
    Audio.capture.stop();
    const firstTakeEnd = r.fb.frame;
    r.fb.frame += 10 * SECOND * BLOCK; // time passes, nothing recorded
    await Audio.capture.start();
    expect(r.loads, "the chunk and the ring are reused").toHaveBeenCalledTimes(1);
    expect(r.fb.recorderTap).toBeTypeOf("function");
    r.feed(SECOND);
    await Audio.capture.save("second");
    const take = await r.open(r.downloads[0]!.bytes);
    expect(take.warnings).toEqual([]);
    // The new take starts at its own keyframe: no EPOCH, no frame of the first take.
    expect(r.types(take)[0]).toBe(RecordType.KEYFRAME);
    expect(framesOf(take).length).toBe(SECOND);
    expect(Math.min(...framesOf(take))).toBeGreaterThan(firstTakeEnd);
    // The whole ring still has the first take, then the GAP, then the second.
    const all = wholeRing(r);
    const gapAt = r.types(all).indexOf(RecordType.GAP);
    expect(gapAt).toBeGreaterThan(0);
    const gap = decodeRecordAt(all, gapAt);
    expect(gap.kind === "gap" && gap.payload.reason).toBe(GapReason.held);
    expect(gap.kind === "gap" && gap.payload.perfTo >= gap.payload.perfFrom).toBe(true);
    expect(framesOf(all).length).toBe(3 * SECOND);
    expect(Audio.capture.state).toBe("recording");
  });

  it("a core made while Held (frames restart) gets the EPOCH the recovery couldn't write, before the GAP", async () => {
    const r = rig();
    await Audio.capture.start();
    r.feed(2 * SECOND);
    Audio.capture.stop();
    r.fb.frame = 0; // a new core: its frames start over
    await Audio.capture.start();
    r.feed(SECOND);
    const epochs = wholeRing(r).epochs;
    expect(epochs.length).toBe(2);
    expect(epochs[1]!.payload!.reason).toBe(EpochReason.device);
    await Audio.capture.save();
    const take = await r.open(r.downloads[0]!.bytes);
    expect(take.warnings).toEqual([]);
    expect(Math.max(...framesOf(take))).toBe(r.fb.frame);
  });

  it("the new take clears the old one's end: stop, start, stop, save writes the second take", async () => {
    const r = rig();
    await Audio.capture.start();
    r.feed(SECOND);
    Audio.capture.stop();
    await Audio.capture.start();
    r.feed(2 * SECOND);
    Audio.capture.stop();
    await Audio.capture.save();
    expect(framesOf(await r.open(r.downloads[0]!.bytes)).length).toBe(2 * SECOND);
  });

  it("a ring that wrapped over the take's start saves truncated and Audio.capture.truncated says so", async () => {
    const r = rig({ ringBytes: 1 * MiB });
    await Audio.capture.start();
    expect(Audio.capture.truncated).toBe(false);
    r.feed(30 * SECOND, 400);
    expect(Audio.capture.truncated).toBe(true);
    await Audio.capture.save();
    const c = await r.open(r.downloads[0]!.bytes);
    expect(c.truncated).toBe(true);
    expect(c.warnings).toEqual([]);
  });
});


describe("owners: the Profiler panel's hold is distinct from a take (the LiveHost seam)", () => {
  it("the seam is a CaptureLiveHost (the editor's LiveHost: editor/mix/captureLiveHost.test.ts), and is not a member of Audio.capture", () => {
    const host: CaptureLiveHost = captureLiveHost;
    expect(host.join).toBeTypeOf("function");
    expect("join" in Audio.capture).toBe(false);
    expect("liveHost" in Audio.capture).toBe(false);
  });

  it("a panel join with no take records; its release with no take frees the ring (nothing to save)", async () => {
    const r = rig();
    const rec = await captureLiveHost.join();
    expect(r.loads).toHaveBeenCalledTimes(1);
    expect(captureOwners()).toEqual({ take: false, panels: 1 });
    expect(Audio.capture.state, "the panel isn't a take").toBe("idle");
    expect(r.fb.recorderTap).toBeTypeOf("function");
    expect(captureDebug()).toMatchObject({ state: "recording", owners: 1 });
    r.feed(SECOND);
    await expect(Audio.capture.save()).rejects.toThrow(NOTHING_RECORDED);
    expect(rec.head().byteLength).toBeGreaterThan(96);
    rec.release();
    expect(captureOwners()).toEqual({ take: false, panels: 0 });
    expect(captureDebug(), "no take: the ring is freed").toBeNull();
    expect(r.fb.recorderTap).toBeNull();
    expect(r.fb.profileSink).toBeNull();
    rec.release(); // a second release changes nothing
    expect(captureOwners()).toEqual({ take: false, panels: 0 });
  });

  it("a take running keeps the ring when the panel closes; the panel keeps it when the take stops", async () => {
    const r = rig();
    await Audio.capture.start();
    const panel = await captureLiveHost.join();
    expect(captureOwners()).toEqual({ take: true, panels: 1 });
    expect(captureDebug()).toMatchObject({ owners: 2 });
    panel.release();
    expect(r.fb.recorderTap, "the take still owns the ring").toBeTypeOf("function");
    expect(captureOwners()).toEqual({ take: true, panels: 0 });
    const panel2 = await captureLiveHost.join();
    Audio.capture.stop();
    expect(r.fb.recorderTap, "the panel still owns the ring").toBeTypeOf("function");
    expect(Audio.capture.state).toBe("stopped");
    expect(captureDebug()).toMatchObject({ state: "recording", owners: 1 });
    panel2.release();
    expect(r.fb.recorderTap, "the last owner left: Held").toBeNull();
    expect(captureDebug()).toMatchObject({ state: "held", owners: 0 });
    await Audio.capture.save();
    expect(r.downloads.length).toBe(1);
  });

  it("joining a ring a take already uses, or a start joining a panel's ring, writes a marker", async () => {
    const r = rig();
    await Audio.capture.start();
    r.feed(5);
    const panel = await captureLiveHost.join();
    r.feed(5);
    panel.release();
    await Audio.capture.save("a");
    const a = await r.open(r.downloads[0]!.bytes);
    expect(a.records.type.filter((t) => t === RecordType.MARKER).length).toBe(1);
    expect(decodeMarker_(a, a.records.type.findIndex((t) => t === RecordType.MARKER))).toBe("Profiler panel opened");
    Audio.capture.stop();
    releaseCapture();
    const p2 = await captureLiveHost.join();
    r.feed(5);
    await Audio.capture.start();
    r.feed(5);
    await Audio.capture.save("b");
    const b = await r.open(r.downloads[1]!.bytes);
    expect(r.types(b)).toContain(RecordType.MARKER);
    p2.release();
  });

  it("a take started while the panel records begins at the open segment's keyframe, not the panel's start", async () => {
    const r = rig();
    const panel = await captureLiveHost.join();
    r.feed(3 * SECOND); // three segments pass
    const startedAt = r.fb.frame;
    await Audio.capture.start();
    r.feed(SECOND);
    await Audio.capture.save();
    const c = await r.open(r.downloads[0]!.bytes);
    expect(r.types(c)[0]).toBe(RecordType.KEYFRAME);
    expect(Math.min(...framesOf(c)), "the nearest keyframe at or before the start: at most a second of frames earlier").toBeGreaterThanOrEqual(startedAt - RATE - BLOCK);
    expect(framesOf(c).length).toBeLessThan(2 * SECOND + 2);
    panel.release();
  });

  it("stop with the panel still recording ends the take there: blocks after stop are in the ring, not in the file", async () => {
    const r = rig();
    await Audio.capture.start();
    const panel = await captureLiveHost.join();
    r.feed(SECOND);
    const stoppedAt = r.fb.frame;
    Audio.capture.stop();
    r.feed(SECOND); // the panel keeps recording
    await Audio.capture.save();
    const c = await r.open(r.downloads[0]!.bytes);
    expect(Math.max(...framesOf(c))).toBe(stoppedAt);
    expect(Audio.capture.state).toBe("stopped");
    expect(Audio.capture.seconds, "the take's figures froze at stop").toBeLessThan(1.5);
    panel.release();
  });

  it("a panel joining from Held resumes the ring after a GAP and leaves the stopped take as it was", async () => {
    const r = rig();
    await Audio.capture.start();
    r.feed(SECOND);
    Audio.capture.stop();
    const panel = await captureLiveHost.join();
    expect(r.loads).toHaveBeenCalledTimes(1);
    expect(r.fb.recorderTap).toBeTypeOf("function");
    r.feed(2 * SECOND);
    expect(Audio.capture.state).toBe("stopped");
    await Audio.capture.save();
    const c = await r.open(r.downloads[0]!.bytes);
    expect(framesOf(c).length, "the first take only").toBe(SECOND);
    panel.release();
    expect(captureDebug()).toMatchObject({ state: "held" });
    await Audio.capture.start(); // and a start now begins the next take
    r.feed(SECOND);
    await Audio.capture.save();
    expect(framesOf(await r.open(r.downloads[1]!.bytes)).length).toBe(SECOND);
  });

  it("join rejects with a message while the core isn't there, and holds nothing", async () => {
    const r = rig();
    delete (r.fb as { recorderTap?: unknown }).recorderTap;
    r.fb.mixCaps = { ...r.fb.mixCaps, capture: "full" };
    await expect(captureLiveHost.join()).rejects.toThrow(/audio core/);
    expect(captureOwners()).toEqual({ take: false, panels: 0 });
    expect(captureDebug()).toBeNull();
  });

  it("a token from a released ring does nothing (Play stopped under it)", async () => {
    const r = rig();
    const panel = await captureLiveHost.join();
    releaseCapture();
    const second = await captureLiveHost.join(); // a new ring
    panel.release(); // the old token: not an owner of the new ring
    expect(captureOwners()).toEqual({ take: false, panels: 1 });
    expect(r.recorders.length).toBe(2);
    second.release();
  });

  it("startLive posts open with the head, then each sealed segment in order; liveLost and stopLive pass through", async () => {
    const r = rig();
    const panel = await captureLiveHost.join();
    const posts: { type: string }[] = [];
    panel.startLive({ head: panel.head(), id: 7, post: (req) => void posts.push(req) });
    expect(posts.map((p) => p.type)).toEqual(["open"]);
    expect(openLiveCapture(panel.head()).contents.header.recordCount).toBe(0);
    r.feed(3 * SECOND);
    const appended = posts.filter((p) => p.type === "appendSegment").length;
    expect(appended).toBeGreaterThanOrEqual(2);
    expect(panel.liveLost).toBe(false);
    panel.stopLive();
    r.feed(2 * SECOND);
    expect(posts.filter((p) => p.type === "appendSegment").length, "stopped: no more segments").toBe(appended);
    panel.release();
  });
});

describe("Rc3: the event sink is installed while recording and removed otherwise", () => {
  it("setProfileSink gets the sink at start and null at the last stop; events land in the take", async () => {
    const r = rig();
    expect(r.fb.profileSink).toBeNull();
    await Audio.capture.start();
    const sink = r.fb.profileSink!;
    expect(sink).not.toBeNull();
    r.feed(3);
    sink.voiceStart(9, "audio/boom.wav", 0, 0, 0, 0.5);
    sink.voiceStop(9, "ended");
    Audio.capture.stop();
    expect(r.fb.profileSink).toBeNull();
    await Audio.capture.save();
    const c = await r.open(r.downloads[0]!.bytes);
    expect(r.types(c).filter((t) => t === RecordType.EVENT).length).toBe(2);
  });
});
