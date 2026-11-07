/**
 * Model assets (ADR 0044, 0088): `.obj` (with its `.mtl`, when there is one), `.fbx`, `.gltf` and
 * `.glb` files, loaded with three.js's loaders behind the asset layer (glTF in `gltf.ts`). Internal: game code refers to meshes by path in
 * a MeshRenderer or MeshCollider and never sees anything here.
 *
 * A model loads into its meshes in model space: each mesh's place in the file and the model's
 * import settings (scale, up axis, normals; ADR 0040 sidecars) are baked into its geometry, so a
 * mesh drawn at a node's origin sits where it sits in the file. References:
 *
 * - `asset:models/robot.fbx` — every mesh of the model;
 * - `asset:models/robot.fbx#Body` — the mesh named `Body` (names are made unique: `Body_2`…);
 * - `builtin:cube` (and `sphere`, `capsule`, `cylinder`, `plane`, `quad`) — the engine's own meshes.
 *
 * Models load once per path and are shared by every World, and by rendering and physics alike; a
 * changed file or sidecar loads again. Works headless (Node), where textures are left blank.
 */
// Types only: three.js loads with the first model file parsed (`parseModel`), so it stays out of the
// start-up bundle of the editor and of games (ADR 0082); the built-in meshes need none of it.
import type { BufferAttribute, BufferGeometry, Color as ThreeColor, LoadingManager, Material, Matrix4, Mesh, Object3D, Side, Texture } from "three";
import { Assets, normalizeAssetPath, sidecarValue } from "./Assets";
import { BAKED_SUFFIX, decodeBakedModel, encodeBakedModel } from "./bakedModel";
import { BUILTIN_MESHES, builtinMeshData, type BuiltinMesh } from "./builtinMeshes";
import { Mat4 } from "../core/math";
import { splitSpriteRef, type ImportSettings } from "./importSettings";

let three: typeof import("three") | null = null;
/** three.js, once `parseModel` has loaded it. */
function lib(): typeof import("three") {
  if (!three) throw new Error("three.js isn't loaded: models are baked through parseModel.");
  return three;
}
/** three.js's `DoubleSide`, without loading three.js. */
const DOUBLE_SIDE = 2;

/** @internal True for a model file the engine imports. */
export const isModelPath = (path: string): boolean => MODEL_EXTENSIONS.test(splitSpriteRef(path).path);
/** @internal The model file extensions. */
export const MODEL_EXTENSIONS = /\.(obj|fbx|gltf|glb)$/i;

/** @internal */
export const BUILTIN_PREFIX = "builtin:";
/** @internal The engine's own meshes (by the name after `builtin:`), generated without three.js (ADR 0082). */
export { BUILTIN_MESHES, type BuiltinMesh } from "./builtinMeshes";

/** @internal A mesh's vertices without renderer types (ADR 0075): what the Babylon backend and physics read. */
export interface MeshData {
  /** x, y, z per vertex, in model space. */
  readonly positions: Float32Array;
  readonly normals: Float32Array | null;
  /** u, v per vertex (v up, as three.js and glTF). */
  readonly uvs: Float32Array | null;
  /** A second UV set (glTF `TEXCOORD_1`, often for occlusion maps), v up; null for none. */
  readonly uvs2?: Float32Array | null;
  /** r, g, b, a per vertex (linear), when the mesh's material uses vertex colours; null for none. */
  readonly colors?: Float32Array | null;
  /** Three per triangle, counter-clockwise front faces. */
  readonly indices: Uint32Array;
  /** Index ranges drawn with each surface (`surfaces[materialIndex]`); empty: one surface for all. */
  readonly groups: readonly { start: number; count: number; materialIndex: number }[];
}

/** @internal A texture of a model's material: an image the loader decoded, or a URL the renderer decodes (glTF, ADR 0088). */
export interface TextureInfo {
  /** The decoded image (OBJ, FBX), or null. */
  readonly image: unknown;
  /** A URL to load the image from, or null. */
  readonly src: string | null;
  /** The encoded image's bytes (an image stored inside the model file), or absent. */
  readonly bytes?: Uint8Array;
  /** The image's project path, when it's a project file (what a baked model refers to, ADR 0090). */
  readonly path?: string;
  /** The image's MIME type when known (`image/ktx2` needs a transcoder). */
  readonly mimeType?: string | null;
  /** Which UV set it reads: 0 (`uvs`) or 1 (`uvs2`). */
  readonly uvSet?: number;
}

/** @internal How a surface's alpha is used (glTF's alpha modes). */
export type SurfaceAlphaMode = "opaque" | "mask" | "blend";

/** @internal A model's own material without renderer types (ADR 0075). */
export interface SurfaceInfo {
  readonly name: string;
  /** Linear RGB. */
  readonly color: readonly [number, number, number];
  readonly opacity: number;
  readonly transparent: boolean;
  readonly metalness: number;
  readonly roughness: number;
  readonly doubleSided: boolean;
  /** The base colour texture's image, as the loader decoded it, or null. */
  readonly map: TextureInfo | null;
  // Below: read from glTF's PBR materials and extensions (ADR 0088); absent means the default.
  /** Emitted light, linear RGB (already times `KHR_materials_emissive_strength`). */
  readonly emissive?: readonly [number, number, number];
  readonly emissiveMap?: TextureInfo | null;
  /** Tangent-space normal map and its strength. */
  readonly normalMap?: TextureInfo | null;
  readonly normalScale?: number;
  /** glTF metallic-roughness texture: roughness in green, metalness in blue (times the factors). */
  readonly metalRoughMap?: TextureInfo | null;
  /** Ambient occlusion in red, and its strength. */
  readonly occlusionMap?: TextureInfo | null;
  readonly occlusionStrength?: number;
  /** Opaque, cut out below `alphaCutoff`, or blended. Absent: blended when `transparent`. */
  readonly alphaMode?: SurfaceAlphaMode;
  readonly alphaCutoff?: number;
  /** Not lit (`KHR_materials_unlit`). */
  readonly unlit?: boolean;
  /** The mesh's vertex colours multiply the colour. */
  readonly vertexColors?: boolean;
  /** Physical layers (KHR_materials_clearcoat, sheen, transmission, volume, ior, specular, iridescence, anisotropy); their textures are `layerMaps`. */
  readonly physical?: {
    readonly clearcoat: number;
    readonly clearcoatRoughness: number;
    readonly sheen: number;
    readonly sheenColor: readonly [number, number, number];
    readonly sheenRoughness: number;
    readonly transmission: number;
    readonly thickness: number;
    readonly ior: number;
    readonly specularIntensity: number;
    readonly specularColor: readonly [number, number, number];
    readonly iridescence: number;
    readonly iridescenceIOR: number;
    /** Iridescence film thickness range in nanometres, [min, max] (ADR 0118). */
    readonly iridescenceThickness?: readonly [number, number];
    /** Volume attenuation (KHR_materials_volume): the colour light turns after `attenuationDistance` metres. */
    readonly attenuationColor?: readonly [number, number, number];
    readonly attenuationDistance?: number;
    /** KHR_materials_anisotropy: strength 0 … 1 and rotation in radians (ADR 0118). */
    readonly anisotropy?: number;
    readonly anisotropyRotation?: number;
  };
  /** The physical layers' textures (ADR 0118), with glTF's channels: each absent when the file has none. */
  readonly layerMaps?: Partial<Record<LayerMapKey, TextureInfo>>;
  /** Clearcoat normal map strength. */
  readonly clearcoatNormalScale?: number;
}

/** @internal The physical layers' texture slots (ADR 0118), each read with glTF's channel convention. */
export const LAYER_MAP_KEYS = [
  "clearcoat", // R: clearcoat
  "clearcoatRoughness", // G: clearcoat roughness
  "clearcoatNormal",
  "sheenColor", // RGB, sRGB
  "sheenRoughness", // A
  "transmission", // R
  "thickness", // G
  "specularIntensity", // A
  "specularColor", // RGB, sRGB
  "iridescence", // R
  "iridescenceThickness", // G
  "anisotropy", // RG direction, B strength
] as const;
export type LayerMapKey = (typeof LAYER_MAP_KEYS)[number];

/** three.js's MeshPhysicalMaterial property for each layer texture slot. */
const LAYER_MAP_THREE: Record<LayerMapKey, string> = {
  clearcoat: "clearcoatMap",
  clearcoatRoughness: "clearcoatRoughnessMap",
  clearcoatNormal: "clearcoatNormalMap",
  sheenColor: "sheenColorMap",
  sheenRoughness: "sheenRoughnessMap",
  transmission: "transmissionMap",
  thickness: "thicknessMap",
  specularIntensity: "specularIntensityMap",
  specularColor: "specularColorMap",
  iridescence: "iridescenceMap",
  iridescenceThickness: "iridescenceThicknessMap",
  anisotropy: "anisotropyMap",
};

/** @internal A node's pose in model space (ADR 0118): position, quaternion [x, y, z, w], scale; the import settings applied. */
export interface NodePose {
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
}

/** @internal A glTF light (KHR_lights_punctual) in the engine Light's terms (ADR 0118). */
export interface ModelLight {
  readonly type: "directional" | "point" | "spot";
  /** sRGB, as the Light component's colour. */
  readonly color: readonly [number, number, number];
  /** Candela (point, spot) or lux (directional), as the Light component takes them. */
  readonly intensity: number;
  /** Metres; 0 for no limit. */
  readonly range: number;
  /** Spot: full cone angle in degrees, and edge softness 0 … 1. */
  readonly spotAngle: number;
  readonly spotSoftness: number;
}

/** @internal A glTF camera in the engine Camera's terms (ADR 0118). */
export interface ModelCamera {
  readonly projection: "perspective" | "orthographic";
  /** Vertical field of view, degrees (perspective). */
  readonly fieldOfView: number;
  /** Half the vertical view size (orthographic). */
  readonly orthographicSize: number;
  readonly near: number;
  readonly far: number;
}

/** @internal A node of the model's file that isn't a mesh: a group on a mesh's path, a light or a camera (ADR 0118). */
export interface ModelNode {
  readonly name: string;
  /** The names of the nodes above it, outermost first, as `ModelMesh.path`. */
  readonly path: readonly string[];
  readonly pose: NodePose;
  readonly light?: ModelLight;
  readonly camera?: ModelCamera;
}

/** @internal One mesh of a model, in model space. */
export interface ModelMesh {
  /** Unique within its model; what `#name` refers to. */
  readonly name: string;
  /** three.js's geometry, for models loaded from files; the built-in meshes have only `data`. */
  readonly geometry?: BufferGeometry;
  /** The model's own materials for this mesh, as the engine's default lit material (one per geometry group). */
  readonly materials: readonly Material[];
  /** The same vertices as plain arrays (renderer-neutral). */
  readonly data: MeshData;
  /** The same materials as plain descriptions (renderer-neutral), one per entry of `materials`. */
  readonly surfaces: readonly SurfaceInfo[];
  /**
   * The names of the nodes above the mesh in the file, outermost first (unnamed ones left out);
   * the editor makes a node tree from them (ADR 0088). Empty for a mesh at the top.
   */
  readonly path?: readonly string[];
  /** Its node's model-space pose (ADR 0118); absent: the identity (built-in meshes). */
  readonly pose?: NodePose;
  /**
   * Material variants (KHR_materials_variants, ADR 0118): for each variant that changes this mesh,
   * its full surface list (index for index with `surfaces`; unmapped slots keep the default).
   */
  readonly variantSurfaces?: Readonly<Record<string, readonly SurfaceInfo[]>>;
}

/** A float attribute as a tightly packed array (copied only when interleaved or not float). */
function packed(attr: BufferAttribute | undefined): Float32Array | null {
  if (!attr) return null;
  const a = attr as BufferAttribute & { isInterleavedBufferAttribute?: boolean };
  if (!a.isInterleavedBufferAttribute && attr.array instanceof Float32Array && attr.array.length === attr.count * attr.itemSize) return attr.array;
  const out = new Float32Array(attr.count * attr.itemSize);
  for (let i = 0; i < attr.count; i++) for (let k = 0; k < attr.itemSize; k++) out[i * attr.itemSize + k] = attr.getComponent(i, k);
  return out;
}

type AnyTexture = Texture & { image?: { src?: string; currentSrc?: string } | null; channel?: number; userData: { mycoSource?: { src: string | null; bytes?: Uint8Array; path?: string; mimeType: string | null } | null } };

/** Project paths of the texture URLs models have used (ADR 0090: baked models refer to textures by path). */
const texturePaths = new Map<string, string>();

/** A three.js texture as a renderer-neutral texture, or null. */
function textureInfo(t: AnyTexture | null | undefined): TextureInfo | null {
  if (!t) return null;
  const uvSet = t.channel ?? 0;
  const source = t.userData?.mycoSource;
  if (source !== undefined) {
    if (!source || (!source.src && !source.bytes)) return null;
    return { image: null, src: source.src, mimeType: source.mimeType, uvSet, ...(source.bytes ? { bytes: source.bytes } : {}), ...(source.path ? { path: source.path } : {}) };
  }
  const image = t.image ?? null;
  const src = image ? image.currentSrc || image.src || null : null;
  const path = src ? texturePaths.get(src) : undefined;
  return image ? { image, src, uvSet, ...(path ? { path } : {}) } : null;
}

const rgb = (c: ThreeColor, k = 1): [number, number, number] => [c.r * k, c.g * k, c.b * k];

/** One material as a renderer-neutral surface. */
function surfaceOf(source: Material): SurfaceInfo {
  const m = source as Material & {
    color?: ThreeColor;
    metalness?: number;
    roughness?: number;
    map?: AnyTexture | null;
    emissive?: ThreeColor;
    emissiveIntensity?: number;
    emissiveMap?: AnyTexture | null;
    normalMap?: AnyTexture | null;
    normalScale?: { x: number };
    roughnessMap?: AnyTexture | null;
    metalnessMap?: AnyTexture | null;
    aoMap?: AnyTexture | null;
    aoMapIntensity?: number;
    vertexColors?: boolean;
    isMeshPhysicalMaterial?: boolean;
  };
  const surface: { -readonly [K in keyof SurfaceInfo]: SurfaceInfo[K] } = {
    name: source.name,
    color: m.color ? [m.color.r, m.color.g, m.color.b] : [1, 1, 1],
    opacity: source.opacity,
    transparent: source.transparent,
    metalness: m.metalness ?? 0,
    roughness: m.roughness ?? 0.6,
    doubleSided: source.side === DOUBLE_SIDE,
    map: textureInfo(m.map),
  };
  if (m.emissive && (m.emissive.r || m.emissive.g || m.emissive.b)) surface.emissive = rgb(m.emissive, m.emissiveIntensity ?? 1);
  const emissiveMap = textureInfo(m.emissiveMap);
  if (emissiveMap) {
    surface.emissiveMap = emissiveMap;
    surface.emissive ??= m.emissive ? rgb(m.emissive, m.emissiveIntensity ?? 1) : [1, 1, 1];
  }
  const normalMap = textureInfo(m.normalMap);
  if (normalMap) {
    surface.normalMap = normalMap;
    surface.normalScale = m.normalScale?.x ?? 1;
  }
  const metalRough = textureInfo(m.roughnessMap ?? m.metalnessMap);
  if (metalRough) surface.metalRoughMap = metalRough;
  const occlusion = textureInfo(m.aoMap);
  if (occlusion) {
    surface.occlusionMap = occlusion;
    surface.occlusionStrength = m.aoMapIntensity ?? 1;
  }
  if (source.alphaTest > 0) {
    surface.alphaMode = "mask";
    surface.alphaCutoff = source.alphaTest;
  } else if (source.userData?.mycoGltf) surface.alphaMode = source.transparent ? "blend" : "opaque";
  if (source.userData?.mycoUnlit) surface.unlit = true;
  if (m.vertexColors) surface.vertexColors = true;
  if (m.isMeshPhysicalMaterial) {
    const p = source as Material & Record<string, number> & { sheenColor: ThreeColor; specularColor: ThreeColor };
    surface.physical = {
      clearcoat: p.clearcoat ?? 0,
      clearcoatRoughness: p.clearcoatRoughness ?? 0,
      sheen: p.sheen ?? 0,
      sheenColor: p.sheenColor ? rgb(p.sheenColor) : [1, 1, 1],
      sheenRoughness: p.sheenRoughness ?? 1,
      transmission: p.transmission ?? 0,
      thickness: p.thickness ?? 0,
      ior: p.ior ?? 1.5,
      specularIntensity: p.specularIntensity ?? 1,
      specularColor: p.specularColor ? rgb(p.specularColor) : [1, 1, 1],
      iridescence: p.iridescence ?? 0,
      iridescenceIOR: p.iridescenceIOR ?? 1.3,
      ...physicalExtras(source),
    };
    const maps: Partial<Record<LayerMapKey, TextureInfo>> = {};
    for (const key of LAYER_MAP_KEYS) {
      const t = textureInfo((source as unknown as Record<string, AnyTexture | null | undefined>)[LAYER_MAP_THREE[key]]);
      if (t) maps[key] = t;
    }
    if (Object.keys(maps).length) surface.layerMaps = maps;
    if (maps.clearcoatNormal) surface.clearcoatNormalScale = (source as unknown as { clearcoatNormalScale?: { x: number } }).clearcoatNormalScale?.x ?? 1;
  }
  return surface;
}

/** The physical layers' values beyond 0088's factors (ADR 0118), only where they differ from glTF's defaults. */
function physicalExtras(source: Material): Partial<NonNullable<SurfaceInfo["physical"]>> {
  const p = source as Material & { iridescenceThicknessMinimum?: number; iridescenceThicknessMaximum?: number; attenuationColor?: ThreeColor; attenuationDistance?: number; anisotropy?: number; anisotropyRotation?: number; anisotropyMap?: unknown };
  const out: { -readonly [K in keyof NonNullable<SurfaceInfo["physical"]>]?: NonNullable<SurfaceInfo["physical"]>[K] } = {};
  const thin = p.iridescenceThicknessMinimum ?? 100, thick = p.iridescenceThicknessMaximum ?? 400;
  if (thin !== 100 || thick !== 400) out.iridescenceThickness = [thin, thick];
  if (p.attenuationDistance !== undefined && Number.isFinite(p.attenuationDistance)) {
    out.attenuationDistance = p.attenuationDistance;
    out.attenuationColor = p.attenuationColor ? rgb(p.attenuationColor) : [1, 1, 1];
  }
  if (p.anisotropy || p.anisotropyMap) {
    out.anisotropy = p.anisotropy ?? 0;
    out.anisotropyRotation = p.anisotropyRotation ?? 0;
  }
  return out;
}

/** One surface per source material, so meshes sharing a material share its slot (ADR 0089) and its renderer material. */
const surfaces = new WeakMap<Material, SurfaceInfo>();
function sharedSurface(material: Material): SurfaceInfo {
  let s = surfaces.get(material);
  if (!s) surfaces.set(material, (s = surfaceOf(material)));
  return s;
}

/**
 * @internal The material slot of meshes that have no material of their own (built-in meshes,
 * models without materials): one slot drawn with the renderer's material or the default.
 */
export const DEFAULT_SLOT: SurfaceInfo = Object.freeze<SurfaceInfo>({ name: "Default", color: [1, 1, 1], opacity: 1, transparent: false, metalness: 0, roughness: 0.5, doubleSided: false, map: null });

/** @internal A material slot of what a MeshRenderer draws (ADR 0089). */
export interface MaterialSlot {
  /** The model's material's name (what the sidecar's `materials` keys), or `Slot N` for an unnamed one. */
  readonly name: string;
  /** The model's own material, or `DEFAULT_SLOT`. */
  readonly surface: SurfaceInfo;
}

/**
 * @internal The material slots of a set of meshes (what one MeshRenderer draws): each distinct
 * material of theirs, in order of first use, so `MeshRenderer.materials[i]` replaces slot i. A
 * mesh without materials adds the one default slot.
 */
export function materialSlots(meshes: readonly ModelMesh[]): MaterialSlot[] {
  const seen = new Set<SurfaceInfo>();
  const out: MaterialSlot[] = [];
  const add = (surface: SurfaceInfo) => {
    if (seen.has(surface)) return;
    seen.add(surface);
    out.push({ name: surface.name || `Slot ${out.length}`, surface });
  };
  for (const m of meshes) {
    if (!m.surfaces.length) add(DEFAULT_SLOT);
    else for (const s of m.surfaces) add(s);
  }
  return out;
}

/** Vertex colours as r, g, b, a floats (three gives 3 or 4 components, maybe normalized integers). */
function packedColors(attr: BufferAttribute | undefined): Float32Array | null {
  if (!attr) return null;
  const out = new Float32Array(attr.count * 4);
  for (let i = 0; i < attr.count; i++) {
    out[i * 4] = attr.getX(i);
    out[i * 4 + 1] = attr.getY(i);
    out[i * 4 + 2] = attr.getZ(i);
    out[i * 4 + 3] = attr.itemSize > 3 ? attr.getW(i) : 1;
  }
  return out;
}

/** @internal The renderer-neutral views of a geometry and its materials. */
export function neutralMesh(geometry: BufferGeometry, materials: readonly Material[]): { data: MeshData; surfaces: SurfaceInfo[] } {
  const positions = packed(geometry.getAttribute("position") as BufferAttribute) ?? new Float32Array(0);
  const count = positions.length / 3;
  const index = geometry.getIndex();
  const indices = index ? Uint32Array.from(index.array as ArrayLike<number>) : Uint32Array.from({ length: count - (count % 3) }, (_, i) => i);
  const surfaces = materials.map(sharedSurface);
  const data: MeshData = {
    positions,
    normals: packed(geometry.getAttribute("normal") as BufferAttribute | undefined),
    uvs: packed(geometry.getAttribute("uv") as BufferAttribute | undefined),
    uvs2: packed(geometry.getAttribute("uv1") as BufferAttribute | undefined),
    colors: surfaces.some((s) => s.vertexColors) ? packedColors(geometry.getAttribute("color") as BufferAttribute | undefined) : null,
    indices,
    groups: geometry.groups.map((g) => ({ start: g.start, count: g.count, materialIndex: g.materialIndex ?? 0 })),
  };
  return { data, surfaces };
}

/** @internal A loaded model. */
export interface ModelData {
  readonly meshes: readonly ModelMesh[];
  /** The group nodes on the meshes' paths, and the file's lights and cameras (ADR 0118). */
  readonly nodes?: readonly ModelNode[];
  /** The file's material variant names (KHR_materials_variants, ADR 0118), in file order. */
  readonly variants?: readonly string[];
}

interface CacheEntry {
  url: string;
  sidecar: object | undefined;
  promise: Promise<ModelData>;
  data: ModelData | null;
  error: unknown;
}

const cache = new Map<string, CacheEntry>();
const warned = new Set<string>();
const builtins = new Map<BuiltinMesh, ModelData>();

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[myco] ${message}`);
}

/** A 1×1 white PNG: what a texture the model names but the project lacks draws as. */
const WHITE_PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

/**
 * @internal The model behind a mesh reference (its path without `#mesh`), loading it if needed.
 * Rejects if the file can't be read or parsed.
 */
export function loadModel(ref: string): Promise<ModelData> {
  const path = splitSpriteRef(normalizeAssetPath(ref)).path;
  const url = Assets.url(path);
  const sidecar = sidecarValue(path);
  const cached = cache.get(path);
  if (cached && cached.url === url && cached.sidecar === sidecar) return cached.promise;
  const entry: CacheEntry = { url, sidecar, data: null, error: null, promise: null! };
  entry.promise = parseModel(path, url, Assets.importSettings(path)).then(
    (data) => {
      entry.data = data;
      return data;
    },
    (err) => {
      entry.error = err;
      throw err;
    },
  );
  entry.promise.catch(() => {}); // reported by whoever awaits it, or by `meshesIfLoaded`
  cache.set(path, entry);
  // The old meshes go once the new ones have loaded: by then every renderer has let go of them,
  // since `meshesIfLoaded` reports the model as loading from now on (physics copies triangles).
  const old = cached?.data;
  if (old) entry.promise.finally(() => disposeModel(old)).catch(() => {});
  return entry.promise;
}

/**
 * @internal The meshes a reference names if they're ready: every mesh of a model, one (`#name`)
 * or a built-in mesh. Null while the model loads (the load starts here); empty if it failed or
 * has no such mesh (warned once).
 */
export function meshesIfLoaded(ref: string): readonly ModelMesh[] | null {
  if (!ref) return [];
  if (ref.startsWith(BUILTIN_PREFIX)) return builtinMeshes(ref);
  const { path, slice } = splitSpriteRef(normalizeAssetPath(ref));
  let promise: Promise<ModelData>;
  try {
    if (!Assets.has(path)) {
      warnOnce(`Mesh "${ref}": no such asset.`);
      return [];
    }
    promise = loadModel(path);
  } catch (err) {
    warnOnce(`Mesh "${ref}": ${(err as Error).message}`);
    return [];
  }
  const entry = cache.get(path);
  if (!entry || entry.promise !== promise) return null;
  if (entry.error) {
    warnOnce(`Couldn't load the model ${path}: ${(entry.error as Error)?.message ?? entry.error}`);
    return [];
  }
  if (!entry.data) return null;
  return selectMeshes(entry.data, path, slice);
}

/** @internal Like `meshesIfLoaded`, but waits for the model. */
export async function loadMeshes(ref: string): Promise<readonly ModelMesh[]> {
  if (!ref) return [];
  if (ref.startsWith(BUILTIN_PREFIX)) return builtinMeshes(ref);
  const { path, slice } = splitSpriteRef(normalizeAssetPath(ref));
  return selectMeshes(await loadModel(path), path, slice);
}

function selectMeshes(data: ModelData, path: string, ref: string | null): readonly ModelMesh[] {
  if (ref === null) return data.meshes;
  const modelSpace = ref.endsWith(MODEL_SPACE_SUFFIX);
  const slice = modelSpace ? ref.slice(0, -MODEL_SPACE_SUFFIX.length) : ref;
  const mesh = data.meshes.find((m) => m.name === slice);
  if (!mesh) {
    warnOnce(`${path} has no mesh named "${slice}".`);
    return [];
  }
  // ADR 0118: with node pivots, one mesh on its own is in its node's space (a whole model stays in model
  // space); `#Part#model` (what scene format 1 files migrate to) pins it to model space.
  return [!modelSpace && Assets.importSettings(path).pivots === "node" ? nodeSpaceMesh(mesh) : mesh];
}

/** @internal The suffix pinning one mesh of a model to model space (`asset:car.glb#Wheel#model`, ADR 0118). */
export const MODEL_SPACE_SUFFIX = "#model";

const nodeSpace = new WeakMap<ModelMesh, ModelMesh>();

/**
 * @internal A model-space mesh in its node's space (ADR 0118): its vertices through the inverse of its
 * pose, made once per mesh. The mesh itself when its pose is the identity.
 */
export function nodeSpaceMesh(mesh: ModelMesh): ModelMesh {
  const pose = mesh.pose;
  if (!pose || isIdentityPose(pose)) return mesh;
  let out = nodeSpace.get(mesh);
  if (out) return out;
  const m = new Float64Array(16);
  Mat4.compose(m, 0, [...pose.position], 0, [...pose.rotation], 0, [...pose.scale], 0);
  const inv = new Float64Array(16);
  Mat4.invert(inv, 0, m, 0);
  const d = mesh.data;
  const positions = new Float32Array(d.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const [x, y, z] = Mat4.transformPoint(inv, 0, d.positions[i], d.positions[i + 1], d.positions[i + 2]);
    positions[i] = x;
    positions[i + 1] = y;
    positions[i + 2] = z;
  }
  let normals: Float32Array | null = null;
  if (d.normals) {
    // Normals go through the inverse transpose of the inverse's linear part: scale · rotation⁻¹.
    const [qx, qy, qz, qw] = pose.rotation;
    const conj = new Float64Array(16);
    Mat4.compose(conj, 0, [0, 0, 0], 0, [-qx, -qy, -qz, qw], 0, [1, 1, 1], 0);
    const [sx, sy, sz] = pose.scale;
    normals = new Float32Array(d.normals.length);
    for (let i = 0; i < normals.length; i += 3) {
      let [x, y, z] = Mat4.transformPoint(conj, 0, d.normals[i], d.normals[i + 1], d.normals[i + 2]);
      x *= sx;
      y *= sy;
      z *= sz;
      const len = Math.hypot(x, y, z) || 1;
      normals[i] = x / len;
      normals[i + 1] = y / len;
      normals[i + 2] = z / len;
    }
  }
  let indices = d.indices;
  if (pose.scale[0] * pose.scale[1] * pose.scale[2] < 0) {
    indices = Uint32Array.from(d.indices);
    for (let i = 0; i + 2 < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
  }
  out = { ...mesh, geometry: undefined, data: { ...d, positions, normals, indices }, pose: undefined };
  nodeSpace.set(mesh, out);
  return out;
}

function isIdentityPose(p: NodePose): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  return p.position.every((v) => near(v, 0)) && near(p.rotation[0], 0) && near(p.rotation[1], 0) && near(p.rotation[2], 0) && near(Math.abs(p.rotation[3]), 1) && p.scale.every((v) => near(v, 1));
}

/** @internal The material variant names of the model behind a mesh reference (ADR 0118); empty while it loads or when it has none. */
export function modelVariantsIfLoaded(ref: string): readonly string[] {
  if (!ref || ref.startsWith(BUILTIN_PREFIX)) return [];
  const path = splitSpriteRef(normalizeAssetPath(ref)).path;
  return cache.get(path)?.data?.variants ?? [];
}

/**
 * @internal The variant a renderer draws (ADR 0118): `variant` when the model has it, else undefined
 * (the defaults), warning once for a name the loaded model lacks.
 */
export function drawnVariant(ref: string, variant: string): string | undefined {
  if (!variant) return undefined;
  const path = splitSpriteRef(normalizeAssetPath(ref)).path;
  const data = cache.get(path)?.data;
  if (!data) return undefined;
  if (data.variants?.includes(variant)) return variant;
  warnOnce(`${path} has no material variant "${variant}"; drawing its default materials.`);
  return undefined;
}

/** @internal The names of a model's meshes (what `#name` can refer to), once loaded. */
export async function modelMeshNames(path: string): Promise<string[]> {
  return (await loadModel(path)).meshes.map((m) => m.name);
}

function builtinMeshes(ref: string): readonly ModelMesh[] {
  const name = ref.slice(BUILTIN_PREFIX.length) as BuiltinMesh;
  if (!BUILTIN_MESHES.includes(name)) {
    warnOnce(`Unknown built-in mesh "${ref}"; use one of ${BUILTIN_MESHES.map((m) => BUILTIN_PREFIX + m).join(", ")}.`);
    return [];
  }
  let data = builtins.get(name);
  if (!data) {
    data = { meshes: [{ name, materials: [], data: builtinMeshData(name), surfaces: [] }] };
    builtins.set(name, data);
  }
  return data.meshes;
}

// --- loading -------------------------------------------------------------------------------------

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  if (url.startsWith("file:") && typeof window === "undefined") {
    // The dedicated server (Node) gives project files file: URLs, which its fetch can't read.
    const fs = (await import(/* @vite-ignore */ ["node", "fs/promises"].join(":"))) as { readFile(path: URL): Promise<Uint8Array> };
    const bytes = await fs.readFile(new URL(url));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.arrayBuffer();
}

/** Textures a model names, found among the project's assets: beside the model, by name, or in a `textures/` folder there. */
function textureUrl(modelPath: string, url: string): string {
  if (/^(data|blob):/.test(url) || (/^[a-z]+:\/\//i.test(url) && Assets.has(url))) return url;
  const name = url.replace(/\\/g, "/").replace(/^\.\//, "");
  const folder = modelPath.includes("/") ? modelPath.slice(0, modelPath.lastIndexOf("/") + 1) : "";
  const base = name.slice(name.lastIndexOf("/") + 1);
  for (const candidate of [resolveRelative(folder, name), folder + base, `${folder}textures/${base}`, base]) {
    if (candidate && Assets.has(candidate)) {
      const resolved = Assets.url(candidate);
      texturePaths.set(resolved, candidate);
      return resolved;
    }
  }
  warnOnce(`${modelPath} uses the texture "${url}", which isn't in the project; it draws white.`);
  return WHITE_PIXEL;
}

/** `folder/` + a relative path, with `..` resolved; null if it climbs out of the project. */
function resolveRelative(folder: string, rel: string): string | null {
  if (/^([a-z]:|\/)/i.test(rel)) return null; // absolute: from another machine
  const parts = (folder + rel).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") {
      if (!out.length) return null;
      out.pop();
    } else if (p !== "." && p !== "") out.push(p);
  }
  return out.join("/");
}

/** A loading manager that also says when the textures it started have loaded (or failed). */
type ModelLoadingManager = LoadingManager & { settled(): Promise<void> };

/** A loading manager that finds a model's textures in the project, and (headless) leaves them blank. */
function manager(modelPath: string): ModelLoadingManager {
  const { LoadingManager, Texture } = lib();
  const m = new LoadingManager() as ModelLoadingManager;
  m.setURLModifier((url) => textureUrl(modelPath, url));
  if (typeof document === "undefined") {
    // Headless: no image is decoded, but the texture keeps its URL and project path (a baked model refers to it, ADR 0090).
    const load = (url: string) => {
      const t = new (lib().Texture)();
      const src = textureUrl(modelPath, url);
      const path = texturePaths.get(src);
      t.userData.mycoSource = !path && src === WHITE_PIXEL ? null : { src, mimeType: null, path };
      return t;
    };
    const blank = { path: "", setPath() { return blank; }, setCrossOrigin() { return blank; }, load };
    m.addHandler(/\.(png|jpe?g|gif|webp|bmp|tga|tiff?|dds)$/i, blank as never);
  }
  // The loaders hand textures back at once and fill their images in later. The renderer-neutral
  // surfaces (`neutralMesh`) are a snapshot of them, so a model waits for its textures before it's
  // baked; otherwise every texture is missing from the snapshot and the Babylon backend draws white.
  let pending = 0;
  let waiters: (() => void)[] = [];
  const start = m.itemStart, end = m.itemEnd;
  m.itemStart = (url) => {
    pending++;
    start(url);
  };
  m.itemEnd = (url) => {
    end(url);
    if (--pending > 0) return;
    const done = waiters;
    waiters = [];
    for (const w of done) w();
  };
  m.settled = () => (pending > 0 ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve());
  return m;
}

async function parseModel(path: string, url: string, settings: ImportSettings, useBaked = true): Promise<ModelData> {
  // A game build's baked copy (ADR 0090), when it was baked with these import settings.
  if (useBaked && Assets.has(path + BAKED_SUFFIX)) {
    try {
      const baked = decodeBakedModel(await fetchBytes(Assets.url(path + BAKED_SUFFIX)), settings, (p) => Assets.url(p));
      if (baked) return baked;
      warnOnce(`${path}${BAKED_SUFFIX} was baked with other import settings; loading ${path} instead.`);
    } catch (err) {
      warnOnce(`Couldn't read ${path}${BAKED_SUFFIX} (${(err as Error).message}); loading ${path} instead.`);
    }
  }
  three ??= await import("three");
  const bytes = await fetchBytes(url);
  if (/\.(gltf|glb)$/i.test(path)) {
    const { parseGltf, projectFiles } = await import("./gltf");
    const gltf = await parseGltf(bytes, projectFiles(path, fetchBytes, warnOnce)).catch((err: unknown) => {
      throw new Error(`${path}: ${(err as Error)?.message ?? err}`);
    });
    if (gltf.ignored.length) warnOnce(`${path}: not imported yet: ${gltf.ignored.join(", ")}.`);
    const data = bakeMeshes(gltf.root, settings, { flipV: true });
    if (!data.meshes.length) warnOnce(`${path} has no meshes.`);
    return data;
  }
  const loading = manager(path);
  let root: Object3D;
  if (/\.fbx$/i.test(path)) {
    const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
    root = new FBXLoader(loading).parse(bytes, "");
  } else {
    const text = new TextDecoder().decode(bytes);
    const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
    const loader = new OBJLoader(loading);
    const lib = /^mtllib\s+(.+?)\s*$/m.exec(text)?.[1];
    if (lib) {
      const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
      const mtl = resolveRelative(folder, lib.replace(/\\/g, "/"));
      if (mtl && Assets.has(mtl)) {
        const { MTLLoader } = await import("three/examples/jsm/loaders/MTLLoader.js");
        const creator = new MTLLoader(loading).parse(new TextDecoder().decode(await fetchBytes(Assets.url(mtl))), "");
        creator.preload();
        loader.setMaterials(creator);
      } else {
        warnOnce(`${path} uses the material library "${lib}", which isn't in the project; its meshes use the default material.`);
      }
    }
    root = loader.parse(text);
  }
  await loading.settled();
  const data = bakeMeshes(root, settings);
  if (!data.meshes.length) warnOnce(`${path} has no meshes.`);
  return data;
}

/**
 * @internal A model file baked for a game build (ADR 0090): loaded from the file itself (never an
 * earlier baked copy) with its import settings, then encoded. `dropped` lists textures that
 * couldn't be kept (neither a project file nor stored in the model).
 */
export async function bakeModelFile(ref: string): Promise<{ bytes: Uint8Array; dropped: string[] }> {
  const path = splitSpriteRef(normalizeAssetPath(ref)).path;
  const settings = Assets.importSettings(path);
  const data = await parseModel(path, Assets.url(path), settings, false);
  try {
    return encodeBakedModel(data, settings);
  } finally {
    disposeModel(data);
  }
}

/** @internal How a format's meshes bake, beyond the import settings. */
export interface BakeOptions {
  /** Flip V in the UVs (glTF puts v = 0 at the image's top; the engine's meshes put it at the bottom). */
  readonly flipV?: boolean;
}

/** @internal The model's meshes with their place in the file and the import settings baked into copies of their geometry. */
export function bakeMeshes(root: Object3D, settings: Pick<ImportSettings, "scale" | "upAxis" | "normals">, options: BakeOptions = {}): ModelData {
  const { Matrix4 } = lib();
  root.updateMatrixWorld(true);
  const importMatrix = new Matrix4().makeScale(settings.scale, settings.scale, settings.scale);
  if (settings.upAxis === "z") importMatrix.multiply(new Matrix4().makeRotationX(-Math.PI / 2));
  const meshes: ModelMesh[] = [];
  const used = new Set<string>();
  const converted = new Map<Material, Material>();
  const matrix = new Matrix4();
  const instance = new (lib().Matrix4)();
  // ADR 0118: every node's model-space pose, the group nodes on mesh paths, lights and cameras.
  const poseOf = (o: Object3D): NodePose => {
    matrix.multiplyMatrices(importMatrix, o.matrixWorld);
    const { Vector3, Quaternion } = lib();
    const p = new Vector3(), q = new Quaternion(), sc = new Vector3();
    matrix.decompose(p, q, sc);
    return { position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w], scale: [sc.x, sc.y, sc.z] };
  };
  const nodes: ModelNode[] = [];
  const groupKeys = new Set<string>();
  const addGroups = (o: Object3D) => {
    const chain: Object3D[] = [];
    for (let p = o.parent; p && p !== root; p = p.parent) if (p.name) chain.unshift(p);
    chain.forEach((g, i) => {
      const path = chain.slice(0, i).map((c) => safeName(c.name));
      const key = [...path, safeName(g.name)].join("/");
      if (groupKeys.has(key)) return;
      groupKeys.add(key);
      nodes.push({ name: safeName(g.name), path, pose: poseOf(g) });
    });
  };
  const variantNames = (root.userData.mycoVariants as string[] | undefined) ?? [];
  const convert = (m: Material) => {
    let c = converted.get(m);
    if (!c) {
      converted.set(m, (c = standardMaterial(m)));
      if (!c.name) c.name = `Material ${converted.size}`; // a name to key material slots by (ADR 0089)
    }
    return c;
  };
  root.traverse((o) => {
    const special = o.userData as { mycoLight?: ModelLight; mycoCamera?: ModelCamera };
    if (special.mycoLight || special.mycoCamera) {
      addGroups(o);
      const k = settings.scale;
      const light = special.mycoLight && { ...special.mycoLight, range: special.mycoLight.range * k };
      const camera = special.mycoCamera && { ...special.mycoCamera, near: special.mycoCamera.near * k, far: special.mycoCamera.far * k, orthographicSize: special.mycoCamera.orthographicSize * k };
      nodes.push({ name: safeName(o.name) || (light ? "Light" : "Camera"), path: ancestry(o, root), pose: poseOf(o), ...(light ? { light } : {}), ...(camera ? { camera } : {}) });
    }
  });
  root.traverse((o) => {
    const mesh = o as Mesh & { isInstancedMesh?: boolean; count?: number; getMatrixAt?(i: number, m: Matrix4): void };
    if (!mesh.isMesh || !mesh.geometry?.getAttribute("position")) return;
    const sources = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    const variantSources = mesh.userData.mycoVariantMaterials as Record<string, (Material | null)[]> | undefined;
    const allSources = variantSources ? [...sources, ...Object.values(variantSources).flatMap((list) => list.filter((m): m is Material => !!m))] : sources;
    // UV transforms (KHR_texture_transform) are baked into the copy's UVs, in the file's UV space.
    const uvTransforms = options.flipV ? uvTransformsOf(allSources, mesh.name) : null;
    // EXT_mesh_gpu_instancing: every instance baked into one geometry.
    const copies = mesh.isInstancedMesh && mesh.getMatrixAt ? Array.from({ length: mesh.count ?? 0 }, (_, i) => (mesh.getMatrixAt!(i, instance), instance.clone())) : [null];
    const parts = copies.map((at) => {
      const geometry = floatCopy(mesh.geometry);
      matrix.multiplyMatrices(importMatrix, mesh.matrixWorld);
      if (at) matrix.multiply(at);
      geometry.applyMatrix4(matrix);
      if (matrix.determinant() < 0) flipWinding(geometry);
      return geometry;
    });
    let geometry = parts[0];
    if (parts.length > 1) geometry = concatInstances(parts) ?? parts[0];
    if (!parts.length) return;
    if (uvTransforms) applyUvTransforms(geometry, uvTransforms);
    if (options.flipV) for (const name of ["uv", "uv1"]) flipV(geometry.getAttribute(name) as BufferAttribute | undefined);
    if (settings.normals === "calculate" || !geometry.getAttribute("normal")) {
      geometry.deleteAttribute("normal");
      geometry.computeVertexNormals();
    }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const materials = sources.map(convert);
    const neutral = neutralMesh(geometry, materials);
    let variantSurfaces: Record<string, SurfaceInfo[]> | undefined;
    if (variantSources) {
      for (const name of variantNames) {
        const list = variantSources[name];
        if (!list) continue;
        variantSurfaces ??= {};
        variantSurfaces[name] = neutral.surfaces.map((s, i) => (list[i] ? sharedSurface(convert(list[i]!)) : s));
      }
    }
    addGroups(mesh);
    meshes.push({
      name: uniqueName(mesh.name || mesh.parent?.name || "mesh", used),
      geometry,
      materials,
      ...neutral,
      path: ancestry(mesh, root),
      pose: poseOf(mesh),
      ...(variantSurfaces ? { variantSurfaces } : {}),
    });
  });
  return { meshes, ...(nodes.length ? { nodes } : {}), ...(variantNames.length ? { variants: [...variantNames] } : {}) };
}

/** A node name as the engine keeps it in paths (no `#`, `/`, `\` or quotes). */
const safeName = (name: string) => name.replace(/[#/\\"']/g, "_");

/** The names of the nodes between the root and `o` (both left out), outermost first; unnamed ones skipped. */
function ancestry(o: Object3D, root: Object3D): string[] {
  const out: string[] = [];
  for (let p = o.parent; p && p !== root; p = p.parent) if (p.name) out.unshift(safeName(p.name));
  return out;
}

/** A copy of a geometry with float attributes (quantized glTF meshes would lose precision when transformed in place). */
function floatCopy(source: BufferGeometry): BufferGeometry {
  const { BufferAttribute } = lib();
  const g = source.clone();
  for (const name of Object.keys(g.attributes)) {
    const attr = g.getAttribute(name) as BufferAttribute & { isInterleavedBufferAttribute?: boolean };
    if (attr.array instanceof Float32Array && !attr.isInterleavedBufferAttribute) continue;
    const out = new Float32Array(attr.count * attr.itemSize);
    for (let i = 0; i < attr.count; i++) for (let k = 0; k < attr.itemSize; k++) out[i * attr.itemSize + k] = attr.getComponent(i, k);
    g.setAttribute(name, new BufferAttribute(out, attr.itemSize));
  }
  g.morphAttributes = {};
  return g;
}

/** Instances of one geometry as one geometry (null if it can't be merged). */
function concatInstances(parts: BufferGeometry[]): BufferGeometry | null {
  const { BufferAttribute, BufferGeometry } = lib();
  const first = parts[0];
  const names = Object.keys(first.attributes);
  const vertices = first.getAttribute("position").count;
  const out = new BufferGeometry();
  for (const name of names) {
    const size = first.getAttribute(name).itemSize;
    const array = new Float32Array(vertices * size * parts.length);
    parts.forEach((p, i) => array.set((p.getAttribute(name) as BufferAttribute).array as Float32Array, i * vertices * size));
    out.setAttribute(name, new BufferAttribute(array, size));
  }
  const index = first.getIndex();
  const per = index ? index.count : vertices;
  const indices = new Uint32Array(per * parts.length);
  parts.forEach((p, i) => {
    const own = p.getIndex();
    for (let k = 0; k < per; k++) indices[i * per + k] = i * vertices + (own ? own.getX(k) : k);
  });
  out.setIndex(new BufferAttribute(indices, 1));
  for (const g of first.groups) parts.forEach((_, i) => out.addGroup(i * per + g.start, g.count, g.materialIndex));
  return out;
}

type UvTransform = { channel: number; m: number[] };

/** Each UV set's transform (KHR_texture_transform) from the material's textures; mismatched ones warn once. */
function uvTransformsOf(materials: readonly Material[], meshName: string): UvTransform[] | null {
  const found = new Map<number, number[]>();
  for (const material of materials) {
    for (const key of ["map", "normalMap", "emissiveMap", "roughnessMap", "metalnessMap", "aoMap"]) {
      const t = (material as unknown as Record<string, Texture | null | undefined>)[key];
      if (!t) continue;
      if (t.offset.x === 0 && t.offset.y === 0 && t.repeat.x === 1 && t.repeat.y === 1 && t.rotation === 0) continue;
      t.updateMatrix();
      const m = t.matrix.elements.slice();
      const channel = (t as Texture & { channel?: number }).channel ?? 0;
      const had = found.get(channel);
      if (!had) found.set(channel, m);
      else if (had.some((v, i) => Math.abs(v - m[i]) > 1e-6)) warnOnce(`Mesh "${meshName}": textures sharing a UV set have different texture transforms; the first is used for all.`);
    }
  }
  return found.size ? [...found].map(([channel, m]) => ({ channel, m })) : null;
}

function applyUvTransforms(g: BufferGeometry, transforms: UvTransform[]): void {
  for (const { channel, m } of transforms) {
    const attr = g.getAttribute(channel === 0 ? "uv" : `uv${channel}`) as BufferAttribute | undefined;
    if (!attr) continue;
    for (let i = 0; i < attr.count; i++) {
      const u = attr.getX(i), v = attr.getY(i);
      attr.setXY(i, m[0] * u + m[3] * v + m[6], m[1] * u + m[4] * v + m[7]); // three's Matrix3 is column-major
    }
  }
}

function flipV(attr: BufferAttribute | undefined): void {
  if (!attr) return;
  for (let i = 0; i < attr.count; i++) attr.setY(i, 1 - attr.getY(i));
}

function uniqueName(raw: string, used: Set<string>): string {
  const base = raw.replace(/[#/\\"']/g, "_").trim() || "mesh";
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
  used.add(name);
  return name;
}

/** Reverse each triangle (a mirrored mesh would otherwise draw inside out). */
function flipWinding(g: BufferGeometry): void {
  const index = g.getIndex();
  if (index) {
    const a = index.array;
    for (let i = 0; i + 2 < a.length; i += 3) [a[i + 1], a[i + 2]] = [a[i + 2], a[i + 1]];
    index.needsUpdate = true;
    return;
  }
  for (const name of Object.keys(g.attributes)) {
    const attr = g.getAttribute(name) as BufferAttribute;
    const n = attr.itemSize, a = attr.array;
    for (let i = 0; i + 2 < attr.count; i += 3) {
      for (let k = 0; k < n; k++) [a[(i + 1) * n + k], a[(i + 2) * n + k]] = [a[(i + 2) * n + k], a[(i + 1) * n + k]];
    }
    attr.needsUpdate = true;
  }
}

/** A loader's material (Phong, Lambert, Basic…) as the engine's default lit material (ADR 0043). */
function standardMaterial(source: Material): Material {
  const m = source as Material & {
    color?: ThreeColor;
    map?: Texture | null;
    normalMap?: Texture | null;
    emissive?: ThreeColor;
    emissiveMap?: Texture | null;
    alphaMap?: Texture | null;
    shininess?: number;
    vertexColors?: boolean;
  };
  const { MeshStandardMaterial, DoubleSide, FrontSide } = lib();
  if (source instanceof MeshStandardMaterial) return source;
  // glTF's unlit materials (MeshBasicMaterial) keep their look; they're drawn unlit (ADR 0088).
  if (source.userData?.mycoUnlit) return source;
  const out = new MeshStandardMaterial({
    name: source.name,
    color: m.color ? m.color.clone() : 0xffffff,
    map: m.map ?? null,
    normalMap: m.normalMap ?? null,
    emissive: m.emissive ? m.emissive.clone() : 0x000000,
    emissiveMap: m.emissiveMap ?? null,
    alphaMap: m.alphaMap ?? null,
    // Phong shininess (0..~1000) to roughness: shinier is smoother.
    roughness: typeof m.shininess === "number" ? Math.min(1, Math.max(0.05, Math.sqrt(2 / (m.shininess + 2)))) : 0.6,
    metalness: 0,
    transparent: source.transparent,
    opacity: source.opacity,
    side: (source.side === DoubleSide ? DoubleSide : FrontSide) as Side,
    vertexColors: !!m.vertexColors,
  });
  source.dispose();
  return out;
}

function disposeModel(data: ModelData): void {
  for (const mesh of data.meshes) {
    mesh.geometry?.dispose();
    for (const m of mesh.materials) m.dispose();
  }
}

/**
 * @internal A mesh's triangles for physics: vertex positions (x, y, z per vertex) and three
 * vertex indices per triangle.
 */
export function meshTriangles(mesh: ModelMesh): { vertices: Float32Array; indices: Uint32Array } {
  return { vertices: Float32Array.from(mesh.data.positions), indices: Uint32Array.from(mesh.data.indices) };
}

/** @internal Forget every loaded model (tests). */
export function clearModelCache(): void {
  for (const e of cache.values()) if (e.data) disposeModel(e.data);
  cache.clear();
  warned.clear();
}

/** @internal The material slots (ADR 0089) of what a mesh reference draws, if loaded (starting the load if not), else null. */
export function materialSlotsIfLoaded(ref: string): MaterialSlot[] | null {
  const meshes = meshesIfLoaded(ref);
  return meshes ? materialSlots(meshes) : null;
}

/** @internal The names of a model's meshes if it has loaded (starting the load if not), else null. */
export function meshNamesIfLoaded(path: string): string[] | null {
  return meshesIfLoaded(splitSpriteRef(normalizeAssetPath(path)).path)?.map((m) => m.name) ?? null;
}

/**
 * @internal What the editor's drop builds from a loaded model (ADR 0088, 0118): its meshes with their
 * node paths and poses, the group nodes, lights and cameras, and the import settings' pivot mode. Null while it loads.
 */
export function modelTreeIfLoaded(path: string): { pivots: ImportSettings["pivots"]; meshes: { name: string; path: readonly string[]; pose?: NodePose }[]; nodes: readonly ModelNode[] } | null {
  const p = splitSpriteRef(normalizeAssetPath(path)).path;
  if (!meshesIfLoaded(p)) return null;
  const data = cache.get(p)?.data;
  if (!data) return null;
  return { pivots: Assets.importSettings(p).pivots, meshes: data.meshes.map((m) => ({ name: m.name, path: m.path ?? [], pose: m.pose })), nodes: data.nodes ?? [] };
}

/** @internal Each mesh's name and the names of the nodes above it in the file (ADR 0088), if the model has loaded (starting the load if not), else null. */
export function meshTreeIfLoaded(path: string): { name: string; path: readonly string[] }[] | null {
  return meshesIfLoaded(splitSpriteRef(normalizeAssetPath(path)).path)?.map((m) => ({ name: m.name, path: m.path ?? [] })) ?? null;
}
