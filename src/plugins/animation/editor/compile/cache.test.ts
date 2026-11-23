// The editor's compiled-clip cache (T19; ADR 0371, content-keyed like thumbnails, 0061) through its interface, with a
// counting runner in place of the compile worker (the runner is the seam the worker and the in-thread fallback fill):
// a miss compiles once and stores `<key>.anim.bin` with its report, a hit compiles nothing (in memory, and from the store
// in a later session), concurrent asks share one compile, a request that compiles to a new key lets the old files go,
// and pruning removes what no request names.
import { describe, expect, it } from "vitest";
import { ClipCompileCache, memoryClipStore, type CacheJob, type ClipCompileRunner } from "./cache";
import type { ClipReport } from "./compiler";

const REPORT: ClipReport = { rawSize: 100, compressedSize: 10, fileSize: 40, maxError: 5e-5, worstBone: 1, worstFrame: 2, maxPropertyError: 0, worstTrack: -1, channels: [1, 2, 3], withinBounds: true, rotationFormat: "dropW" };
const KEY_A = "a".repeat(20), KEY_B = "b".repeat(20);

function counting(fail = false): ClipCompileRunner & { calls: number } {
  const runner = async (job: Parameters<ClipCompileRunner>[0]) => {
    runner.calls++;
    return fail ? { ok: false as const, error: "no skeleton" } : { ok: true as const, bytes: Uint8Array.from([...job.raw, 9]), report: REPORT };
  };
  runner.calls = 0;
  return runner;
}

const job = (key: string, request = "web\nclips/a.anim.json\n"): CacheJob => ({ request, key, raw: Uint8Array.from([1, 2]), skeleton: new Uint8Array(0), record: new Float32Array(8) });

describe("the compiled-clip cache", () => {
  it("compiles on a miss and stores the clip and its report under its key", async () => {
    const store = memoryClipStore();
    const runner = counting();
    const cache = new ClipCompileCache(store, runner);
    expect(await cache.cached(KEY_A)).toBeNull();
    const clip = await cache.get(job(KEY_A));
    expect(clip).toEqual({ key: KEY_A, bytes: Uint8Array.from([1, 2, 9]), report: REPORT });
    expect(runner.calls).toBe(1);
    expect((await store.list()).sort()).toEqual([`${KEY_A}.anim.bin`, `${KEY_A}.report.json`, "index.json"]);
    expect(cache.peek(KEY_A)).toEqual(clip);
  });

  it("compiles nothing on a hit: from memory, and from the store in a later session", async () => {
    const store = memoryClipStore();
    const runner = counting();
    await new ClipCompileCache(store, runner).get(job(KEY_A));
    const later = new ClipCompileCache(store, runner);
    expect(later.peek(KEY_A)).toBeNull();
    expect(await later.get(job(KEY_A))).toMatchObject({ key: KEY_A, report: REPORT });
    expect(await later.get(job(KEY_A))).toMatchObject({ key: KEY_A });
    expect(runner.calls).toBe(1);
    expect(await later.keyOf("web\nclips/a.anim.json\n")).toBe(KEY_A);
  });

  it("shares one compile between concurrent asks for a key", async () => {
    const runner = counting();
    const cache = new ClipCompileCache(memoryClipStore(), runner);
    const [a, b] = await Promise.all([cache.get(job(KEY_A)), cache.get(job(KEY_A, "web\nclips/b.anim.json\n"))]);
    expect(a).toBe(b);
    expect(runner.calls).toBe(1);
  });

  it("lets a request's old key go when it compiles to a new one, unless another request still names it", async () => {
    const store = memoryClipStore();
    const cache = new ClipCompileCache(store, counting());
    await cache.get(job(KEY_A, "r1"));
    await cache.get(job(KEY_A, "r2"));
    await cache.get(job(KEY_B, "r1"));
    expect(await store.read(`${KEY_A}.anim.bin`)).not.toBeNull(); // r2 still names it
    await cache.get(job(KEY_B, "r2"));
    await cache.keyOf("r2"); // the index settles
    expect(await store.read(`${KEY_A}.anim.bin`)).toBeNull();
    expect(await store.read(`${KEY_A}.report.json`)).toBeNull();
    expect(await store.read(`${KEY_B}.anim.bin`)).not.toBeNull();
  });

  it("prunes files no request names and requests whose clip is gone", async () => {
    const store = memoryClipStore();
    const cache = new ClipCompileCache(store, counting());
    await cache.get(job(KEY_A, "keep"));
    await cache.get(job(KEY_B, "gone"));
    await store.write(`${"c".repeat(20)}.anim.bin`, new Uint8Array(1)); // a stray file
    await store.write("notes.txt", new Uint8Array(1)); // not a cache file: left alone
    expect(await cache.prune((request) => request === "keep")).toBe(3);
    expect((await store.list()).sort()).toEqual([`${KEY_A}.anim.bin`, `${KEY_A}.report.json`, "index.json", "notes.txt"]);
    expect(await cache.keyOf("gone")).toBeNull();
  });

  it("answers null and says why when the compile fails, and stores nothing", async () => {
    const store = memoryClipStore();
    const errors: string[] = [];
    expect(await new ClipCompileCache(store, counting(true)).get(job(KEY_A), (e) => errors.push(e))).toBeNull();
    expect(errors).toEqual(["no skeleton"]);
    expect(await store.read(`${KEY_A}.anim.bin`)).toBeNull();
  });
});
