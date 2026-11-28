import { describe, expect, it, vi } from "vitest";
import type { GeneratedLods } from "../engine/scene/lod/generate";
import { decodeLods, diskLodCache, encodeLods } from "./lodDiskCache";
import { MemoryFileSystem } from "./memoryFs";

/** A small skinned, morphed mesh with two levels and an occluder, with odd array lengths to test alignment. */
function sample(): GeneratedLods {
  return {
    streams: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 2, 2, 2]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1, 0.5, 0.5]),
      uvs2: null,
      colors: null,
      tangents: new Float32Array(20).fill(0.25),
      joints: new Uint16Array([0, 1, 0, 1, 0, 1, 0, 1, 0, 1]),
      weights: new Float32Array([0.5, 0.5, 0.25, 0.75, 1, 0, 0.1, 0.9, 0.3, 0.7]),
      influences: 2,
      morphs: [{ positions: new Float32Array(15).fill(0.5), normals: null, tangents: null }],
    },
    levels: [
      { indices: new Uint32Array([0, 1, 2, 2, 1, 3, 0, 3, 4]), groups: [{ start: 0, count: 6, materialIndex: 0 }, { start: 6, count: 3, materialIndex: 1 }], error: 0, triangles: 3 },
      { indices: new Uint32Array([0, 1, 2]), groups: [], error: 0.0125, triangles: 1 },
    ],
    occluder: { indices: new Uint32Array([0, 1, 2]), error: 0.0125, triangleErrors: new Float32Array([0.00375]), neighbors: new Uint32Array([0xffffffff, 0xffffffff, 0xffffffff]) },
    bounds: [0, 0, 0, 2, 2, 2],
  };
}

describe("LOD cache files", () => {
  it("round-trip every stream, level, the occluder and the bounds", () => {
    const original = sample();
    const back = decodeLods(encodeLods(original))!;
    expect(back).toEqual(original);
    expect(back.occluder!.triangleErrors).toBeInstanceOf(Float32Array);
    expect(back.occluder!.neighbors).toBeInstanceOf(Uint32Array);
    expect(back.streams.positions).toBeInstanceOf(Float32Array);
    expect(back.streams.joints).toBeInstanceOf(Uint16Array);
    expect(back.levels[0].indices).toBeInstanceOf(Uint32Array);
  });

  it("round-trip a mesh without an occluder or any optional stream", () => {
    const base = sample();
    const bare: GeneratedLods = {
      ...base,
      streams: { ...base.streams, normals: null, uvs: null, tangents: null, joints: null, weights: null, influences: 0, morphs: [] },
      occluder: null,
    };
    expect(decodeLods(encodeLods(bare))).toEqual(bare);
  });

  it("read as a miss when the bytes are not a cache file, are cut short or are another version", () => {
    const bytes = encodeLods(sample());
    expect(decodeLods(new Uint8Array(0))).toBeNull();
    expect(decodeLods(new Uint8Array(32))).toBeNull();
    expect(decodeLods(bytes.subarray(0, bytes.length - 8))).toBeNull();
    expect(decodeLods(bytes.subarray(0, 12))).toBeNull();
    const other = bytes.slice();
    other[0] ^= 1; // the magic
    expect(decodeLods(other)).toBeNull();
  });

  it("read a version 1 file (a stand-in from before hole trimming) as a miss", () => {
    const bytes = encodeLods(sample());
    const text = new TextDecoder("latin1").decode(bytes); // one character per byte
    const at = text.indexOf('"version":2');
    expect(at).toBeGreaterThan(0);
    const old = bytes.slice();
    old.set(new TextEncoder().encode('"version":1'), at);
    expect(decodeLods(old)).toBeNull();
  });
});

describe("diskLodCache", () => {
  const key = "0123456789abcdef:5:9";

  it("keeps levels in the project folder, so a new session finds them", async () => {
    const fs = new MemoryFileSystem();
    const first = diskLodCache(() => ({ fs, root: "C:\\game" }));
    expect(await first.get(key)).toBeUndefined();
    await first.set(key, sample());
    const names = [...fs.files.keys()].filter((k) => k.includes(".myco\\lod\\"));
    expect(names).toHaveLength(1);
    expect(names[0]).not.toContain(":5"); // the key's colons are not in the file name
    // A second cache over the same folder, as after reopening the project.
    const second = diskLodCache(() => ({ fs, root: "C:\\game" }));
    expect(await second.get(key)).toEqual(sample());
  });

  it("serves a hit from memory without reading the folder again", async () => {
    const fs = new MemoryFileSystem();
    const cache = diskLodCache(() => ({ fs, root: "C:\\game" }));
    await cache.set(key, sample());
    const read = vi.spyOn(fs, "readBinary");
    expect(await cache.get(key)).toEqual(sample());
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps levels for the session only in a read-only project", async () => {
    const cache = diskLodCache(() => null);
    await cache.set(key, sample());
    expect(await cache.get(key)).toEqual(sample());
    expect(await diskLodCache(() => null).get(key)).toBeUndefined();
  });

  it("treats a damaged file as a miss and a failing write as harmless", async () => {
    const fs = new MemoryFileSystem();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cache = diskLodCache(() => ({ fs, root: "C:\\game" }));
    await cache.set(key, sample());
    const path = [...fs.files.keys()].find((k) => k.endsWith(".lod"))!;
    fs.files.set(path, new Uint8Array([1, 2, 3]));
    expect(await diskLodCache(() => ({ fs, root: "C:\\game" })).get(key)).toBeUndefined();
    vi.spyOn(fs, "writeBinary").mockRejectedValue(new Error("disk full"));
    await expect(cache.set("other:1:1", sample())).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
