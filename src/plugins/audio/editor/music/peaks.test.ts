// Ed1: the peaks service over a fake decoder client and a map-backed source: cache per path and mtime, stale recompute,
// sharing of concurrent requests, cancel of a superseded computation, failures not cached.
import { describe, expect, it } from "vitest";
import type { DecodedPeaks } from "../../runtime/decoder/decoderClient";
import { createPeaksService, PEAKS_BIN_FRAMES, type PeaksSource } from "./peaks";

interface Call {
  readonly bytes: ArrayBuffer;
  readonly hint: number;
  readonly binFrames: number;
  readonly asset?: string;
  readonly signal?: AbortSignal;
  resolve(p: DecodedPeaks): void;
  reject(e: unknown): void;
}

function setup() {
  const files = new Map<string, { mtime: number; size: number }>();
  const calls: Call[] = [];
  const reads: string[] = [];
  const source: PeaksSource = {
    mtime: async (path) => {
      const f = files.get(path);
      if (!f) throw new Error(`no file ${path}`);
      return f.mtime;
    },
    read: async (path) => {
      reads.push(path);
      return new ArrayBuffer(files.get(path)!.size);
    },
  };
  const client = {
    computePeaks(bytes: ArrayBuffer | Uint8Array, hint: number, binFrames: number, o?: { signal?: AbortSignal; asset?: string }) {
      return new Promise<DecodedPeaks>((resolve, reject) => {
        const call: Call = { bytes: bytes as ArrayBuffer, hint, binFrames, asset: o?.asset, signal: o?.signal, resolve, reject };
        o?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        calls.push(call);
      });
    },
  };
  const service = createPeaksService({ client, source });
  return { files, calls, reads, service };
}

/** A base level of `bins` bins for a mono clip: bin i holds [-i, i]. */
function peaksFor(bins: number): DecodedPeaks {
  const peaks = new Int16Array(bins * 2);
  for (let i = 0; i < bins; i++) {
    peaks[i * 2] = -i;
    peaks[i * 2 + 1] = i;
  }
  return { rate: 44100, channels: 1, frames: bins * PEAKS_BIN_FRAMES, binFrames: PEAKS_BIN_FRAMES, bins, peaks };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("peaks service", () => {
  it("requests the clip with its hint, asset path and 256-frame bins, and returns mips whose level 0 is the base", async () => {
    const { files, calls, service } = setup();
    files.set("music/a.flac", { mtime: 1, size: 10 });
    const got = service.get("music/a.flac");
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ hint: 2, binFrames: 256, asset: "music/a.flac" });
    expect(calls[0].bytes.byteLength).toBe(10);
    calls[0].resolve(peaksFor(8));
    const mips = await got;
    expect(mips).toMatchObject({ rate: 44100, channels: 1, frames: 8 * 256 });
    expect(mips.levels[0]).toMatchObject({ binFrames: 256, bins: 8, channels: 1 });
    expect(mips.levels[0].data).toEqual(peaksFor(8).peaks);
    expect(mips.levels.length).toBeGreaterThan(1);
    expect(mips.levels[mips.levels.length - 1].bins).toBe(1);
  });

  it("the same path and mtime is a hit: no second read, no second computation", async () => {
    const { files, calls, reads, service } = setup();
    files.set("a.wav", { mtime: 5, size: 4 });
    const first = service.get("a.wav");
    await tick();
    calls[0].resolve(peaksFor(4));
    const a = await first;
    expect(await service.get("a.wav")).toBe(a);
    expect(service.peek("a.wav")).toBe(a);
    expect(calls).toHaveLength(1);
    expect(reads).toEqual(["a.wav"]);
  });

  it("concurrent requests for one path and mtime share one computation", async () => {
    const { files, calls, service } = setup();
    files.set("a.wav", { mtime: 5, size: 4 });
    const p1 = service.get("a.wav");
    const p2 = service.get("a.wav");
    await tick();
    expect(calls).toHaveLength(1);
    calls[0].resolve(peaksFor(4));
    expect(await p1).toBe(await p2);
  });

  it("a new mtime recomputes, and cancels the stale computation still running", async () => {
    const { files, calls, service } = setup();
    files.set("a.wav", { mtime: 1, size: 4 });
    const stale = service.get("a.wav");
    stale.catch(() => undefined);
    await tick();
    files.set("a.wav", { mtime: 2, size: 8 });
    const fresh = service.get("a.wav");
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[0].signal?.aborted).toBe(true);
    await expect(stale).rejects.toMatchObject({ name: "AbortError" });
    calls[1].resolve(peaksFor(16));
    expect((await fresh).levels[0].bins).toBe(16);
    expect(service.peek("a.wav")?.levels[0].bins).toBe(16);
  });

  it("a finished entry with a stale mtime is replaced, not returned", async () => {
    const { files, calls, service } = setup();
    files.set("a.wav", { mtime: 1, size: 4 });
    const first = service.get("a.wav");
    await tick();
    calls[0].resolve(peaksFor(4));
    await first;
    files.set("a.wav", { mtime: 9, size: 4 });
    const second = service.get("a.wav");
    await tick();
    calls[1].resolve(peaksFor(6));
    expect((await second).levels[0].bins).toBe(6);
  });

  it("different paths are cached independently", async () => {
    const { files, calls, service } = setup();
    files.set("a.wav", { mtime: 1, size: 4 });
    files.set("b.wav", { mtime: 1, size: 4 });
    const a = service.get("a.wav");
    const b = service.get("b.wav");
    await tick();
    expect(calls.map((c) => c.asset)).toEqual(["a.wav", "b.wav"]);
    calls[0].resolve(peaksFor(2));
    calls[1].resolve(peaksFor(3));
    expect((await a).levels[0].bins).toBe(2);
    expect((await b).levels[0].bins).toBe(3);
  });

  it("a decode failure rejects and is not cached", async () => {
    const { files, calls, service } = setup();
    files.set("a.wav", { mtime: 1, size: 4 });
    const bad = service.get("a.wav");
    await tick();
    calls[0].reject(new Error("bad file"));
    await expect(bad).rejects.toThrow("bad file");
    expect(service.peek("a.wav")).toBeUndefined();
    const again = service.get("a.wav");
    await tick();
    expect(calls).toHaveLength(2);
    calls[1].resolve(peaksFor(2));
    await again;
  });

  it("a missing file rejects with the source's error", async () => {
    const { service } = setup();
    await expect(service.get("nope.wav")).rejects.toThrow("no file nope.wav");
  });

  it("invalidate drops the cache and cancels a running computation; clear drops all", async () => {
    const { files, calls, service } = setup();
    files.set("a.wav", { mtime: 1, size: 4 });
    const running = service.get("a.wav");
    running.catch(() => undefined);
    await tick();
    service.invalidate("a.wav");
    expect(calls[0].signal?.aborted).toBe(true);
    const next = service.get("a.wav");
    await tick();
    expect(calls).toHaveLength(2);
    calls[1].resolve(peaksFor(2));
    await next;
    expect(service.peek("a.wav")).toBeDefined();
    service.clear();
    expect(service.peek("a.wav")).toBeUndefined();
  });
});
