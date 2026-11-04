import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../memoryFs";
import { computePeaks, decodeSummary, encodeSummary } from "./audio";
import { contentKey, keyOfFile, previewDependencies, previewKind } from "./keys";
import { FrameQueue } from "./queue";
import { ThumbnailService, type ThumbnailMaker, type ThumbnailProject } from "./service";
import { memoryStore, projectStore } from "./store";

const enc = (s: string) => new TextEncoder().encode(s);

/** A project from text and binary files; `stamp` follows edits made through `set`. */
function project(files: Record<string, string | Uint8Array>): ThumbnailProject & { set(path: string, v: string | Uint8Array): void; remove(path: string): void } {
  const map = new Map(Object.entries(files));
  const versions = new Map<string, number>();
  return {
    get files() {
      return [...map.keys()].sort();
    },
    text: (p) => (typeof map.get(p) === "string" ? (map.get(p) as string) : undefined),
    bytes: async (p) => {
      const v = map.get(p);
      if (v === undefined) throw new Error(`no ${p}`);
      return typeof v === "string" ? enc(v) : v;
    },
    stamp: (p) => (map.has(p) ? String(versions.get(p) ?? 0) : undefined),
    set(p, v) {
      map.set(p, v);
      versions.set(p, (versions.get(p) ?? 0) + 1);
    },
    remove(p) {
      map.delete(p);
    },
  };
}

/** Renders a fake image per call, counting calls. */
function maker(): ThumbnailMaker & { renders: string[] } {
  const renders: string[] = [];
  return {
    renders,
    async render(kind, path) {
      renders.push(path);
      return new Blob([enc(`${kind}:${path}`)], { type: "image/webp" });
    },
    async decodeAudio() {
      return { peaks: [0, 0.5, 1], duration: 2, channels: 2, sampleRate: 44100 };
    },
  };
}

/** A queue that runs each frame when `tick` is called. */
function manualQueue(perFrame = 2) {
  const frames: (() => void)[] = [];
  const queue = new FrameQueue(perFrame, (cb) => frames.push(cb));
  const tick = async () => {
    const run = frames.splice(0);
    run.forEach((f) => f());
    await new Promise((r) => setTimeout(r, 0));
  };
  return { queue, tick, frames };
}

describe("thumbnail kinds and dependencies (ADR 0061)", () => {
  it("previews models, materials, graphs, environments, effects, prefabs and audio, not images or scenes", () => {
    expect(previewKind("models/robot.fbx")).toBe("model");
    expect(previewKind("models/crate.OBJ")).toBe("model");
    expect(previewKind("materials/wood.material.json")).toBe("material");
    expect(previewKind("shaders/water.shadergraph.json")).toBe("shadergraph");
    expect(previewKind("sky/studio.hdr")).toBe("environment");
    expect(previewKind("effects/fire.particles.json")).toBe("particles");
    expect(previewKind("prefabs/pipe.prefab.json")).toBe("prefab");
    expect(previewKind("music/town.mp3")).toBe("audio");
    for (const p of ["images/bird.png", "images/sheet.png#walk", "scenes/main.scene.json", "data.json", "models/robot.fbx.meta.json"]) expect(previewKind(p), p).toBeNull();
  });

  it("follows JSON references transitively, with or without asset:, and ignores strings that aren't files", () => {
    const src = project({
      "prefabs/crate.prefab.json": JSON.stringify({ nodes: [{ components: [{ data: { mesh: "asset:models/crate.obj", material: "materials/wood.material.json", note: "hello" } }] }] }),
      "materials/wood.material.json": JSON.stringify({ shader: "asset:shaders/grain.shadergraph.json", texture: "asset:images/wood.png" }),
      "shaders/grain.shadergraph.json": JSON.stringify({ properties: [{ value: "asset:images/noise.png" }] }),
      "models/crate.obj": "mtllib crate.mtl\nv 0 0 0\n",
      "models/crate.mtl": "newmtl a\nmap_Kd -bm 1 tex/crate.png\n",
      "models/tex/crate.png": new Uint8Array([1]),
      "images/wood.png": new Uint8Array([2]),
      "images/wood.png.meta.json": "{}",
      "images/noise.png": new Uint8Array([3]),
    });
    expect(previewDependencies("prefabs/crate.prefab.json", src)).toEqual([
      "images/noise.png",
      "images/wood.png",
      "images/wood.png.meta.json",
      "materials/wood.material.json",
      "models/crate.mtl",
      "models/crate.obj",
      "models/tex/crate.png",
      "shaders/grain.shadergraph.json",
    ]);
  });

  it("cuts reference cycles", () => {
    const src = project({ "a.prefab.json": JSON.stringify({ x: "b.prefab.json" }), "b.prefab.json": JSON.stringify({ x: "asset:a.prefab.json" }) });
    expect(previewDependencies("a.prefab.json", src)).toEqual(["b.prefab.json"]);
  });

  it("keys by content: same files, same key; any byte or the kind changes it; paths don't", async () => {
    const a = await contentKey("material", enc("{}"), [enc("img")]);
    expect(a).toMatch(/^[0-9a-f]{20}$/);
    expect(await contentKey("material", enc("{}"), [enc("img")])).toBe(a);
    expect(await contentKey("material", enc("{}"), [enc("imh")])).not.toBe(a);
    expect(await contentKey("prefab", enc("{}"), [enc("img")])).not.toBe(a);
    // Length-prefixed: moving a byte between parts changes the key.
    expect(await contentKey("material", enc("{}i"), [enc("mg")])).not.toBe(a);
    expect(keyOfFile(`${a}.webp`)).toBe(a);
    expect(keyOfFile(`${a}.peaks.json`)).toBe(a);
    expect(keyOfFile("notes.txt")).toBeNull();
  });
});

describe("frame queue", () => {
  it("starts at most N jobs a frame and runs at most N at once, dropping aborted ones", async () => {
    const { queue, tick } = manualQueue(2);
    const started: number[] = [];
    const gates: (() => void)[] = [];
    const job = (i: number) => () => new Promise<number>((resolve) => {
      started.push(i);
      gates.push(() => resolve(i));
    });
    const abort = new AbortController();
    const results = [queue.run(job(1)), queue.run(job(2)), queue.run(job(3), abort.signal), queue.run(job(4))];
    abort.abort();
    const dropped = expect(results[2]).rejects.toMatchObject({ name: "AbortError" });
    await tick();
    expect(started).toEqual([1, 2]);
    await tick();
    expect(started).toEqual([1, 2]); // both still running
    gates.splice(0).forEach((g) => g());
    await tick();
    await tick();
    expect(started).toEqual([1, 2, 4]);
    gates.splice(0).forEach((g) => g());
    await dropped;
    expect(await Promise.all([results[0], results[1], results[3]])).toEqual([1, 2, 4]);
  });
});

describe("thumbnail service", () => {
  const runAll = async (tick: () => Promise<void>, p: Promise<unknown>) => {
    let done = false;
    void p.finally(() => (done = true));
    for (let i = 0; i < 20 && !done; i++) await tick();
    return p;
  };

  it("renders once, stores it, and reads it back in a new session without rendering", async () => {
    const files = project({ "materials/wood.material.json": "{}" });
    const store = memoryStore();
    const m = maker();
    const { queue, tick } = manualQueue();
    const service = new ThumbnailService(files, store, m, queue);
    const first = await runAll(tick, service.thumbnailFor("materials/wood.material.json"));
    expect(first).not.toBeNull();
    expect(m.renders).toEqual(["materials/wood.material.json"]);
    expect([...store.files.keys()][0]).toMatch(/^[0-9a-f]{20}\.webp$/);
    await service.thumbnailFor("materials/wood.material.json");
    expect(m.renders.length).toBe(1);
    // A new session (or another machine with the same files): straight from the store.
    const m2 = maker();
    const again = await new ThumbnailService(files, store, m2, manualQueue().queue).thumbnailFor("materials/wood.material.json");
    expect(again).not.toBeNull();
    expect(m2.renders).toEqual([]);
  });

  it("re-renders when the asset or a dependency changes, and a renamed asset keeps its thumbnail", async () => {
    const files = project({ "materials/wood.material.json": JSON.stringify({ texture: "asset:images/wood.png" }), "images/wood.png": new Uint8Array([1]) });
    const store = memoryStore();
    const m = maker();
    const { queue, tick } = manualQueue();
    const service = new ThumbnailService(files, store, m, queue);
    const k1 = await service.keyFor("materials/wood.material.json");
    files.set("images/wood.png", new Uint8Array([2]));
    const k2 = await service.keyFor("materials/wood.material.json");
    expect(k2).not.toBe(k1);
    await runAll(tick, service.thumbnailFor("materials/wood.material.json"));
    expect(m.renders.length).toBe(1);
    files.set("materials/oak.material.json", files.text("materials/wood.material.json")!);
    files.remove("materials/wood.material.json");
    expect(await service.keyFor("materials/oak.material.json")).toBe(k2);
    await service.thumbnailFor("materials/oak.material.json");
    expect(m.renders.length).toBe(1);
  });

  it("reads .obj and .mtl files the project serves only as bytes, so a texture change re-keys the model", async () => {
    const files = project({ "m/crate.obj": "mtllib crate.mtl\n", "m/crate.mtl": "map_Kd crate.png\n", "m/crate.png": new Uint8Array([1]) });
    const bytesOnly: ThumbnailProject = { ...files, files: files.files, text: (p) => (p.endsWith(".json") ? files.text(p) : undefined), bytes: files.bytes, stamp: files.stamp };
    const service = new ThumbnailService(bytesOnly, memoryStore(), maker(), manualQueue().queue);
    const k1 = await service.keyFor("m/crate.obj");
    files.set("m/crate.png", new Uint8Array([2]));
    const k2 = await service.keyFor("m/crate.obj");
    expect(k1).toMatch(/^[0-9a-f]{20}$/);
    expect(k2).not.toBe(k1);
  });

  it("has no thumbnail for images, scenes or missing files", async () => {
    const service = new ThumbnailService(project({ "images/a.png": new Uint8Array([1]) }), memoryStore(), maker(), manualQueue().queue);
    expect(await service.thumbnailFor("images/a.png")).toBeNull();
    expect(await service.thumbnailFor("models/gone.fbx")).toBeNull();
  });

  it("summarises audio once and keeps the peaks in the store", async () => {
    const store = memoryStore();
    const service = new ThumbnailService(project({ "sfx/hit.wav": new Uint8Array([9]) }), store, maker(), manualQueue().queue);
    expect(await service.audioSummaryFor("sfx/hit.wav")).toEqual({ peaks: [0, 0.5, 1], duration: 2, channels: 2, sampleRate: 44100 });
    expect([...store.files.keys()][0]).toMatch(/\.peaks\.json$/);
  });

  it("prunes stored files no asset uses, keeping current ones and unrelated files", async () => {
    const files = project({ "a.material.json": "{}", "b.material.json": '{"x":1}' });
    const store = memoryStore();
    const service = new ThumbnailService(files, store, maker(), manualQueue().queue);
    const ka = (await service.keyFor("a.material.json"))!;
    await store.write(ka, "webp", new Uint8Array([1]));
    await store.write("0123456789abcdef0123", "webp", new Uint8Array([1])); // an old version
    await store.write("readme", "webp", new Uint8Array([1])); // not a thumbnail name
    expect(await service.prune()).toBe(1);
    expect((await store.list()).sort()).toEqual([`${ka}.webp`, "readme.webp"].sort());
  });

  it("deletes nothing when an asset couldn't be read, since its thumbnail can't be told apart", async () => {
    const files = project({ "a.material.json": "{}", "models/locked.fbx": new Uint8Array([1]) });
    const store = memoryStore();
    const service = new ThumbnailService({ ...files, files: files.files, bytes: async (p) => (p.endsWith(".fbx") ? Promise.reject(new Error("locked")) : files.bytes(p)) }, store, maker(), manualQueue().queue);
    await store.write("0123456789abcdef0123", "webp", new Uint8Array([1])); // maybe the locked model's
    expect(await service.prune()).toBe(0);
    expect(await store.list()).toEqual(["0123456789abcdef0123.webp"]);
  });

  it("drops a shared render only when every caller that can go away has gone", async () => {
    const files = project({ "a.material.json": "{}" });
    const m = maker();
    const { queue, tick } = manualQueue();
    const service = new ThumbnailService(files, memoryStore(), m, queue);
    const tile = new AbortController();
    const fromTile = service.thumbnailFor("a.material.json", tile.signal);
    await new Promise((r) => setTimeout(r, 0)); // the tile's request is in flight
    const fromInspector = service.thumbnailFor("a.material.json"); // asks for the same image, no signal
    await new Promise((r) => setTimeout(r, 0));
    tile.abort(); // the tile scrolls away
    const [a, b] = await Promise.all([runAll(tick, fromTile), runAll(tick, fromInspector)]);
    expect(b).not.toBeNull();
    expect(a).toEqual(b);
    expect(m.renders.length).toBe(1);

    // Two tiles, both gone: the render is dropped.
    const files2 = project({ "b.material.json": "{}" });
    const m2 = maker();
    const q2 = manualQueue();
    const service2 = new ThumbnailService(files2, memoryStore(), m2, q2.queue);
    const one = new AbortController();
    const two = new AbortController();
    const p1 = service2.thumbnailFor("b.material.json", one.signal);
    await new Promise((r) => setTimeout(r, 0));
    const p2 = service2.thumbnailFor("b.material.json", two.signal);
    await new Promise((r) => setTimeout(r, 0));
    one.abort();
    two.abort();
    expect(await runAll(q2.tick, Promise.all([p1, p2]))).toEqual([null, null]);
    expect(m2.renders).toEqual([]);
  });

  it("makes no object URL for a thumbnail that arrives after the service was disposed", async () => {
    const files = project({ "a.material.json": "{}" });
    const store = memoryStore();
    const key = (await new ThumbnailService(files, store, maker(), manualQueue().queue).keyFor("a.material.json"))!;
    await store.write(key, "webp", new Uint8Array([1]));
    let release!: () => void;
    const slow = { ...store, read: async (k: string, ext: Parameters<typeof store.read>[1]) => (await new Promise<void>((r) => (release = r)), store.read(k, ext)) };
    const service = new ThumbnailService(files, slow, maker(), manualQueue().queue);
    const created: string[] = [];
    const original = URL.createObjectURL;
    URL.createObjectURL = (b: Blob) => (created.push("url"), original(b));
    try {
      const pending = service.thumbnailFor("a.material.json");
      await new Promise((r) => setTimeout(r, 0));
      service.dispose(); // the project closes while the read is in flight
      release();
      expect(await pending).toBeNull();
      expect(created).toEqual([]);
    } finally {
      URL.createObjectURL = original;
    }
  });
});

describe("thumbnail store", () => {
  it("writes .myco/thumbnails in the project folder", async () => {
    const fs = new MemoryFileSystem();
    const store = projectStore(fs, "C:\\games\\flappy");
    await store.write("0123456789abcdef0123", "webp", new Uint8Array([7]));
    expect(await store.read("0123456789abcdef0123", "webp")).toEqual(new Uint8Array([7]));
    expect(await store.read("0123456789abcdef0124", "webp")).toBeNull();
    expect(await store.list()).toEqual(["0123456789abcdef0123.webp"]);
    expect([...fs.files.keys()][0]).toBe("C:\\games\\flappy\\.myco\\thumbnails\\0123456789abcdef0123.webp");
  });
});

describe("audio summaries", () => {
  it("takes the loudest sample per slice across channels", () => {
    const left = new Float32Array([0, 0.5, -1, 0.2]);
    const right = new Float32Array([0.1, -0.7, 0, 0]);
    expect(computePeaks([left, right], 2)).toEqual([0.7, 1]);
    expect(computePeaks([], 3)).toEqual([0, 0, 0]);
  });

  it("round-trips through the cache format", () => {
    const s = { peaks: [0, 0.25], duration: 1.5, channels: 1, sampleRate: 48000 };
    expect(decodeSummary(encodeSummary(s))).toEqual(s);
    expect(decodeSummary(enc("nope"))).toBeNull();
  });
});
