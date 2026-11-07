/**
 * Baked models (ADR 0090): a model's meshes as the engine uses them, already baked into model space
 * with its import settings, in one binary file the exporter writes beside the model in game builds
 * (`models/robot.fbx` → `models/robot.fbx.mycomesh`). Loading one needs no model loader and no
 * parsing: typed arrays are views of the file's bytes. Internal: nothing here is public API.
 *
 * Layout (little-endian): the magic `MYCOMESH`, a u32 version (1), a u32 JSON length, the JSON
 * (UTF-8, padded with spaces to 4 bytes), then the binary data every offset in the JSON points into
 * (each 4-byte aligned).
 *
 * ```jsonc
 * {
 *   "settings": { "scale": 1, "upAxis": "y", "normals": "import" },  // what it was baked with
 *   "meshes": [{ "name": "Body", "path": ["Robot"], "positions": [offset, count], "normals": …,
 *                "uvs": …, "uvs2": …, "colors": …, "indices": [offset, count], "groups": […], "surfaces": [0, 1] }],
 *   "surfaces": [{ …SurfaceInfo, textures as { "path": "textures/a.png" } or { "image": 0 } }],
 *   "images": [{ "offset": 0, "length": 1234, "mimeType": "image/png" }]
 * }
 * ```
 */
import { Box3, BufferAttribute, BufferGeometry, Sphere, Vector3 } from "three";
import type { ImportSettings } from "./importSettings";
import type { MeshData, ModelData, ModelMesh, SurfaceInfo, TextureInfo } from "./models";

/** @internal The suffix of a baked model beside its model file. */
export const BAKED_SUFFIX = ".mycomesh";
const MAGIC = "MYCOMESH";
const VERSION = 1;

type BakeSettings = Pick<ImportSettings, "scale" | "upAxis" | "normals">;
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
  }[];
  surfaces: Record<string, unknown>[];
  images: { offset: number; length: number; mimeType: string | null }[];
}

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
  const array = (a: Float32Array | Uint32Array | null | undefined): Range | undefined => (a ? [put(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)), a.length] : undefined);
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
  }));
  const json: BakedJson = { settings: { scale: settings.scale, upAxis: settings.upAxis, normals: settings.normals }, meshes, surfaces, images };
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

/** @internal True if `bytes` start like a baked model. */
export function isBakedModel(bytes: ArrayBuffer): boolean {
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
  if (json.settings.scale !== settings.scale || json.settings.upAxis !== settings.upAxis || json.settings.normals !== settings.normals) return null;
  const base = 16 + length;
  const f32 = (r: Range | undefined) => (r ? new Float32Array(bytes, base + r[0], r[1]) : null);
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
    return s as unknown as SurfaceInfo;
  });
  const meshes = json.meshes.map((m): ModelMesh => {
    const data: MeshData = {
      positions: f32(m.positions)!,
      normals: f32(m.normals),
      uvs: f32(m.uvs),
      uvs2: f32(m.uvs2),
      colors: f32(m.colors),
      indices: new Uint32Array(bytes, base + m.indices[0], m.indices[1]),
      groups: m.groups,
    };
    return { name: m.name, path: m.path, geometry: geometryOf(data), materials: [], data, surfaces: m.surfaces.map((i) => surfaces[i]) };
  });
  return { meshes };
}

/** A three.js geometry over a baked mesh's arrays (the editor's picking and bounds read it). */
function geometryOf(d: MeshData): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(d.positions, 3));
  if (d.normals) g.setAttribute("normal", new BufferAttribute(d.normals, 3));
  if (d.uvs) g.setAttribute("uv", new BufferAttribute(d.uvs, 2));
  if (d.uvs2) g.setAttribute("uv1", new BufferAttribute(d.uvs2, 2));
  if (d.colors) g.setAttribute("color", new BufferAttribute(d.colors, 4));
  g.setIndex(new BufferAttribute(d.indices, 1));
  for (const gr of d.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
  g.boundingBox = new Box3().setFromBufferAttribute(g.getAttribute("position") as BufferAttribute);
  g.boundingSphere = g.boundingBox.getBoundingSphere(new Sphere(new Vector3()));
  return g;
}
