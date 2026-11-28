// The editor's persistent LOD cache (ADR 0446 §1, "Disk cache"): generated levels kept in `.myco/lod/` of a writable
// project folder, beside the thumbnail cache's `.myco/thumbnails/` (ADR 0061), so reopening a project skips generation.
// A read-only project (the samples, a browser without a writable folder) keeps them for the session only. The keys are
// `lodCacheKey`'s, content hashes of the mesh and the settings, so a stale entry can never be hit and a cache file is
// never wrong, only unused: nothing here needs invalidating.
import type { FileSystem } from "../engine/platform/FileSystem";
import type { GeneratedLevel, GeneratedLods, LodGroup } from "../engine/scene/lod/generate";
import { memoryLodCache, type LodCache } from "../engine/scene/lod/cache";
import type { MorphStreams, VertexStreams } from "../engine/scene/lod/streams";
import type { Bounds6 } from "../engine/scene/lod/types";
import { joinPath } from "./projectPaths";
import { currentProject } from "./state";

const FOLDER = ".myco/lod";
const MAGIC = 0x444f4c4d; // "MLOD" read little-endian
const VERSION = 2; // 2: the occluder's per-triangle errors and neighbours (ADR 0447 §3)

type ArrayKind = "f32" | "u16" | "u32";
type TypedArray = Float32Array | Uint16Array | Uint32Array;
const CONSTRUCTORS = { f32: Float32Array, u16: Uint16Array, u32: Uint32Array } as const;

/** What `encodeLods` writes ahead of the array bytes: the structure, with each array a reference into `arrays`. */
interface Meta {
  version: number;
  arrays: { kind: ArrayKind; length: number; offset: number }[];
  streams: Record<"positions" | "normals" | "uvs" | "uvs2" | "colors" | "tangents" | "joints" | "weights", number | null> & {
    influences: number;
    morphs: Record<keyof MorphStreams, number | null>[];
  };
  levels: { indices: number; groups: readonly LodGroup[]; error: number; triangles: number }[];
  occluder: { indices: number; error: number; triangleErrors: number; neighbors: number } | null;
  bounds: Bounds6;
}

const kindOf = (a: TypedArray): ArrayKind => (a instanceof Float32Array ? "f32" : a instanceof Uint16Array ? "u16" : "u32");

/** `lods` as one binary blob: a header and a JSON structure, then every array's bytes (4-byte aligned). */
export function encodeLods(lods: GeneratedLods): Uint8Array {
  const arrays: TypedArray[] = [];
  const ref = (a: TypedArray | null): number | null => (a ? arrays.push(a) - 1 : null);
  const s = lods.streams;
  const meta: Meta = {
    version: VERSION,
    arrays: [],
    streams: {
      positions: ref(s.positions), normals: ref(s.normals), uvs: ref(s.uvs), uvs2: ref(s.uvs2), colors: ref(s.colors),
      tangents: ref(s.tangents), joints: ref(s.joints), weights: ref(s.weights), influences: s.influences,
      morphs: s.morphs.map((m) => ({ positions: ref(m.positions), normals: ref(m.normals), tangents: ref(m.tangents) })),
    },
    levels: lods.levels.map((l) => ({ indices: ref(l.indices)!, groups: l.groups, error: l.error, triangles: l.triangles })),
    occluder: lods.occluder ? { indices: ref(lods.occluder.indices)!, error: lods.occluder.error, triangleErrors: ref(lods.occluder.triangleErrors)!, neighbors: ref(lods.occluder.neighbors)! } : null,
    bounds: lods.bounds,
  };
  let offset = 0;
  for (const a of arrays) {
    meta.arrays.push({ kind: kindOf(a), length: a.length, offset });
    offset += Math.ceil(a.byteLength / 4) * 4;
  }
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const payloadStart = Math.ceil((8 + json.length) / 4) * 4;
  const out = new Uint8Array(payloadStart + offset);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, json.length, true);
  out.set(json, 8);
  arrays.forEach((a, i) => out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), payloadStart + meta.arrays[i].offset));
  return out;
}

/** The levels `encodeLods` wrote, or null for bytes that aren't a (current) cache file or are cut short. */
export function decodeLods(bytes: Uint8Array): GeneratedLods | null {
  try {
    if (bytes.length < 8) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== MAGIC) return null;
    const jsonLength = view.getUint32(4, true);
    if (8 + jsonLength > bytes.length) return null;
    const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + jsonLength))) as Meta;
    if (meta.version !== VERSION) return null;
    const payloadStart = Math.ceil((8 + jsonLength) / 4) * 4;
    const array = <T extends TypedArray>(i: number | null): T | null => {
      if (i === null) return null;
      const a = meta.arrays[i];
      const Ctor = CONSTRUCTORS[a.kind];
      const from = payloadStart + a.offset;
      const to = from + a.length * Ctor.BYTES_PER_ELEMENT;
      if (to > bytes.length) throw new Error("truncated");
      return new Ctor(bytes.slice(from, to).buffer) as T; // a copy: the file's buffer needn't be aligned
    };
    const need = <T extends TypedArray>(i: number | null): T => array<T>(i) ?? (() => { throw new Error("missing array"); })();
    const m = meta.streams;
    const streams: VertexStreams = {
      positions: need<Float32Array>(m.positions), normals: array(m.normals), uvs: array(m.uvs), uvs2: array(m.uvs2), colors: array(m.colors),
      tangents: array(m.tangents), joints: array(m.joints), weights: array(m.weights), influences: m.influences,
      morphs: m.morphs.map((x) => ({ positions: array(x.positions), normals: array(x.normals), tangents: array(x.tangents) })),
    };
    const levels: GeneratedLevel[] = meta.levels.map((l) => ({ indices: need<Uint32Array>(l.indices), groups: l.groups, error: l.error, triangles: l.triangles }));
    if (levels.length === 0) return null;
    const o = meta.occluder;
    const occluder = o ? { indices: need<Uint32Array>(o.indices), error: o.error, triangleErrors: need<Float32Array>(o.triangleErrors), neighbors: need<Uint32Array>(o.neighbors) } : null;
    return { streams, levels, occluder, bounds: meta.bounds };
  } catch {
    return null;
  }
}

/** Where a project keeps its cache: its writable folder, or null (read-only). */
export interface LodCacheFolder {
  readonly fs: FileSystem;
  readonly root: string;
}

/** A key as a file name (the key has a `:`, which Windows file names can't). */
const fileName = (key: string): string => `${key.replace(/[^0-9a-zA-Z_-]/g, "-")}.lod`;

/**
 * A cache that remembers in memory and, where `folder()` gives a writable project folder, on disk. `folder` is asked on
 * every call, so it follows the open project. A file that can't be read or written is a miss (and a warning, once).
 */
export function diskLodCache(folder: () => LodCacheFolder | null): LodCache {
  const memory = memoryLodCache();
  let made: string | null = null;
  let warned = false;
  const warn = (what: string, err: unknown) => {
    if (warned) return;
    warned = true;
    console.warn(`[myco] couldn't ${what} the LOD cache:`, err);
  };
  return {
    async get(key) {
      const hit = await memory.get(key);
      if (hit) return hit;
      const where = folder();
      if (!where) return undefined;
      try {
        const path = joinPath(where.root, `${FOLDER}/${fileName(key)}`);
        if (!(await where.fs.exists(path))) return undefined;
        const decoded = decodeLods(await where.fs.readBinary(path));
        if (decoded) await memory.set(key, decoded);
        return decoded ?? undefined;
      } catch (err) {
        warn("read", err);
        return undefined;
      }
    },
    async set(key, value) {
      await memory.set(key, value);
      const where = folder();
      if (!where) return;
      try {
        const dir = joinPath(where.root, FOLDER);
        if (made !== dir) {
          await where.fs.mkdir(dir);
          made = dir;
        }
        await where.fs.writeBinary(joinPath(dir, fileName(key)), encodeLods(value));
      } catch (err) {
        warn("write", err);
      }
    },
  };
}

/** The editor's cache: `.myco/lod/` of the open project when it can be saved, memory otherwise. */
export function projectLodCache(): LodCache {
  return diskLodCache(() => {
    const p = currentProject.peek();
    return p?.canSave && p.root && p.fileSystem ? { fs: p.fileSystem, root: p.root } : null;
  });
}
