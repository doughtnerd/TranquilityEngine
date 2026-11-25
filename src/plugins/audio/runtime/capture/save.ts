// ADR 0171 amended by 0172 (M5a, task Rc4; api-and-models §1.2, §5.1, §5.7): saving a take. The ring's span (the latest
// take's records, WRAP stripped, Rc2's `copyRecords`) becomes a file: the 96 B plain header, META, the records and an INDEX
// record, the part after the header deflate-raw compressed with `CompressionStream` (or stored raw, `compressed` clear,
// where the runtime has none). The web saves a `Blob` through `a[download]`; Tauri (desktop and Android) saves through
// the engine's `FileSystem`: a plain file with its real extension, `<storage root>/recordings/<name>.sporesample` or
// `<storage root>/recordings/<name>.sporesample`, and keeps the newest 16 auto-named files of each folder
// (`CAPTURE_TRIGGER_MAX_FILES`: oldest deleted first through `list` and `remove`).
//
// This file is part of the lazy chunk: `capture/capture.ts` loads it by `import()` on the first `save`, never statically,
// so a game that never captures carries none of `format.ts`. Everything environmental (the platform, the storage, the
// download, the compressor, the clock) is one `SaveEnv`, so every path runs against fakes.
import { getFileSystem, isTauri } from "../../../../engine/platform/FileSystem";
import { Storage } from "../../../../engine/platform/Storage";
import {
  CAPTURE_FLAG_COMPRESSED, CAPTURE_FLAG_HAS_INDEX, CAPTURE_HEADER_BYTES, CAPTURE_RECORD_HEAD_BYTES, CAPTURE_TRIGGER_MAX_FILES,
  RecordType, assembleCapture, encodeRecords, readCaptureHeader, writeCaptureHeader,
  type CaptureHeaderInit, type CaptureMetaInit,
} from "./format";
import type { RingSpan } from "./ring";

/** The file extension every capture carries. */
export const CAPTURE_EXTENSION = ".sporesample";
/** ADR 0348: a take's (`TAKE_SUFFIX` of `engine/audio/take/types.ts`). */
export const TAKE_EXTENSION = ".sporesample";

/** What is saved: a capture (`.sporesample`, auto names `capture-…`) or a take (`.sporesample`, auto names `take-…`). */
export type SaveKind = "capture" | "take";
const EXTENSION: Readonly<Record<SaveKind, string>> = { capture: CAPTURE_EXTENSION, take: TAKE_EXTENSION };
/** A file name's stem is cut to this many characters (§1.2); the extension is added after. */
const CAPTURE_NAME_MAX_CHARS = 64;

/** The file operations behind a Tauri save; `path`s are absolute. */
export interface SaveFiles {
  /** Creates the folder and any missing parents. */
  mkdir(path: string): Promise<void>;
  /** Writes (or overwrites) the file. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** The names of the files (not folders) directly in `path`. */
  list(path: string): Promise<string[]>;
  remove(path: string): Promise<void>;
}

/** What the saver needs of the platform, the storage, the clock and the compressor. */
export interface SaveEnv {
  /** True inside a Tauri webview (desktop or Android): the file goes to the app's data folder. */
  tauri: boolean;
  /** The file operations the saver needs (Tauri: the engine's `FileSystem`). */
  fs: SaveFiles;
  /** The folder the `recordings/` folder lives in (Tauri: the storage scope's folder, ADR 0317). */
  storageRoot(): Promise<string>;
  /** Hands the bytes to the browser as a download named `fileName`. */
  download(bytes: Uint8Array, fileName: string): void;
  /** deflate-raw of `payload`; null where the runtime has no `CompressionStream` or it failed (the file is then stored raw). */
  compress(payload: Uint8Array): Promise<Uint8Array | null>;
  now(): Date;
}

/** One take, ready to write: the header's facts, META, the ring's span and `truncatedFromSeq` (§5.4). */
export interface SaveTake {
  header: CaptureHeaderInit;
  meta: CaptureMetaInit;
  span: RingSpan;
  /** The first kept seq when the ring wrapped over the take's start, else 0. */
  truncatedFromSeq: number;
  /**
   * ADR 0348: a take's request records (whole records, head and payload, in seq order; their seqs taken from the ring's
   * counter), merged into the span by seq. With it the file is a take (`header.take`).
   */
  requests?: { bytes: Uint8Array; recordCount: number };
}

/**
 * ADR 0348: the ring's span with a take's request records merged in by seq (both streams are in seq order and their seqs
 * come from one counter, so the merge keeps every record's order); the INDEX entries move with their keyframes.
 */
export function mergeRequests(span: RingSpan, requests: { bytes: Uint8Array; recordCount: number }): RingSpan {
  const a = span.bytes;
  const b = requests.bytes;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  const va = new DataView(a.buffer, a.byteOffset, a.byteLength);
  const vb = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const moved = new Map<number, number>();
  let ia = 0;
  let ib = 0;
  let at = 0;
  const copy = (src: Uint8Array, view: DataView, off: number): number => {
    const n = CAPTURE_RECORD_HEAD_BYTES + view.getUint32(off + 4, true);
    if (src === a) moved.set(off, at);
    out.set(src.subarray(off, off + n), at);
    at += n;
    return off + n;
  };
  while (ia + CAPTURE_RECORD_HEAD_BYTES <= a.byteLength || ib + CAPTURE_RECORD_HEAD_BYTES <= b.byteLength) {
    const hasA = ia + CAPTURE_RECORD_HEAD_BYTES <= a.byteLength;
    const hasB = ib + CAPTURE_RECORD_HEAD_BYTES <= b.byteLength;
    if (hasA && (!hasB || va.getUint32(ia + 8, true) < vb.getUint32(ib + 8, true))) ia = copy(a, va, ia);
    else ib = copy(b, vb, ib);
  }
  const keyframes = span.keyframes.map((e) => ({ ...e, byteOffset: moved.get(e.byteOffset) ?? e.byteOffset }));
  return { ...span, bytes: out.subarray(0, at), recordCount: span.recordCount + requests.recordCount, keyframes };
}

// --- names ----------------------------------------------------------------------------------------------------------

const AUTO_NAME: Readonly<Record<SaveKind, RegExp>> = {
  capture: /^capture-(\d{8})-(\d{6})(?:-(\d+))?\.sporesample$/,
  take: /^take-(\d{8})-(\d{6})(?:-(\d+))?\.sporesample$/,
};
const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

let lastAutoStem = "";
let autoRepeats = 0;
let webSaves = 0;

/** `capture-YYYYMMDD-HHMMSS` (`take-…` for a take) in local time; a second save within the same second gets `-2`, `-3`... so none overwrites. */
function autoCaptureStem(now: Date, kind: SaveKind = "capture"): string {
  const stem = `${kind}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  if (stem === lastAutoStem) autoRepeats++;
  else {
    lastAutoStem = stem;
    autoRepeats = 1;
  }
  return autoRepeats > 1 ? `${stem}-${autoRepeats}` : stem;
}

/**
 * The file name for `name` (§1.2): every character outside `[A-Za-z0-9._-]` becomes `_`, leading dots go (no hidden file,
 * no `..`), a `.sporesample` the caller already wrote isn't doubled, the stem is cut to 64 characters and `.sporesample` is appended.
 * An absent name, or one with nothing left, is the auto name. `auto` says which, since only auto-named files rotate.
 */
function captureFileName(name: string | undefined, now: Date, kind: SaveKind = "capture"): { file: string; auto: boolean } {
  const ext = EXTENSION[kind];
  let stem = typeof name === "string" ? name.trim() : "";
  if (stem.toLowerCase().endsWith(ext)) stem = stem.slice(0, -ext.length);
  stem = stem.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, CAPTURE_NAME_MAX_CHARS);
  if (stem) return { file: stem + ext, auto: false };
  return { file: autoCaptureStem(now, kind) + ext, auto: true };
}

/** Downloads this page has started since it loaded: the web trigger stops at `CAPTURE_TRIGGER_MAX_FILES` per session (R16), since a download can't be deleted. */
export function webSaveCount(): number {
  return webSaves;
}

// --- the file -------------------------------------------------------------------------------------------------------

/** The last record's epoch, seq and frame (the INDEX record follows it: seq one past, §5.3), by walking the heads; null for no records. */
function lastRecord(bytes: Uint8Array): { epoch: number; seq: number; frame: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  let last = -1;
  while (off + CAPTURE_RECORD_HEAD_BYTES <= bytes.byteLength) {
    last = off;
    off += CAPTURE_RECORD_HEAD_BYTES + view.getUint32(off + 4, true);
  }
  return last < 0 ? null : { epoch: view.getUint16(last + 2, true), seq: view.getUint32(last + 8, true), frame: view.getFloat64(last + 12, true) };
}

/** A live view's head (R17): the 96 B header and raw META with no records (`openLiveCapture`'s input, `Recorder.startLive`'s `head`). */
export function liveHead(header: CaptureHeaderInit, meta: CaptureMetaInit): Uint8Array {
  return assembleCapture(header, meta, []);
}

/**
 * The whole file, stored (not yet compressed): header, META, the span's records, then an INDEX record listing the span's
 * keyframes (`hasIndex`) and `truncatedFromSeq`. The header's `firstFrame` and `sampleRate` are the span's: a take that
 * starts at a later segment (a start from Held, a truncated ring) begins at its own keyframe.
 */
export function assembleTakeFile(take: SaveTake): Uint8Array {
  const span = take.requests ? mergeRequests(take.span, take.requests) : take.span;
  const init: CaptureHeaderInit = { ...take.header, sampleRate: span.sampleRate || take.header.sampleRate, firstFrame: span.firstFrame, ...(take.requests ? { take: true } : {}) };
  const shell = assembleCapture(init, take.meta, []);
  const header = readCaptureHeader(shell);
  const last = lastRecord(span.bytes);
  const index = encodeRecords([{
    type: RecordType.INDEX, epoch: last?.epoch ?? 0, seq: (last?.seq ?? 0) + 1, frame: last?.frame ?? 0,
    payload: { entries: span.keyframes, truncatedFromSeq: take.truncatedFromSeq },
  }]);
  const out = new Uint8Array(shell.byteLength + span.bytes.byteLength + index.byteLength);
  out.set(shell, 0);
  out.set(span.bytes, shell.byteLength);
  out.set(index, shell.byteLength + span.bytes.byteLength);
  const recordBytes = span.bytes.byteLength + index.byteLength;
  writeCaptureHeader(new DataView(out.buffer), {
    ...header, flags: header.flags | CAPTURE_FLAG_HAS_INDEX, recordBytes, uncompressedBytes: header.metaBytes + recordBytes,
    recordCount: span.recordCount + 1, indexBytes: index.byteLength,
  });
  return out;
}

/** deflate-raw through `CompressionStream` (byte-equal to zlib, §5.1); null when the runtime has none or the stream fails. */
async function deflateRawCompress(payload: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const cs = new CompressionStream("deflate-raw");
    const writer = cs.writable.getWriter();
    writer.write(payload as Uint8Array<ArrayBuffer>).catch(() => {});
    writer.close().catch(() => {});
    const reader = cs.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  } catch {
    return null;
  }
}

/** The stored file with everything after the header compressed and `compressed` set; the stored file itself when `compress` gives null. */
async function compressCapture(file: Uint8Array, compress: SaveEnv["compress"]): Promise<Uint8Array> {
  const packed = await compress(file.subarray(CAPTURE_HEADER_BYTES));
  if (!packed) return file;
  const out = new Uint8Array(CAPTURE_HEADER_BYTES + packed.byteLength);
  out.set(file.subarray(0, CAPTURE_HEADER_BYTES), 0);
  out.set(packed, CAPTURE_HEADER_BYTES);
  const view = new DataView(out.buffer);
  view.setUint16(10, view.getUint16(10, true) | CAPTURE_FLAG_COMPRESSED, true);
  return out;
}

/** The finished file's bytes (compressed where the runtime can): what `saveCapture` writes, for a caller that writes it itself (the editor's project folders). */
export function captureFileBytes(take: SaveTake, compress: SaveEnv["compress"] = deflateRawCompress): Promise<Uint8Array> {
  return compressCapture(assembleTakeFile(take), compress);
}

// --- where it goes --------------------------------------------------------------------------------------------------

/** The folder a kind is saved in, under the storage root. */
const FOLDER: Readonly<Record<SaveKind, string>> = { capture: "recordings", take: "recordings" };

function folderPath(root: string, kind: SaveKind): string {
  return `${root.replace(/[\\/]+$/, "")}/${FOLDER[kind]}`;
}

/** `[date, time, repeat]` of an auto-named file, for ordering; null for any other name. */
function autoOrder(key: string, kind: SaveKind): [string, string, number] | null {
  const m = AUTO_NAME[kind].exec(key);
  return m ? [m[1]!, m[2]!, m[3] ? Number(m[3]) : 1] : null;
}

/**
 * Keeps the newest `keep` (default `CAPTURE_TRIGGER_MAX_FILES`, 16) auto-named files of `kind` in `dir` and deletes the
 * older ones, oldest first (`list`, `remove`). Files a caller named are never touched, and neither is anything else in the
 * folder. Returns the file names it deleted. The built-in trigger (X1) calls this, not a copy of it.
 */
export async function rotateCaptures(files: Pick<SaveFiles, "list" | "remove">, dir: string, keep = CAPTURE_TRIGGER_MAX_FILES, kind: SaveKind = "capture"): Promise<string[]> {
  const base = dir.replace(/[\\/]+$/, "");
  const ordered = (await files.list(dir))
    .map((key) => ({ key, order: autoOrder(key, kind) }))
    .filter((e): e is { key: string; order: [string, string, number] } => e.order !== null)
    .sort((a, b) => (a.order[0] < b.order[0] ? -1 : a.order[0] > b.order[0] ? 1 : a.order[1] < b.order[1] ? -1 : a.order[1] > b.order[1] ? 1 : a.order[2] - b.order[2]));
  const deleted: string[] = [];
  for (const { key } of ordered.slice(0, Math.max(0, ordered.length - keep))) {
    try {
      await files.remove(`${base}/${key}`);
      deleted.push(key);
    } catch {
      // A file that can't be deleted stays; the next save tries again.
    }
  }
  return deleted;
}

/** The browser's download: a `Blob` behind an object URL and a clicked `a[download]`, revoked a moment later. */
function browserDownload(bytes: Uint8Array, fileName: string): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The real platform's environment. */
export function defaultSaveEnv(): SaveEnv {
  return {
    tauri: isTauri(),
    fs: {
      mkdir: async (path) => (await getFileSystem()).mkdir(path),
      write: async (path, bytes) => (await getFileSystem()).writeBinary(path, bytes),
      list: async (path) => (await (await getFileSystem()).list(path)).filter((e) => !e.isDirectory).map((e) => e.name),
      remove: async (path) => (await getFileSystem()).remove(path),
    },
    storageRoot: async () => Storage.root() ?? (await import("@tauri-apps/api/path")).appDataDir(),
    download: browserDownload,
    compress: deflateRawCompress,
    now: () => new Date(),
  };
}


/**
 * Compresses and saves `take`. Resolves with the file name on the web, with the absolute file path on Tauri (and then rotates
 * auto-named files to 16). The span is copied by the caller before this runs, so a ring that goes on recording changes
 * nothing here.
 */
export async function saveCapture(take: SaveTake, name?: string, env: SaveEnv = defaultSaveEnv()): Promise<string> {
  const kind: SaveKind = take.requests ? "take" : "capture";
  const bytes = await captureFileBytes(take, env.compress);
  const { file, auto } = captureFileName(name, env.now(), kind);
  if (!env.tauri) {
    env.download(bytes, file);
    webSaves++;
    return file;
  }
  const dir = folderPath(await env.storageRoot(), kind);
  await env.fs.mkdir(dir);
  await env.fs.write(`${dir}/${file}`, bytes);
  if (auto) await rotateCaptures(env.fs, dir, CAPTURE_TRIGGER_MAX_FILES, kind);
  return `${dir}/${file}`;
}
