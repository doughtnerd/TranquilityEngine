/**
 * Where LOD generation runs and how its results are kept (ADR 0459 §1, "Cost, caching and the main thread"). Internal:
 * not public API.
 *
 * The editor installs a host (`setLodHost`): a generator (the worker, `workerGenerator.ts`) and a cache. Model loading
 * generates levels only through an installed host, so a game, which installs none and reads baked levels, never
 * generates and never loads meshoptimizer. The export's bake passes its own inline host.
 *
 * Results are cached by a key made of the mesh's input (every stream, the indices and groups, hashed) and the settings.
 * Keying by the mesh rather than the file's bytes alone also covers the sidecar's other settings (scale, axes, normals)
 * that change the mesh. The in-memory cache is the default; the editor can swap in one that persists to disk (T6).
 */
import type { LodSettings, OccluderSetting } from "./types";
import type { GeneratedLods, LodSource } from "./generate";
import { streamArrays } from "./streams";

/** Generates a mesh's levels (`generate.ts`'s `generateLods`, inline or through a worker). */
export type LodGenerator = (source: LodSource, settings: LodSettings, occluder: OccluderSetting) => Promise<GeneratedLods>;

/** Generated levels by key. `get` resolves undefined for a miss. */
export interface LodCache {
  get(key: string): Promise<GeneratedLods | undefined>;
  set(key: string, value: GeneratedLods): Promise<void>;
}

/** Where generation runs, and its cache. */
export interface LodHost {
  readonly generate: LodGenerator;
  readonly cache: LodCache;
}

let installed: LodHost | null = null;

/** @internal Installs the host model loading generates levels through (the editor); null removes it. */
export function setLodHost(host: LodHost | null): void {
  installed = host;
}

/** @internal The installed host, or null (a game). */
export const lodHost = (): LodHost | null => installed;

/** A cache in memory, for this session. */
export function memoryLodCache(): LodCache {
  const entries = new Map<string, GeneratedLods>();
  return {
    get: async (key) => entries.get(key),
    set: async (key, value) => void entries.set(key, value),
  };
}

/** Two 32-bit hashes (FNV-1a and a multiply-xorshift) over the bytes of `arrays`, as 16 hex digits. */
function hashArrays(arrays: readonly ArrayBufferView[]): string {
  let a = 2166136261;
  let b = 0x9e3779b9;
  for (const view of arrays) {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const words = Math.floor(bytes.length / 4);
    const aligned = view.byteOffset % 4 === 0 ? new Uint32Array(view.buffer, view.byteOffset, words) : null;
    for (let i = 0; i < words; i++) {
      const w = aligned ? aligned[i] : bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24);
      a = Math.imul(a ^ w, 16777619);
      b = Math.imul(b ^ w, 0x85ebca6b);
      b ^= b >>> 13;
    }
    for (let i = words * 4; i < bytes.length; i++) {
      a = Math.imul(a ^ bytes[i], 16777619);
      b = Math.imul(b ^ bytes[i], 0x85ebca6b);
    }
    // The length separates [x][yz] from [xy][z].
    a = Math.imul(a ^ bytes.length, 16777619);
    b = Math.imul(b ^ bytes.length, 0xc2b2ae35);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

/**
 * What the generator makes, beyond its input: bumped whenever the same input would give other output, so entries made by
 * an older generator (memory or `.myco/lod/` files) are never hit. 2: hole-trimmed stand-ins with per-triangle errors
 * and neighbours (ADR 0460 §3).
 */
const GENERATOR_VERSION = 2;

/** The cache key of `source` generated with `settings` and `occluder`. */
export function lodCacheKey(source: LodSource, settings: LodSettings, occluder: OccluderSetting): string {
  const s = source.streams;
  const shape = JSON.stringify({
    streams: [s.normals, s.uvs, s.uvs2, s.colors, s.tangents, s.joints, s.weights].map((a) => (a ? a.length : 0)),
    influences: s.influences,
    morphs: s.morphs.map((m) => [m.positions?.length ?? 0, m.normals?.length ?? 0, m.tangents?.length ?? 0]),
    groups: source.groups,
    settings,
    occluder,
    generator: GENERATOR_VERSION,
  });
  return `${hashArrays([...streamArrays(s), source.indices, new TextEncoder().encode(shape)])}:${s.positions.length / 3}:${source.indices.length}`;
}

/** `source`'s levels from `host`'s cache, generating and caching them on a miss. */
export async function cachedLods(host: LodHost, source: LodSource, settings: LodSettings, occluder: OccluderSetting): Promise<GeneratedLods> {
  const key = lodCacheKey(source, settings, occluder);
  const hit = await host.cache.get(key);
  if (hit) return hit;
  const generated = await host.generate(source, settings, occluder);
  await host.cache.set(key, generated);
  return generated;
}
