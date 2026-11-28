/**
 * Baked models (ADR 0090): a model's meshes as the engine uses them, already baked into model space
 * with its import settings, in one binary file the exporter writes beside the model in game builds
 * (`models/robot.fbx` → `models/robot.fbx.mycomesh`). Loading one needs no model loader, no parsing
 * and no three.js: typed arrays are views of the file's bytes. Internal: nothing here is public API.
 *
 * Layout (little-endian): the magic `MYCOMESH`, a u32 version (5), a u32 JSON length, the JSON
 * (UTF-8, padded with spaces to 4 bytes), then the binary data every offset in the JSON points into
 * (each 4-byte aligned).
 *
 * ```jsonc
 * {
 *   "settings": { "scale": 1, "upAxis": "y", "normals": "import", "facing": "forward", "lod": {…} | null, "occluder": "auto" },  // what it was baked with
 *   "meshes": [{ "name": "Body", "path": ["Robot"], "positions": [offset, count], "normals": …,
 *                "uvs": …, "uvs2": …, "colors": …, "indices": [offset, count], "groups": […], "surfaces": [0, 1],
 *                "pose": { … }, "variantSurfaces": { "Red": [2, 1] } }],          // pose, variants: ADR 0118
 *   "surfaces": [{ …SurfaceInfo, textures as { "path": "textures/a.png" } or { "image": 0 } }],
 *   "nodes": [{ …ModelNode }], "variants": ["Red", "Blue"],                     // ADR 0118
 *   "images": [{ "offset": 0, "length": 1234, "mimeType": "image/png" }],
 *   // ADR 0371: per mesh "skin": { "influences", "joints": [offset, count] (u16), "weights", "inverseBinds"? },
 *   // "morphTargets": [{ "name", "positions", "normals", "tangents" }], "tangents", "hidden"; and the model's
 *   "animation": { "skeleton": { "bones": […], "inverseBinds": [offset, count], "roles", "profile" },
 *                  "takes": [{ "name", "duration", "tracks": [0371 tracks] }], "clips": [{ "name", "take", "source": myco.anim-source@1, "settings" }],
 *                  "boneMap": {…}, "boneMapSource": "guessed" }
 *   // ADR 0459: per mesh with generated levels (LOD0 is its "indices", its vertices welded and reordered)
 *   // "lods": [{ "indices": [offset, count], "groups": […], "error": 0.006, "triangles": 512 }],
 *   // "occluder": { "indices", "error", "triangleErrors": [offset, count] (f32), "neighbors": [offset, count] (u32) },
 *   //   (ADR 0460 §3: hole-trimmed; a stand-in without its per-triangle arrays loads as none)
 *   // "bounds": [minX, minY, minZ, maxX, maxY, maxZ], "pixelError": 1
 * }
 * ```
 *
 * A file of another version (older or newer) is refused, and the model loads from its file instead.
 */
import type { ImportSettings } from "./importSettings";
import { LAYER_MAP_KEYS, type MeshData, type ModelAnimation, type ModelData, type ModelMesh, type ModelNode, type NodePose, type SurfaceInfo, type TextureInfo } from "./models";
import { modelAnimationToJson, type ImportedClip } from "../animation/import/clips";
import type { ImportedBone, MeshSkin, MorphTargetData } from "../animation/import/skeleton";
import { animSourceToJson, parseAnimSource } from "../animation/animSource";
import { parseTracks, trackToJson } from "../animation/tracks";
import { LenientReader } from "../animation/shared";
import { attachLods } from "./lod/meshLods";
import type { Bounds6 } from "./lod/types";

/** @internal The suffix of a baked model beside its model file. */
export const BAKED_SUFFIX = ".mycomesh";
const MAGIC = "MYCOMESH";
const VERSION = 5; // 2: node poses, lights and cameras, layer textures, variants (ADR 0118); 3: mirrored left-handed, `facing` (ADR 0164); 4: skins, morphs, tangents, skeleton, takes and clips, the `animation` settings (ADR 0371); 5: LOD levels, occluder stand-ins, bounds, the `lod` and `occluder` settings (ADR 0459)

type BakeSettings = Pick<ImportSettings, "scale" | "upAxis" | "normals" | "facing"> & Partial<Pick<ImportSettings, "animation" | "lod" | "occluder">>;
type Range = [offset: number, count: number];
type BakedTexture = { path: string; mimeType?: string | null; uvSet?: number } | { image: number; mimeType?: string | null; uvSet?: number };

interface BakedJson {
  settings: BakeSettings;
  meshes: {
    name: string;
    path: string[];
    positions: Range;
    normals?: Range;
    uvs?: Range;
    uvs2?: Range;
    colors?: Range;
    indices: Range;
    groups: MeshData["groups"];
    surfaces: number[];
    pose?: NodePose;
    variantSurfaces?: Record<string, number[]>;
    hidden?: true;
    skin?: { influences: 4 | 8; joints: Range; weights: Range; inverseBinds?: Range };
    morphTargets?: { name: string; positions?: Range; normals?: Range; tangents?: Range }[];
    tangents?: Range;
    lods?: { indices: Range; groups: MeshData["groups"]; error: number; triangles: number }[];
    occluder?: { indices: Range; error: number; triangleErrors?: Range; neighbors?: Range };
    bounds?: Bounds6;
    pixelError?: number;
  }[];
  surfaces: Record<string, unknown>[];
  images: { offset: number; length: number; mimeType: string | null }[];
  nodes?: ModelNode[];
  variants?: string[];
  animation?: {
    skeleton: { bones: ImportedBone[]; inverseBinds: Range; roles: (string | null)[]; profile: string | null } | null;
    takes: { name: string; duration: number; tracks: unknown[] }[];
    clips: { name: string; take: string; source: unknown; settings: ImportedClip["settings"] }[];
    boneMap: Record<string, string>;
    boneMapSource: ModelAnimation["boneMapSource"];
  };
}

/** The animation settings a baked model was made with, as compared on load. */
const animationKey = (s: BakeSettings): string => JSON.stringify(modelAnimationToJson(s.animation) ?? null);

/** The LOD settings a baked model was made with, as compared on load (the occluder setting matters only with levels). */
const lodKey = (s: BakeSettings): string => JSON.stringify(s.lod ? [s.lod, s.occluder ?? "auto"] : null);

const TEXTURE_KEYS = ["map", "emissiveMap", "normalMap", "metalRoughMap", "occlusionMap"] as const;

/**
 * @internal A loaded model as a baked model file. Textures are kept by project path, or with
 * their bytes when the model file holds them; one that's neither (an image decoded from somewhere
 * else) is left out and listed in `dropped`.
 */
export function encodeBakedModel(data: ModelData, settings: BakeSettings): { bytes: Uint8Array; dropped: string[] } {
  const chunks: Uint8Array[] = [];
  let at = 0;
  const put = (bytes: Uint8Array): number => {
    const offset = at;
    chunks.push(bytes);
    at += bytes.byteLength;
    const pad = (4 - (at % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      at += pad;
    }
    return offset;
  };
  // An array stored once however often it's referenced (an occluder stand-in is its coarsest level's indices).
  const stored = new Map<ArrayBufferView, Range>();
  const array = (a: Float32Array | Uint32Array | Uint16Array | null | undefined): Range | undefined => {
    if (!a) return undefined;
    let r = stored.get(a);
    if (!r) stored.set(a, (r = [put(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)), a.length]));
    return r;
  };
  const dropped: string[] = [];
  const images: BakedJson["images"] = [];
  const imageIndex = new Map<Uint8Array | string, number>();
  const surfaceIndex = new Map<SurfaceInfo, number>();
  const surfaces: BakedJson["surfaces"] = [];
  const texture = (t: TextureInfo | null | undefined, where: string): BakedTexture | null => {
    if (!t) return null;
    const extra = { ...(t.mimeType ? { mimeType: t.mimeType } : {}), ...(t.uvSet ? { uvSet: t.uvSet } : {}) };
    if (t.path) return { path: t.path, ...extra };
    const bytes = t.bytes ?? (t.src ? dataUriBytes(t.src) : null);
    if (bytes) {
      const key = t.bytes ?? t.src!;
      let i = imageIndex.get(key);
      if (i === undefined) {
        imageIndex.set(key, (i = images.length));
        images.push({ offset: put(bytes), length: bytes.byteLength, mimeType: t.mimeType ?? null });
      }
      return { image: i, ...extra };
    }
    dropped.push(where);
    return null;
  };
  const surfaceOf = (s: SurfaceInfo): number => {
    let i = surfaceIndex.get(s);
    if (i !== undefined) return i;
    const out: Record<string, unknown> = { ...s };
    for (const key of TEXTURE_KEYS) if (key in s) out[key] = texture(s[key], `${s.name} ${key}`);
    if (s.layerMaps) {
      const maps: Record<string, BakedTexture | null> = {};
      for (const key of LAYER_MAP_KEYS) if (s.layerMaps[key]) maps[key] = texture(s.layerMaps[key], `${s.name} ${key} map`);
      out.layerMaps = maps;
    }
    surfaceIndex.set(s, (i = surfaces.length));
    surfaces.push(out);
    return i;
  };
  const meshes: BakedJson["meshes"] = data.meshes.map((m) => ({
    name: m.name,
    path: [...(m.path ?? [])],
    positions: array(m.data.positions)!,
    normals: array(m.data.normals),
    uvs: array(m.data.uvs),
    uvs2: array(m.data.uvs2),
    colors: array(m.data.colors),
    indices: array(m.data.indices)!,
    groups: m.data.groups.map((g) => ({ ...g })),
    surfaces: m.surfaces.map(surfaceOf),
    ...(m.pose ? { pose: m.pose } : {}),
    ...(m.variantSurfaces ? { variantSurfaces: Object.fromEntries(Object.entries(m.variantSurfaces).map(([k, list]) => [k, list.map(surfaceOf)])) } : {}),
    ...(m.hidden ? { hidden: true as const } : {}),
    ...(m.skin ? { skin: { influences: m.skin.influences, joints: array(Uint16Array.from(m.skin.joints))!, weights: array(Float32Array.from(m.skin.weights))!, ...(m.skin.inverseBinds ? { inverseBinds: array(m.skin.inverseBinds) } : {}) } } : {}),
    ...(m.morphTargets?.length ? { morphTargets: m.morphTargets.map((t) => ({ name: t.name, positions: array(t.positions), normals: array(t.normals), tangents: array(t.tangents) })) } : {}),
    ...(m.tangents ? { tangents: array(m.tangents) } : {}),
    ...(m.lods
      ? {
          lods: m.lods.levels.slice(1).map((l) => ({ indices: array(l.mesh.data.indices)!, groups: l.mesh.data.groups.map((g) => ({ ...g })), error: l.error, triangles: l.triangles })),
          ...(m.lods.occluder
            ? { occluder: { indices: array(m.lods.occluder.indices)!, error: m.lods.occluder.error, triangleErrors: array(m.lods.occluder.triangleErrors)!, neighbors: array(m.lods.occluder.neighbors)! } }
            : {}),
          bounds: m.lods.bounds,
          pixelError: m.lods.pixelError,
        }
      : {}),
  }));
  const a = data.animation;
  const json: BakedJson = {
    settings: { scale: settings.scale, upAxis: settings.upAxis, normals: settings.normals, facing: settings.facing, ...(settings.animation ? { animation: settings.animation } : {}), lod: settings.lod ?? null, occluder: settings.occluder ?? "auto" },
    meshes,
    surfaces,
    images,
    ...(data.nodes?.length ? { nodes: [...data.nodes] } : {}),
    ...(data.variants?.length ? { variants: [...data.variants] } : {}),
    ...(a
      ? {
          animation: {
            skeleton: a.skeleton ? { bones: [...a.skeleton.bones], inverseBinds: array(a.skeleton.inverseBinds)!, roles: [...a.skeleton.roles], profile: a.skeleton.profile } : null,
            takes: a.takes.map((t) => ({ name: t.name, duration: t.duration, tracks: t.tracks.map(trackToJson) })),
            clips: a.clips.map((c) => ({ name: c.name, take: c.take, source: animSourceToJson(c.source), settings: c.settings })),
            boneMap: { ...a.boneMap },
            boneMapSource: a.boneMapSource,
          },
        }
      : {}),
  };
  let text = new TextEncoder().encode(JSON.stringify(json));
  if (text.length % 4) {
    const padded = new Uint8Array(text.length + ((4 - (text.length % 4)) % 4)).fill(0x20);
    padded.set(text);
    text = padded;
  }
  const out = new Uint8Array(16 + text.length + at);
  out.set(new TextEncoder().encode(MAGIC), 0);
  const view = new DataView(out.buffer);
  view.setUint32(8, VERSION, true);
  view.setUint32(12, text.length, true);
  out.set(text, 16);
  let p = 16 + text.length;
  for (const c of chunks) {
    out.set(c, p);
    p += c.byteLength;
  }
  return { bytes: out, dropped };
}

/** A base64 `data:` URI's bytes, or null for any other URL. */
function dataUriBytes(uri: string): Uint8Array | null {
  const m = /^data:[^,]*;base64,(.*)$/s.exec(uri);
  if (!m) return null;
  const text = atob(m[1]);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** True if `bytes` start like a baked model. */
function isBakedModel(bytes: ArrayBuffer): boolean {
  return bytes.byteLength >= 16 && new TextDecoder().decode(new Uint8Array(bytes, 0, 8)) === MAGIC;
}

/**
 * @internal A baked model file's meshes, or null when it was baked with other import settings than
 * `settings` (the caller loads the model file instead). `url` gives a texture's URL by project path.
 * Throws for a file that isn't a baked model of this version.
 */
export function decodeBakedModel(bytes: ArrayBuffer, settings: BakeSettings, url: (path: string) => string): ModelData | null {
  if (!isBakedModel(bytes)) throw new Error("not a baked model");
  const view = new DataView(bytes);
  const version = view.getUint32(8, true);
  if (version !== VERSION) throw new Error(`baked model version ${version}; this engine reads ${VERSION}`);
  const length = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 16, length))) as BakedJson;
  if (json.settings.scale !== settings.scale || json.settings.upAxis !== settings.upAxis || json.settings.normals !== settings.normals || json.settings.facing !== settings.facing || animationKey(json.settings) !== animationKey(settings) || lodKey(json.settings) !== lodKey(settings)) return null;
  const base = 16 + length;
  const f32 = (r: Range | undefined) => (r ? new Float32Array(bytes, base + r[0], r[1]) : null);
  const u16 = (r: Range) => new Uint16Array(bytes, base + r[0], r[1]);
  const u32 = (r: Range) => new Uint32Array(bytes, base + r[0], r[1]);
  const images = json.images.map((i) => new Uint8Array(bytes, base + i.offset, i.length));
  const texture = (t: BakedTexture | null | undefined): TextureInfo | null => {
    if (!t) return null;
    const extra = { mimeType: t.mimeType ?? null, ...(t.uvSet ? { uvSet: t.uvSet } : {}) };
    if ("path" in t) {
      let src: string | null = null;
      try {
        src = url(t.path);
      } catch {
        // a texture the build lacks draws white
      }
      return { image: null, src, path: t.path, ...extra };
    }
    return { image: null, src: null, bytes: images[t.image], ...extra };
  };
  const surfaces = json.surfaces.map((raw): SurfaceInfo => {
    const s = { ...raw } as Record<string, unknown>;
    for (const key of TEXTURE_KEYS) if (key in s) s[key] = texture(s[key] as BakedTexture | null);
    if (s.layerMaps) {
      const maps: Record<string, TextureInfo> = {};
      for (const [key, t] of Object.entries(s.layerMaps as Record<string, BakedTexture | null>)) {
        const info = texture(t);
        if (info) maps[key] = info;
      }
      s.layerMaps = maps;
    }
    return s as unknown as SurfaceInfo;
  });
  const meshes = json.meshes.map((m): ModelMesh => {
    const data: MeshData = {
      positions: f32(m.positions)!,
      normals: f32(m.normals),
      uvs: f32(m.uvs),
      uvs2: f32(m.uvs2),
      colors: f32(m.colors),
      indices: u32(m.indices),
      groups: m.groups,
    };
    // No three.js geometry: everything reads `data`, so a baked game never loads three.js (ADR 0082, 0090).
    const mesh: ModelMesh = {
      name: m.name,
      path: m.path,
      materials: [],
      data,
      surfaces: m.surfaces.map((i) => surfaces[i]),
      ...(m.pose ? { pose: m.pose } : {}),
      ...(m.variantSurfaces ? { variantSurfaces: Object.fromEntries(Object.entries(m.variantSurfaces).map(([k, list]) => [k, list.map((i) => surfaces[i])])) } : {}),
      ...(m.hidden ? { hidden: true as const } : {}),
      ...(m.skin ? { skin: { influences: m.skin.influences, joints: u16(m.skin.joints), weights: f32(m.skin.weights)!, ...(m.skin.inverseBinds ? { inverseBinds: f32(m.skin.inverseBinds) } : {}) } satisfies MeshSkin } : {}),
      ...(m.morphTargets ? { morphTargets: m.morphTargets.map((t): MorphTargetData => ({ name: t.name, positions: f32(t.positions), normals: f32(t.normals), ...(t.tangents ? { tangents: f32(t.tangents) } : {}) })) } : {}),
      ...(m.tangents ? { tangents: f32(m.tangents) } : {}),
    };
    if (!m.lods || !m.bounds) return mesh;
    return attachLods(mesh, {
      levels: m.lods.map((l) => ({ indices: u32(l.indices), groups: l.groups, error: l.error, triangles: l.triangles })),
      // A stand-in baked before trimming has no per-triangle arrays, and an untrimmed stand-in isn't conservative.
      occluder: m.occluder?.triangleErrors && m.occluder.neighbors ? { indices: u32(m.occluder.indices), error: m.occluder.error, triangleErrors: f32(m.occluder.triangleErrors)!, neighbors: u32(m.occluder.neighbors) } : null,
      bounds: m.bounds,
      pixelError: m.pixelError ?? 1,
    });
  });
  let animation: ModelAnimation | undefined;
  if (json.animation) {
    const a = json.animation;
    const problems: string[] = [];
    const r = new LenientReader(problems);
    animation = {
      skeleton: a.skeleton ? { bones: a.skeleton.bones, inverseBinds: f32(a.skeleton.inverseBinds)!, roles: a.skeleton.roles, profile: a.skeleton.profile } : null,
      takes: a.takes.map((t) => ({ name: t.name, duration: t.duration, tracks: parseTracks(r, t.tracks, "tracks", { duration: t.duration, bones: true }) })),
      clips: a.clips.map((c) => ({ name: c.name, take: c.take, source: parseAnimSource(c.source).value, settings: c.settings })),
      boneMap: a.boneMap,
      boneMapSource: a.boneMapSource,
    };
  }
  return { meshes, ...(json.nodes ? { nodes: json.nodes } : {}), ...(json.variants ? { variants: json.variants } : {}), ...(animation ? { animation } : {}) };
}
