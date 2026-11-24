// ADR 0171 amended by 0172 (M5a, task Rc4, leaf L-Rc4a; api-and-models §1.2, §5.1, §5.7): saving a take. A real recorder's
// span becomes a file Rc1's reader opens whole (stored and deflate-raw), the web path hands a Blob-backed download a
// sanitised name, the Tauri path writes plain files under `takes/` and `captures/` and rotates to 16, and every environment is a fake.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_FLAG_COMPRESSED, CAPTURE_FLAG_HAS_INDEX, CAPTURE_FLAG_TRUNCATED, CAPTURE_HEADER_BYTES, CAPTURE_TRIGGER_MAX_FILES, RecordType, readCaptureHeader } from "./format";
import { openCapture } from "./reader";
import { createRecorder, type EpochContext, type Recorder } from "./recorder";
import {
  assembleTakeFile, defaultSaveEnv, rotateCaptures, saveCapture, webSaveCount, type SaveEnv, type SaveTake,
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

/** The real platform's deflate-raw (`CompressionStream`), as `saveCapture` uses by default. */
const deflateRawCompress = (payload: Uint8Array): Promise<Uint8Array | null> => defaultSaveEnv().compress(payload);

/** A fake environment: records the download and the file operations (an in-memory file tree); compression is the real one unless told. */
function fakeEnv(over: Partial<SaveEnv> = {}) {
  const downloads: { bytes: Uint8Array; fileName: string }[] = [];
  /** Absolute file path -> bytes. */
  const files = new Map<string, Uint8Array>();
  const folders: string[] = [];
  const saved: { path: string; bytes: Uint8Array }[] = [];
  const deleted: string[] = [];
  const parent = (path: string): string => path.slice(0, path.lastIndexOf("/"));
  const env: SaveEnv = {
    tauri: false,
    fs: {
      mkdir: async (path) => void folders.push(path),
      write: async (path, bytes) => {
        saved.push({ path, bytes });
        files.set(path, bytes);
      },
      list: async (path) => [...files.keys()].filter((k) => parent(k) === path.replace(/\/+$/, "")).map((k) => k.slice(k.lastIndexOf("/") + 1)),
      remove: async (path) => {
        deleted.push(path);
        files.delete(path);
      },
    },
    storageRoot: async () => "/data/app/",
    download: (bytes, fileName) => downloads.push({ bytes, fileName }),
    compress: deflateRawCompress,
    now: () => at(10, 15, 0),
    ...over,
  };
  return { env, downloads, saved, deleted, files, folders };
}

let smallTake: SaveTake | undefined;
/** What a web save of `name` at `now` downloads as (the auto name's repeat counter carries over between calls, as on a page). */
async function savedName(name: string | undefined, now: Date): Promise<string> {
  smallTake ??= takeOf(recorded(1));
  const { env, downloads } = fakeEnv({ now: () => now, compress: async () => null });
  await saveCapture(smallTake, name, env);
  return downloads[0]!.fileName;
}

describe("names (§1.2: [A-Za-z0-9._-], 64 characters, .mycap appended; absent: capture-YYYYMMDD-HHMMSS)", () => {
  it("keeps a clean name and appends the extension once", async () => {
    expect(await savedName("boss-fight_2.take", at(1, 2, 3))).toBe("boss-fight_2.take.mycap");
    expect(await savedName("run.mycap", at(1, 2, 3))).toBe("run.mycap");
    expect(await savedName("RUN.MYCAP", at(1, 2, 3))).toBe("RUN.mycap");
  });

  it("replaces every other character and drops leading dots, so no path or hidden file comes out", async () => {
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
      const file = await savedName(input, at(9, 8, 7));
      if (out === "") expect(file, input).toMatch(/^capture-20261113-090807(-\d+)?\.mycap$/);
      else expect(file, input).toBe(out);
      expect(file, input).toMatch(/^[A-Za-z0-9._-]+\.mycap$/);
      expect(file.startsWith("."), input).toBe(false);
    }
  });

  it("cuts the stem to 64 characters before the extension", async () => {
    const file = await savedName("x".repeat(200), at(1, 2, 3));
    expect(file).toBe("x".repeat(64) + ".mycap");
    expect(file.length).toBe(64 + 6);
  });

  it("an absent, blank, non-string or all-stripped name is capture-YYYYMMDD-HHMMSS in local time", async () => {
    const names = [undefined, "", "   ", ".mycap", "...", "..mycap", 42 as unknown as string];
    for (const [i, name] of names.entries()) {
      expect(await savedName(name, at(9, 5, i, 14)), String(name)).toBe(`capture-20261114-0905${String(i).padStart(2, "0")}.mycap`);
    }
  });

  it("a second auto name within the same second doesn't repeat the first", async () => {
    const names = [];
    for (const s of [3, 3, 3, 4]) names.push(await savedName(undefined, at(1, 2, s, 15)));
    expect(names).toEqual(["capture-20261115-010203.mycap", "capture-20261115-010203-2.mycap", "capture-20261115-010203-3.mycap", "capture-20261115-010204.mycap"]);
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
    const take = takeOf(recorded(5));
    const stored = assembleTakeFile(take);
    const { env, downloads } = fakeEnv();
    await saveCapture(take, "packed", env);
    const packed = downloads[0]!.bytes;
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
    const take = takeOf(recorded(2));
    const { env, downloads } = fakeEnv({ compress: async () => null });
    await saveCapture(take, "declined", env);
    expect(downloads[0]!.bytes).toEqual(assembleTakeFile(take));
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
    const before = webSaveCount();
    const name = await saveCapture(takeOf(recorded(3)), "boss fight #2", env);
    expect(name).toBe("boss_fight_2.mycap");
    expect(downloads.length).toBe(1);
    expect(downloads[0]!.fileName).toBe("boss_fight_2.mycap");
    expect(saved).toEqual([]);
    expect(webSaveCount()).toBe(before + 1);
    const c = await openCapture(downloads[0]!.bytes);
    expect(c.warnings).toEqual([]);
    expect(c.records.count).toBeGreaterThan(10);
  });

  it("an absent name is the auto name; two saves in one second make two names", async () => {
    const { env, downloads } = fakeEnv();
    const take = takeOf(recorded(2));
    const before = webSaveCount();
    const a = await saveCapture(take, undefined, env);
    const b = await saveCapture(take, undefined, env);
    expect([a, b]).toEqual(["capture-20261113-101500.mycap", "capture-20261113-101500-2.mycap"]);
    expect(downloads.map((d) => d.fileName)).toEqual([a, b]);
    expect(webSaveCount()).toBe(before + 2);
  });

  it("the platform's download clicks an a[download] over a Blob object URL and revokes it later", () => {
    vi.useFakeTimers();
    const anchor = { href: "", download: "", style: { display: "" }, click: vi.fn(), remove: vi.fn() };
    const body = { appendChild: vi.fn() };
    const created: Blob[] = [];
    const revoked: string[] = [];
    vi.stubGlobal("document", { createElement: (tag: string) => (tag === "a" ? anchor : null), body });
    vi.stubGlobal("URL", { createObjectURL: (b: Blob) => (created.push(b), "blob:fake-1"), revokeObjectURL: (u: string) => revoked.push(u) });
    try {
      defaultSaveEnv().download(new Uint8Array([1, 2, 3]), "x.mycap");
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

describe("the Tauri path: plain files under <storage root>/takes and /captures", () => {
  it("makes the folder, writes <storage root>/captures/<name>.mycap and resolves with that path", async () => {
    const { env, downloads, saved, folders, files } = fakeEnv({ tauri: true });
    const before = webSaveCount();
    const path = await saveCapture(takeOf(recorded(3)), "arena-2", env);
    expect(path).toBe("/data/app/captures/arena-2.mycap");
    expect(downloads).toEqual([]);
    expect(folders).toEqual(["/data/app/captures"]);
    expect(saved.map((s) => s.path)).toEqual(["/data/app/captures/arena-2.mycap"]);
    expect([...files.keys()]).toEqual([path]);
    expect(webSaveCount()).toBe(before);
    const c = await openCapture(saved[0]!.bytes);
    expect(c.warnings).toEqual([]);
  });

  it("a take goes to takes/ with .mycotake", async () => {
    const { env, saved } = fakeEnv({ tauri: true });
    const take = takeOf(recorded(2), { requests: { bytes: new Uint8Array(0), recordCount: 0 } });
    expect(await saveCapture(take, "duel", env)).toBe("/data/app/takes/duel.mycotake");
    expect(saved.map((s) => s.path)).toEqual(["/data/app/takes/duel.mycotake"]);
  });

  it("a name saved twice is overwritten", async () => {
    const { env, files } = fakeEnv({ tauri: true });
    const take = takeOf(recorded(1));
    await saveCapture(take, "same", env);
    await saveCapture(take, "same", env);
    expect([...files.keys()]).toEqual(["/data/app/captures/same.mycap"]);
  });

  it("a trailing slash on the root goes, and a Windows root keeps its own separators", async () => {
    const take = takeOf(recorded(1));
    const windows = fakeEnv({ tauri: true, storageRoot: async () => "C:\\Users\\me\\AppData\\" }).env;
    expect(await saveCapture(take, "a.b", windows)).toBe("C:\\Users\\me\\AppData/captures/a.b.mycap");
    expect(await saveCapture(take, "k", fakeEnv({ tauri: true, storageRoot: async () => "/d" }).env)).toBe("/d/captures/k.mycap");
  });

  it("rejects, writing nothing, when the storage folder can't be resolved", async () => {
    const { env, saved } = fakeEnv({ tauri: true, storageRoot: () => Promise.reject(new Error("no path api")) });
    await expect(saveCapture(takeOf(recorded(2)), "x", env)).rejects.toThrow("no path api");
    expect(saved.length).toBe(0);
  });
});

describe("rotation: the newest 16 auto-named files of a folder stay (list, remove)", () => {
  const DIR = "/data/app/captures";
  const stems = (n: number): string[] => Array.from({ length: n }, (_, i) => `capture-20261113-1${String(i).padStart(5, "0")}.mycap`);
  const put = (files: Map<string, Uint8Array>, name: string, dir = DIR): void => void files.set(`${dir}/${name}`, new Uint8Array(1));
  const names = (files: Map<string, Uint8Array>, dir = DIR): string[] => [...files.keys()].filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1));

  it("deletes the oldest first and keeps 16; user-named files and other files are never touched", async () => {
    const { env, files, deleted } = fakeEnv({ tauri: true });
    const auto = stems(20);
    for (const k of [...auto].reverse()) put(files, k); // listed in any order
    put(files, "my-best-run.mycap");
    put(files, "audio.calibration");
    put(files, "capture-20200101-000000.mycap", "/data/app/takes"); // another folder
    const gone = await rotateCaptures(env.fs, DIR);
    expect(gone).toEqual(auto.slice(0, 4));
    expect(deleted).toEqual(auto.slice(0, 4).map((k) => `${DIR}/${k}`));
    const left = names(files);
    expect(left.filter((k) => k.startsWith("capture-")).sort()).toEqual(auto.slice(4));
    expect(left).toContain("my-best-run.mycap");
    expect(left).toContain("audio.calibration");
    expect(names(files, "/data/app/takes")).toEqual(["capture-20200101-000000.mycap"]);
    expect(CAPTURE_TRIGGER_MAX_FILES).toBe(16);
  });

  it("a repeat suffix orders after its second: -2 is newer than the bare stem", async () => {
    const { env, files } = fakeEnv({ tauri: true });
    for (const k of ["capture-20261113-101500-3.mycap", "capture-20261113-101500.mycap", "capture-20261113-101500-2.mycap"]) put(files, k);
    expect(await rotateCaptures(env.fs, DIR, 1)).toEqual(["capture-20261113-101500.mycap", "capture-20261113-101500-2.mycap"]);
  });

  it("saving an auto-named capture on Tauri rotates to 16; a named save doesn't", async () => {
    const { env, files } = fakeEnv({ tauri: true, now: () => at(10, 15, 0, 20) });
    for (const k of stems(16)) put(files, k);
    const take = takeOf(recorded(2));
    await saveCapture(take, "keeper", env);
    expect(names(files).length, "17 files: a named save leaves the rotation alone").toBe(17);
    await saveCapture(take, undefined, env); // capture-20261120-101500.mycap: the 17th auto file, so the oldest goes
    const left = names(files);
    expect(left.filter((k) => k.startsWith("capture-")).length).toBe(16);
    expect(left).toContain("keeper.mycap");
    expect(left).toContain("capture-20261120-101500.mycap");
    expect(left).not.toContain(stems(16)[0]);
  });

  it("takes rotate over their own folder and extension", async () => {
    const { env, files } = fakeEnv({ tauri: true });
    const old = Array.from({ length: 16 }, (_, i) => `take-20261101-1000${String(i).padStart(2, "0")}.mycotake`);
    for (const k of old) put(files, k, "/data/app/takes");
    put(files, "capture-20261101-100000.mycap", "/data/app/captures");
    const take = takeOf(recorded(2), { requests: { bytes: new Uint8Array(0), recordCount: 0 } });
    await saveCapture(take, undefined, env);
    expect(names(files, "/data/app/takes").length).toBe(16);
    expect(names(files, "/data/app/takes")).not.toContain(old[0]);
    expect(names(files, "/data/app/captures")).toEqual(["capture-20261101-100000.mycap"]);
  });

  it("a remove that fails leaves the file and the rotation goes on", async () => {
    const { env, files } = fakeEnv({ tauri: true });
    const auto = stems(4);
    for (const k of auto) put(files, k);
    const flaky = { ...env.fs, remove: vi.fn(async (path: string) => { if (path.endsWith(auto[0]!)) throw new Error("locked"); return env.fs.remove(path); }) };
    expect(await rotateCaptures(flaky, DIR, 2)).toEqual([auto[1]]);
    expect(flaky.remove).toHaveBeenCalledTimes(2);
  });
});

afterEach(() => vi.restoreAllMocks());
