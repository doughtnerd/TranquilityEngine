// Ed1 (api-and-models §7): the waveform peaks service. `get(path)` returns a clip's mip levels (`peaksMip.ts`), decoded and
// reduced in the decoder worker (`computePeaks`) and cached per asset path and mtime: the same mtime is a hit, a newer
// (or any different) mtime recomputes, and a request that a newer mtime superseded is cancelled in the worker and its
// result dropped. Concurrent requests for one path and mtime share one computation. The main thread reads the file,
// posts it (transferred), and builds the mips from the base level; the decode itself never runs here.
import type { DecoderClient } from "../../runtime/decoder/decoderClient";
import { hintFromName } from "../../runtime/decoder/protocol";
import { buildMips, type PeakMips } from "./peaksMip";

/** Frames per base bin the editor asks for (§7: the view draws one bin per pixel at most; 256 frames is 172 bins/s at 44.1 kHz). */
export const PEAKS_BIN_FRAMES = 256;

/** Where the service reads a project file from (the editor passes the project's file API; tests pass a map). */
export interface PeaksSource {
  /** The file's modification time in ms (any number that changes when the file does). Rejects when the file is missing. */
  mtime(path: string): Promise<number>;
  /** The file's bytes; the service transfers the buffer to the worker, so it must be one the caller may lose. */
  read(path: string): Promise<ArrayBuffer>;
}

export interface PeaksServiceOptions {
  /** The decoder client (`createDecoderClient()` in the editor, a fake in tests). */
  readonly client: Pick<DecoderClient, "computePeaks">;
  readonly source: PeaksSource;
  /** Frames per base bin; default `PEAKS_BIN_FRAMES`. */
  readonly binFrames?: number;
}

export interface PeaksService {
  /** The clip's mips, from the cache when its mtime matches, else computed. Rejects with the reader's or decoder's error; a failure is not cached. */
  get(path: string): Promise<PeakMips>;
  /** The cached mips when they are for the file's current mtime as last seen by `get`; never starts work (the view draws a placeholder until `get` resolves). */
  peek(path: string): PeakMips | undefined;
  /** Drops one path's cache (and cancels its computation), e.g. after an import over it. */
  invalidate(path: string): void;
  /** Drops everything (a project switch). */
  clear(): void;
}

interface Entry {
  readonly mtime: number;
  /** Set once computed. */
  mips?: PeakMips;
  readonly promise: Promise<PeakMips>;
  readonly abort: AbortController;
}

export function createPeaksService(options: PeaksServiceOptions): PeaksService {
  const { client, source } = options;
  const binFrames = options.binFrames ?? PEAKS_BIN_FRAMES;
  const entries = new Map<string, Entry>();

  const start = (path: string, mtime: number): Entry => {
    const abort = new AbortController();
    const promise = (async (): Promise<PeakMips> => {
      const bytes = await source.read(path);
      if (abort.signal.aborted) throw abortError();
      const base = await client.computePeaks(bytes, hintFromName(path), binFrames, { transfer: true, asset: path, signal: abort.signal });
      if (abort.signal.aborted) throw abortError();
      const level = { binFrames: base.binFrames, bins: base.bins, channels: base.channels, data: base.peaks };
      return { rate: base.rate, channels: base.channels, frames: base.frames, levels: buildMips(level) };
    })();
    const entry: Entry = { mtime, promise, abort };
    promise.then(
      (mips) => {
        entry.mips = mips;
      },
      () => {
        // A failure (or a cancel) is not cached: the next `get` tries again.
        if (entries.get(path) === entry) entries.delete(path);
      },
    );
    return entry;
  };

  return {
    async get(path) {
      const mtime = await source.mtime(path);
      const held = entries.get(path);
      if (held && held.mtime === mtime) return held.promise;
      held?.abort.abort(); // stale: stop its decode, drop its result
      const entry = start(path, mtime);
      entries.set(path, entry);
      return entry.promise;
    },
    peek: (path) => entries.get(path)?.mips,
    invalidate(path) {
      entries.get(path)?.abort.abort();
      entries.delete(path);
    },
    clear() {
      for (const e of entries.values()) e.abort.abort();
      entries.clear();
    },
  };
}

function abortError(): Error {
  const e = new Error("peaks: the computation was superseded");
  e.name = "AbortError";
  return e;
}
