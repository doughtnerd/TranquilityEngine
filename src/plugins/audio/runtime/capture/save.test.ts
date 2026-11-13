// ADR 0171 amended by 0172 (M5a, task Rc4, leaf L-Rc4a; api-and-models §1.2, §5.1, §5.7): saving a take. A real recorder's
// span becomes a file Rc1's reader opens whole (stored and deflate-raw), the web path hands a Blob-backed download a
// sanitised name, the Tauri path saves through `Storage` into `cache` and rotates to 16, and every environment is a fake.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage, Storage } from "../../../../engine/platform/Storage";
import { CAPTURE_FLAG_COMPRESSED, CAPTURE_FLAG_HAS_INDEX, CAPTURE_FLAG_TRUNCATED, CAPTURE_HEADER_BYTES, CAPTURE_TRIGGER_MAX_FILES, RecordType, readCaptureHeader } from "./format";
import { openCapture } from "./reader";
import { createRecorder, type EpochContext, type Recorder } from "./recorder";
import {
  CAPTURE_NAME_MAX_CHARS, _resetSaveState, assembleTakeFile, autoCaptureStem, browserDownload, cachePath, captureFileName, compressCapture,
  deflateRawCompress, rotateCaptures, saveCapture, webSaveCount, type SaveEnv, type SaveTake,
} from "./save";
import { SAMPLE_HEADER, SAMPLE_META, SAMPLE_RATE, keyframeCodecForTests, statusBytes, statusBytesWithVoices } from "./testSupport";

const MiB = 1024 * 1024;
const BLOCK = 768;
const CONTEXT: EpochContext = { sampleRate: SAMPLE_RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0 };
/** A local-time date, so the expected stems below hold in any zone. */
const at = (h: number, m: number, s: number, day = 13): Date => new Date(2026, 10, day, h, m, s);

/** A recorder holding `seconds` of STATUS blocks (about 1 s per 62.5 blocks), a marker and a keyframe each second. */
function recorded(seconds: number, ringBytes = 4 * MiB, voices = 0): Recorder {
  let t = 1000;
  const r = createRecorder({ ringBytes, codec: keyframeCodecForTests(), now: () => (t += 1) });
  r.begin(0, CONTEXT);
  const blocks = Math.floor((seconds * SAMPLE_RATE) / BLOCK);
  for (let k = 1; k <= blocks; k++) {
    const block = voices > 0 ? statusBytesWithVoices(k * BLOCK, voices) : statusBytes(k * BLOCK);
    const data = block.slice().buffer as ArrayBuffer;
    r.tap(data, block.byteLength, new DataView(data));
    if (k % 100 === 0) r.marker(`block ${k}`, k * BLOCK);
  }
  return r;
}

function takeOf(r: Recorder, over: Partial<SaveTake> = {}): SaveTake {
  return { header: { ...SAMPLE_HEADER, truncated: r.truncated }, meta: SAMPLE_META, span: r.takeSpan(), truncatedFromSeq: r.truncatedFromSeq, ...over };
}

/** A fake environment: records the download and the `Storage` calls; compression is the real one unless told. */
function fakeEnv(over: Partial<SaveEnv> = {}) {
  const downloads: { bytes: Uint8Array; fileName: string }[] = [];
  const storage = new MemoryStorage();
  const saved: { key: string; bytes: Uint8Array; namespace: string }[] = [];
  const deleted: string[] = [];
  const env: SaveEnv = {
    tauri: false,
    storage: {
      save: async (key, value, namespace) => {
        saved.push({ key, bytes: value as Uint8Array, namespace });
        await storage.save(namespace, key, value);
      },
      list: (namespace) => storage.list(namespace),
      delete: async (key, namespace) => {
        deleted.push(key);
        await storage.delete(namespace, key);
      },
    },
    appDataDir: async () => "/data/app/",
    download: (bytes, fileName) => downloads.push({ bytes, fileName }),
    compress: deflateRawCompress,
    now: () => at(10, 15, 0),
    ...over,
  };
  return { env, downloads, saved, deleted, storage };
}

beforeEach(() => _resetSaveState());

describe("names (§1.2: [A-Za-z0-9._-], 64 characters, .mycap appended; absent: capture-YYYYMMDD-HHMMSS)", () => {
  it("keeps a clean name and appends the extension once", () => {
    expect(captureFileName("boss-fight_2.take", at(1, 2, 3))).toEqual({ file: "boss-fight_2.take.mycap", auto: false });
    expect(captureFileName("run.mycap", at(1, 2, 3))).toEqual({ file: "run.mycap", auto: false });
    expect(captureFileName("RUN.MYCAP", at(1, 2, 3))).toEqual({ file: "RUN.mycap", auto: false });
  });

  it("replaces every other character and drops leading dots, so no path or hidden file comes out", () => {
    const cases: [string, string][] = [
      ["my capture!", "my_capture_.mycap"],
      ["../../etc/passwd", "_.._etc_passwd.mycap"],
      ["..\\win\\system", "_win_system.mycap"],
      [".hidden", "hidden.mycap"],
      ["...", ""],
      ["!!!", "_.mycap"],
      ["café ☕ run", "caf_run.mycap"],
      ["a/b\\c:d*e?f\"g<h>i|j", "a_b_c_d_e_f_g_h_i_j.mycap"],
      ["tab\tnew\nline", "tab_new_line.mycap"],
    ];
    for (const [input, out] of cases) {
      const r = captureFileName(input, at(9, 8, 7));
      if (out === "") expect(r.auto, input).toBe(true);
      else expect(r, input).toEqual({ file: out, auto: false });
      expect(r.file, input).toMatch(/^[A-Za-z0-9._-]+\.mycap$/);
      expect(r.file.startsWith("."), input).toBe(false);
    }
  });

  it("cuts the stem to 64 characters before the extension", () => {
    const { file } = captureFileName("x".repeat(200), at(1, 2, 3));
    expect(file).toBe("x".repeat(CAPTURE_NAME_MAX_CHARS) + ".mycap");
    expect(file.length).toBe(64 + 6);
  });

  it("an absent, blank, non-string or all-stripped name is capture-YYYYMMDD-HHMMSS in local time", () => {
    for (const name of [undefined, "", "   ", ".mycap", "...", "..mycap", 42 as unknown as string]) {
      _resetSaveState();
      expect(captureFileName(name, at(9, 5, 7)), String(name)).toEqual({ file: "capture-20261113-090507.mycap", auto: true });
    }
  });

  it("a second auto name within the same second doesn't repeat the first", () => {
    const names = [autoCaptureStem(at(1, 2, 3)), autoCaptureStem(at(1, 2, 3)), autoCaptureStem(at(1, 2, 3)), autoCaptureStem(at(1, 2, 4))];
    expect(names).toEqual(["capture-20261113-010203", "capture-20261113-010203-2", "capture-20261113-010203-3", "capture-20261113-010204"]);
  });
});

describe("the file (§5.1): header, META, the span's records and an INDEX, opened whole by Rc1's reader", () => {
  it("is stored with hasIndex: every span record plus the INDEX, the keyframes indexed, no warnings", async () => {
    const r = recorded(5);
    const take = takeOf(r);
    const file = assembleTakeFile(take);
    const h = readCaptureHeader(file);
    expect(h.flags & CAPTURE_FLAG_COMPRESSED).toBe(0);
    expect(h.flags & CAPTURE_FLAG_HAS_INDEX).toBeTruthy();
    expect(h.recordCount).toBe(take.span.recordCount + 1);
    expect(h.uncompressedBytes).toBe(file.byteLength - CAPTURE_HEADER_BYTES);
    expect(h.firstFrame).toBe(take.span.firstFrame);
    expect(h.ringBytes).toBe(SAMPLE_HEADER.ringBytes);
    const c = await openCapture(file);
    expect(c.records.count).toBe(take.span.recordCount + 1);
    expect(c.records.type[c.records.count - 1]).toBe(RecordType.INDEX);
    expect(c.warnings).toEqual([]);
    expect(c.index, "the INDEX agreed with the scan").not.toBeNull();
    expect(c.index!.entries.length).toBe(take.span.keyframes.length);
    expect(c.keyframes.length).toBe(take.span.keyframes.length);
    expect(c.index!.truncatedFromSeq).toBe(0);
    expect(c.truncated).toBe(false);
    expect(c.meta.project.name).toBe("Sample");
    // Epoch 0's EPOCH leads the take, and the markers the recorder wrote are in it.
    expect(c.records.type[0]).toBe(RecordType.EPOCH);
    expect(Array.from(c.records.type.subarray(0, c.records.count)).filter((t) => t === RecordType.MARKER).length).toBeGreaterThan(0);
  });

  it("a ring that wrapped over the take's start saves truncated, with truncatedFromSeq and the later firstFrame", async () => {
    const r = recorded(30, 1 * MiB, 400); // about 215 KB a second: the 1 MiB ring wraps
    expect(r.truncated).toBe(true);
    const take = takeOf(r);
    const file = assembleTakeFile(take);
    const h = readCaptureHeader(file);
    expect(h.flags & CAPTURE_FLAG_TRUNCATED).toBeTruthy();
    expect(h.firstFrame).toBeGreaterThan(0);
    const c = await openCapture(file);
    expect(c.truncated).toBe(true);
    expect(c.index!.truncatedFromSeq).toBe(take.span.firstSeq);
    expect(c.warnings).toEqual([]);
    expect(c.records.count).toBe(take.span.recordCount + 1);
  });

  it("deflate-raw compresses everything after the header, sets compressed, and the reader inflates it to the same records", async () => {
    const r = recorded(5);
    const stored = assembleTakeFile(takeOf(r));
    const packed = await compressCapture(stored, deflateRawCompress);
    const h = readCaptureHeader(packed);
    expect(h.flags & CAPTURE_FLAG_COMPRESSED).toBeTruthy();
    expect(packed.byteLength, "STATUS blocks are mostly zeros: it shrinks").toBeLessThan(stored.byteLength / 2);
    expect(packed.subarray(0, 10)).toEqual(stored.subarray(0, 10));
    const a = await openCapture(stored);
    const b = await openCapture(packed);
    expect(b.records.count).toBe(a.records.count);
    expect(Array.from(b.records.seq.subarray(0, b.records.count))).toEqual(Array.from(a.records.seq.subarray(0, a.records.count)));
    expect(b.keyframes).toEqual(a.keyframes);
    expect(b.warnings).toEqual([]);
  });

  it("without a CompressionStream the file is stored raw (compressed clear) and still opens", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    try {
      expect(await deflateRawCompress(new Uint8Array(100))).toBeNull();
      const { env, downloads } = fakeEnv({ compress: deflateRawCompress });
      await saveCapture(takeOf(recorded(3)), "plain", env);
      const bytes = downloads[0]!.bytes;
      expect(readCaptureHeader(bytes).flags & CAPTURE_FLAG_COMPRESSED).toBe(0);
      const c = await openCapture(bytes);
      expect(c.warnings).toEqual([]);
      expect(c.records.type[c.records.count - 1]).toBe(RecordType.INDEX);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a compressor that fails or declines leaves the stored file", async () => {
    const stored = assembleTakeFile(takeOf(recorded(2)));
    expect(await compressCapture(stored, async () => null)).toBe(stored);
    class Broken {
      get writable() {
        throw new Error("no stream");
      }
    }
    vi.stubGlobal("CompressionStream", Broken);
    try {
      expect(await deflateRawCompress(new Uint8Array(10))).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the web path: a download named from the sanitised name", () => {
  it("hands the bytes to the download and resolves with the file name; Storage is untouched", async () => {
    const { env, downloads, saved } = fakeEnv();
    const name = await saveCapture(takeOf(recorded(3)), "boss fight #2", env);
    expect(name).toBe("boss_fight_2.mycap");
    expect(downloads.length).toBe(1);
    expect(downloads[0]!.fileName).toBe("boss_fight_2.mycap");
    expect(saved).toEqual([]);
    expect(webSaveCount()).toBe(1);
    const c = await openCapture(downloads[0]!.bytes);
    expect(c.warnings).toEqual([]);
    expect(c.records.count).toBeGreaterThan(10);
  });

  it("an absent name is the auto name; two saves in one second make two names", async () => {
    const { env, downloads } = fakeEnv();
    const take = takeOf(recorded(2));
    const a = await saveCapture(take, undefined, env);
    const b = await saveCapture(take, undefined, env);
    expect([a, b]).toEqual(["capture-20261113-101500.mycap", "capture-20261113-101500-2.mycap"]);
    expect(downloads.map((d) => d.fileName)).toEqual([a, b]);
    expect(webSaveCount()).toBe(2);
  });

  it("browserDownload clicks an a[download] over a Blob object URL and revokes it later", () => {
    vi.useFakeTimers();
    const anchor = { href: "", download: "", style: { display: "" }, click: vi.fn(), remove: vi.fn() };
    const body = { appendChild: vi.fn() };
    const created: Blob[] = [];
    const revoked: string[] = [];
    vi.stubGlobal("document", { createElement: (tag: string) => (tag === "a" ? anchor : null), body });
    vi.stubGlobal("URL", { createObjectURL: (b: Blob) => (created.push(b), "blob:fake-1"), revokeObjectURL: (u: string) => revoked.push(u) });
    try {
      browserDownload(new Uint8Array([1, 2, 3]), "x.mycap");
      expect(anchor.href).toBe("blob:fake-1");
      expect(anchor.download).toBe("x.mycap");
      expect(anchor.click).toHaveBeenCalledTimes(1);
      expect(body.appendChild).toHaveBeenCalledWith(anchor);
      expect(created[0]!.size).toBe(3);
      expect(revoked).toEqual([]);
      vi.runAllTimers();
      expect(revoked).toEqual(["blob:fake-1"]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("the Tauri path: Storage.save(key, bytes, \"cache\"), resolving with the app-data path", () => {
  it("saves the bytes in the cache namespace and resolves <appDataDir>/cache/<key>.bin", async () => {
    const { env, downloads, saved, storage } = fakeEnv({ tauri: true });
    const path = await saveCapture(takeOf(recorded(3)), "arena-2", env);
    expect(path).toBe("/data/app/cache/arena-2.mycap.bin");
    expect(downloads).toEqual([]);
    expect(saved.map((s) => [s.key, s.namespace])).toEqual([["arena-2.mycap", "cache"]]);
    expect(await storage.list("cache")).toEqual(["arena-2.mycap"]);
    expect(webSaveCount()).toBe(0);
    const c = await openCapture(saved[0]!.bytes);
    expect(c.warnings).toEqual([]);
  });

  it("works through the real Storage facade over its memory backend", async () => {
    const memory = new MemoryStorage();
    Storage.use(memory);
    try {
      const { env } = fakeEnv({ tauri: true });
      const real: SaveEnv = { ...env, storage: { save: (k, v, n) => Storage.save(k, v, n), list: (n) => Storage.list(n), delete: (k, n) => Storage.delete(k, n) } };
      await saveCapture(takeOf(recorded(2)), "via-facade", real);
      const back = (await Storage.load<Uint8Array>("via-facade.mycap", "cache"))!;
      expect(readCaptureHeader(back).flags & CAPTURE_FLAG_COMPRESSED).toBeTruthy();
    } finally {
      Storage.use(new MemoryStorage());
    }
  });

  it("cachePath mirrors TauriStorage: a trailing slash goes, the key is URI-encoded", () => {
    expect(cachePath("C:\\Users\\me\\AppData\\", "a b.mycap")).toBe("C:\\Users\\me\\AppData/cache/a%20b.mycap.bin");
    expect(cachePath("/d", "k.mycap")).toBe("/d/cache/k.mycap.bin");
  });

  it("still resolves when the app-data folder can't be read", async () => {
    const { env, saved } = fakeEnv({ tauri: true, appDataDir: () => Promise.reject(new Error("no path api")) });
    await expect(saveCapture(takeOf(recorded(2)), "x", env)).resolves.toBe("cache/x.mycap.bin");
    expect(saved.length).toBe(1);
  });
});

describe("rotation: the newest 16 auto-named captures stay (Storage.list, delete)", () => {
  const stems = (n: number): string[] => Array.from({ length: n }, (_, i) => `capture-20261113-1${String(i).padStart(5, "0")}.mycap`);

  it("deletes the oldest first and keeps 16; user-named files and other cache entries are never touched", async () => {
    const { env, storage, deleted } = fakeEnv({ tauri: true });
    const auto = stems(20);
    for (const k of [...auto].reverse()) await storage.save("cache", k, new Uint8Array(1)); // listed in any order
    await storage.save("cache", "my-best-run.mycap", new Uint8Array(1));
    await storage.save("cache", "audio.calibration", new Uint8Array(1));
    await storage.save("saves", "capture-20200101-000000.mycap", new Uint8Array(1)); // another namespace
    const gone = await rotateCaptures(env.storage);
    expect(gone).toEqual(auto.slice(0, 4));
    expect(deleted).toEqual(auto.slice(0, 4));
    const left = await storage.list("cache");
    expect(left.filter((k) => k.startsWith("capture-")).sort()).toEqual(auto.slice(4));
    expect(left).toContain("my-best-run.mycap");
    expect(left).toContain("audio.calibration");
    expect(await storage.list("saves")).toEqual(["capture-20200101-000000.mycap"]);
    expect(CAPTURE_TRIGGER_MAX_FILES).toBe(16);
  });

  it("a repeat suffix orders after its second: -2 is newer than the bare stem", async () => {
    const { env, storage } = fakeEnv({ tauri: true });
    const names = ["capture-20261113-101500-3.mycap", "capture-20261113-101500.mycap", "capture-20261113-101500-2.mycap"];
    for (const k of names) await storage.save("cache", k, new Uint8Array(1));
    expect(await rotateCaptures(env.storage, 1)).toEqual(["capture-20261113-101500.mycap", "capture-20261113-101500-2.mycap"]);
  });

  it("saving an auto-named capture on Tauri rotates to 16; a named save doesn't", async () => {
    const { env, storage } = fakeEnv({ tauri: true });
    for (const k of stems(16)) await storage.save("cache", k, new Uint8Array(1));
    const take = takeOf(recorded(2));
    await saveCapture(take, "keeper", env);
    expect((await storage.list("cache")).length, "17 files: a named save leaves the rotation alone").toBe(17);
    await saveCapture(take, undefined, env); // capture-20261113-101500.mycap: the 17th auto file, so the oldest goes
    const left = await storage.list("cache");
    expect(left.filter((k) => k.startsWith("capture-")).length).toBe(16);
    expect(left).toContain("keeper.mycap");
    expect(left).toContain("capture-20261113-101500.mycap");
    expect(left).not.toContain(stems(16)[0]);
  });

  it("a delete that fails leaves the file and the rotation goes on", async () => {
    const { env, storage } = fakeEnv({ tauri: true });
    const names = stems(4);
    for (const k of names) await storage.save("cache", k, new Uint8Array(1));
    const flaky = { ...env.storage, delete: vi.fn(async (key: string, ns: "cache") => { if (key === names[0]) throw new Error("locked"); return env.storage.delete(key, ns); }) };
    expect(await rotateCaptures(flaky, 2)).toEqual([names[1]]);
    expect(flaky.delete).toHaveBeenCalledTimes(2);
  });
});

afterEach(() => vi.restoreAllMocks());
