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
 *
 * An `.mtl` material library on its own loads as a sphere per material (`materialLibraryRoot`): what the
 * editor's preview of the library draws (ADR 0061).
 */
// Types only: three.js loads with the first model file parsed (`parseModel`), so it stays out of the
// start-up bundle of the editor and of games (ADR 0082); the built-in meshes need none of it.
import type { BufferAttribute, BufferGeometry, Color as ThreeColor, LoadingManager, Material, Matrix4, Mesh, Object3D, Side, Texture } from "three";
import { Assets, fetchAssetBytes, normalizeAssetPath, sidecarValue } from "./Assets";
import { BAKED_SUFFIX, decodeBakedModel, encodeBakedModel } from "./bakedModel";
import { BUILTIN_MESHES, builtinMeshData, type BuiltinMesh } from "./builtinMeshes";
import { isTextureMapStatement, materialLibraryFiles, readTextureMap, wavefrontStatements } from "./wavefront";
import { linearToSrgb } from "../core/colorSpace";
import { Mat4 } from "../core/math";
import { uniqueName } from "../core/uniqueName";
import { splitSpriteRef, type ImportSettings } from "./importSettings";
import type { GltfAnimationSource } from "./gltf";
import { parentsFirstSkeleton, rolesFromBoneMap, type ImportedBone, type ImportedSkeleton, type MeshSkin, type MorphTargetData } from "../animation/import/skeleton";
import { buildTake, type ChannelTarget, type ImportChannel, type ImportedTake, type TrsPath } from "../animation/import/channels";
import { clipsFromTakes, defaultModelAnimationSettings, type ImportedClip } from "../animation/import/clips";
import { identity, inverse, mapRotation, mapScale, mapTranslation, mul, toRowMajor3x4, trsSpace, type TrsSpace } from "../animation/import/space";
import { limitInfluences, type InfluenceSet, type SkinInfluences } from "../animation/import/skinWeights";
import { parsePointer, unmappedPointerWarning } from "../animation/import/pointer";
import { encodeSkeleton } from "../animation/import/skeletonBinary";
import { boneMapGuesser } from "../animation/import/boneMapGuess";
import { parseSkeletonProfile, type SkeletonProfile } from "../animation/skeletonProfile";

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
  /** Three per triangle; front faces wind so their right-hand normal points inward, as Babylon's left-handed default (ADR 0164). */
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
  /**
   * The material's texture transform (KHR_texture_transform) is animated (ADR 0371): it is kept here as a live value
   * instead of baked into the UVs, and the render sync applies it (T24). Absent for every other material.
   */
  readonly animatedTextureTransform?: { readonly offset: readonly [number, number]; readonly scale: readonly [number, number]; readonly rotation: number };
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
  /** Hidden in the file (`KHR_node_visibility`, ADR 0371); absent: visible. */
  readonly hidden?: true;
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
  /** Hidden in the file (`KHR_node_visibility`, ADR 0371); absent: visible. */
  readonly hidden?: true;
  // Skinning (ADR 0371; the fields T16's `render/skinning/skinData.ts` `SkinnedModelFields` reads):
  /** Its skin: joint indices into the model's skeleton (`ModelData.animation.skeleton`) and weights; absent: not skinned. */
  readonly skin?: MeshSkin | null;
  /** Its morph targets (deltas in the baked mesh's space); absent: none. */
  readonly morphTargets?: readonly MorphTargetData[];
  /** x, y, z, w per vertex (the file's tangents, baked like the normals); absent or null: none. */
  readonly tangents?: Float32Array | null;
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
  if (source.userData?.mycoAnimatedTextureTransform) surface.animatedTextureTransform = source.userData.mycoAnimatedTextureTransform as SurfaceInfo["animatedTextureTransform"];
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
function neutralMesh(geometry: BufferGeometry, materials: readonly Material[]): { data: MeshData; surfaces: SurfaceInfo[] } {
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
  /** Its skeleton, takes and clips (ADR 0371); absent for a model with neither. */
  readonly animation?: ModelAnimation;
}

/** @internal A model's animation (ADR 0371): what `model.glb#Skeleton` and `model.glb#Anim/<name>` name. */
export interface ModelAnimation {
  /** The skeleton every skinned mesh's joints index (one per model), or null. */
  readonly skeleton: ImportedSkeleton | null;
  /** The file's animations, whole. */
  readonly takes: readonly ImportedTake[];
  /** The clips cut from them by the sidecar (`animation.clips`), each a 0371 track model for the compile (T19). */
  readonly clips: readonly ImportedClip[];
  /** Profile role → bone: the sidecar's `boneMap`, else the core's guess, else empty. */
  readonly boneMap: Readonly<Record<string, string>>;
  /** Where `boneMap` came from. */
  readonly boneMapSource: "sidecar" | "guessed" | "none";
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
  // since `meshesIfLoaded` reports the model as loading from now on (physics copies triangles). A replaced load
  // that hasn't finished yet goes too, once both have settled, or its meshes would never be disposed.
  if (cached) {
    void Promise.allSettled([cached.promise, entry.promise]).then(() => {
      if (cached.data) disposeModel(cached.data);
    });
  }
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
 * A model-space mesh in its node's space (ADR 0118): its vertices through the inverse of its
 * pose, made once per mesh. The mesh itself when its pose is the identity.
 */
function nodeSpaceMesh(mesh: ModelMesh): ModelMesh {
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

/** A file's bytes from its URL (`fetchAssetBytes`: fetched, or read from disk for the server's `file:` URLs), as the loaders' ArrayBuffer. */
async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const bytes = await fetchAssetBytes(url);
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
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
  const { LoadingManager } = lib();
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

/**
 * An `.mtl` as three.js's MTLLoader reads it right. Its map reader takes the rest of the line after `-bm`, `-mm`, and
 * a three-number `-s`/`-o` as the file name, so every other option (`-clamp on`, `-imfchan r`…) and a shorter `-s`/`-o`
 * ended up in the name. Each map statement is rewritten as the specifications read it (`wavefront.ts`, ADR 0394): the
 * options three.js uses, padded to their full arguments with the specification's defaults, then the one file name.
 * Continued lines are joined; everything else is kept as written.
 */
function forMtlLoader(text: string): string {
  const lines: string[] = [];
  for (const s of wavefrontStatements(text)) {
    const keyword = s.keyword.text.toLowerCase();
    const last = s.args.at(-1) ?? s.keyword;
    const written = text.slice(s.keyword.start, last.end);
    if (!isTextureMapStatement(keyword)) {
      lines.push(written.includes("\n") ? [s.keyword, ...s.args].map((t) => t.text).join(" ") : written);
      continue;
    }
    const map = readTextureMap(s.args);
    if (!map.file) continue;
    if (map.extra.length) warnOnce(`A material library's "${written}" names one file, "${map.file.text}"; the rest of the line isn't part of it (Wavefront file names have no spaces).`);
    const out = [keyword];
    for (const o of map.options) {
      const a = o.args.map((t) => t.text);
      if (o.name === "-bm" && (keyword === "bump" || keyword === "map_bump" || keyword === "norm")) out.push("-bm", a[0]!);
      else if (o.name === "-mm" && keyword === "disp") out.push("-mm", a[0]!, a[1] ?? "1");
      else if (o.name === "-s") out.push("-s", a[0]!, a[1] ?? "1", a[2] ?? "1");
      else if (o.name === "-o") out.push("-o", a[0]!, a[1] ?? "0", a[2] ?? "0");
    }
    out.push(map.file.text);
    lines.push(out.join(" "));
  }
  return lines.join("\n");
}

/** Space between the centres of a material library's swatch spheres (each one unit across). */
const SWATCH_SPACING = 1.25;

/**
 * A material library (`.mtl`) as a model to look at: one unit sphere per material, named after it and drawing it
 * (textures found as an .obj's are), in rows of a square grid. It's what the library's preview shows; an .obj
 * that uses the library still loads it itself.
 */
async function materialLibraryRoot(text: string, loading: LoadingManager): Promise<Object3D> {
  const { MTLLoader } = await import("three/examples/jsm/loaders/MTLLoader.js");
  const creator = new MTLLoader(loading).parse(forMtlLoader(text), "");
  creator.preload();
  const names = Object.keys(creator.materialsInfo);
  const root = new (lib().Group)();
  const sphere = new (lib().SphereGeometry)(0.5, 48, 24);
  const columns = Math.max(1, Math.ceil(Math.sqrt(names.length)));
  names.forEach((name, i) => {
    const mesh = new (lib().Mesh)(sphere, creator.create(name));
    mesh.name = name;
    mesh.position.set((i % columns) * SWATCH_SPACING, -Math.floor(i / columns) * SWATCH_SPACING, 0);
    root.add(mesh);
  });
  return root;
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
    const data = bakeMeshes(gltf.root, settings, { flipV: true, gltf: gltf.animation, warn: (m) => warnOnce(`${path}: ${m}`) });
    if (!data.meshes.length) warnOnce(`${path} has no meshes.`);
    return finishAnimation(path, data, settings);
  }
  const loading = manager(path);
  let root: Object3D;
  if (/\.fbx$/i.test(path)) {
    const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
    root = new FBXLoader(loading).parse(bytes, "");
  } else if (/\.mtl$/i.test(path)) {
    root = await materialLibraryRoot(new TextDecoder().decode(bytes), loading);
  } else {
    const text = new TextDecoder().decode(bytes);
    const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
    const loader = new OBJLoader(loading);
    // Every file of every `mtllib` statement is a library, the first named searched first (ADR 0394).
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    const libraries: string[] = [];
    for (const lib of materialLibraryFiles(text)) {
      const mtl = resolveRelative(folder, lib.text.replace(/\\/g, "/"));
      if (mtl && Assets.has(mtl)) libraries.push(forMtlLoader(new TextDecoder().decode(await fetchBytes(Assets.url(mtl)))));
      else warnOnce(`${path} uses the material library "${lib.text}", which isn't in the project; the materials only it defines draw with the default material.`);
    }
    if (libraries.length) {
      const { MTLLoader } = await import("three/examples/jsm/loaders/MTLLoader.js");
      // MTLLoader keeps the last definition of a name, so the libraries go in last first.
      const creator = new MTLLoader(loading).parse(libraries.reverse().join("\n"), "");
      creator.preload();
      loader.setMaterials(creator);
    }
    root = loader.parse(text);
  }
  await loading.settled();
  const data = bakeMeshes(root, settings, { warn: (m) => warnOnce(`${path}: ${m}`) });
  if (!data.meshes.length) warnOnce(`${path} has no meshes.`);
  return finishAnimation(path, data, settings);
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
  /** A glTF's animations (ADR 0371); without it, the root's three.js `animations` (FBX) are read. */
  readonly gltf?: GltfAnimationSource;
  /** Where import warnings go (once each). */
  readonly warn?: (message: string) => void;
}

/**
 * @internal The model's meshes with their place in the file and the import settings baked into copies of their geometry.
 *
 * Model files are right-handed; the engine is left-handed (ADR 0164). The import matrix mirrors x
 * (`facing: "forward"`, the file's +Z faces forward) or z (`"back"`). Mirrored triangles keep their
 * index order: front faces are then clockwise, the renderer's default. Node poses are the mirror on
 * both sides of the node's matrix, so they stay proper rotations: positions mirrored, quaternions
 * (x, -y, -z, w) for x, (-x, -y, z, w) for z.
 */
export function bakeMeshes(root: Object3D, settings: Pick<ImportSettings, "scale" | "upAxis" | "normals"> & Partial<Pick<ImportSettings, "facing" | "animation">>, options: BakeOptions = {}): ModelData {
  const { Matrix4 } = lib();
  root.updateMatrixWorld(true);
  const back = settings.facing === "back";
  const mirror = new Matrix4().makeScale(back ? 1 : -1, 1, back ? -1 : 1);
  const importMatrix = mirror.clone().multiply(new Matrix4().makeScale(settings.scale, settings.scale, settings.scale));
  if (settings.upAxis === "z") importMatrix.multiply(new Matrix4().makeRotationX(-Math.PI / 2));
  // Lights and cameras point along their node's -Z in the file and +Z in the engine. Mirroring z
  // turns one into the other; mirroring x needs a half turn about the node's Y as well.
  const lensTurn = back ? null : new Matrix4().makeRotationY(Math.PI);
  const meshes: ModelMesh[] = [];
  const used = new Set<string>();
  const converted = new Map<Material, Material>();
  const matrix = new Matrix4();
  const instance = new (lib().Matrix4)();
  // ADR 0118: every node's model-space pose, the group nodes on mesh paths, lights and cameras.
  const poseOf = (o: Object3D, lens = false): NodePose => {
    matrix.multiplyMatrices(importMatrix, o.matrixWorld).multiply(mirror);
    if (lens && lensTurn) matrix.multiply(lensTurn);
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
      nodes.push({ name: safeName(g.name), path, pose: poseOf(g), ...(g.userData.mycoHidden ? { hidden: true as const } : {}) });
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
      nodes.push({ name: safeName(o.name) || (light ? "Light" : "Camera"), path: ancestry(o, root), pose: poseOf(o, true), ...(light ? { light } : {}), ...(camera ? { camera } : {}), ...(o.userData.mycoHidden ? { hidden: true as const } : {}) });
    }
  });
  // ADR 0371: the skeleton (every skin's joints, parents first) and the materials whose texture transform is animated.
  const rig = importSkeleton(root, importMatrix);
  if (options.gltf) markAnimatedTextureTransforms(root, options.gltf);
  const meshObjects = new Map<Object3D, string>();
  root.traverse((o) => {
    const mesh = o as Mesh & { isInstancedMesh?: boolean; count?: number; getMatrixAt?(i: number, m: Matrix4): void };
    if (!mesh.isMesh || !mesh.geometry?.getAttribute("position")) return;
    const sources = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    const variantSources = mesh.userData.mycoVariantMaterials as Record<string, (Material | null)[]> | undefined;
    const allSources = variantSources ? [...sources, ...Object.values(variantSources).flatMap((list) => list.filter((m): m is Material => !!m))] : sources;
    // UV transforms (KHR_texture_transform) are baked into the copy's UVs, in the file's UV space.
    const uvTransforms = options.flipV ? uvTransformsOf(allSources.filter((m) => !m.userData.mycoAnimatedTextureTransform), mesh.name) : null;
    // EXT_mesh_gpu_instancing: every instance baked into one geometry.
    const copies = mesh.isInstancedMesh && mesh.getMatrixAt ? Array.from({ length: mesh.count ?? 0 }, (_, i) => (mesh.getMatrixAt!(i, instance), instance.clone())) : [null];
    const calculate = settings.normals === "calculate" || !mesh.geometry.getAttribute("normal");
    let flipped = false;
    let linear: Matrix4 | null = null;
    const parts = copies.map((at) => {
      const geometry = floatCopy(mesh.geometry);
      // Normals from the file's winding, before the mirror (whose triangles keep their order).
      if (calculate) {
        geometry.deleteAttribute("normal");
        geometry.computeVertexNormals();
      }
      matrix.multiplyMatrices(importMatrix, mesh.matrixWorld);
      if (at) matrix.multiply(at);
      geometry.applyMatrix4(matrix);
      // The handedness mirror keeps index order; a node mirrored in the file (det < 0) rewinds.
      if (matrix.determinant() > 0) {
        flipWinding(geometry);
        flipped = true;
      }
      linear ??= matrix.clone();
      return geometry;
    });
    let geometry = parts[0];
    if (parts.length > 1) geometry = concatInstances(parts) ?? parts[0];
    if (!parts.length) return;
    if (uvTransforms) applyUvTransforms(geometry, uvTransforms);
    if (options.flipV) for (const name of ["uv", "uv1"]) flipV(geometry.getAttribute(name) as BufferAttribute | undefined);
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
    // ADR 0371: skin, morph targets and tangents (instanced meshes have none of these).
    const single = parts.length === 1 && linear !== null;
    const skin = single && rig ? meshSkin(mesh, geometry, rig, importMatrix, settings.animation?.influences ?? 4) : null;
    const morphTargets = single ? meshMorphs(mesh, linear!, flipped && !geometry.getIndex()) : [];
    const tangents = single ? meshTangents(geometry, linear!) : null;
    const name = meshName(mesh.name || mesh.parent?.name || "mesh", used);
    meshObjects.set(mesh, name);
    meshes.push({
      name,
      geometry,
      materials,
      ...neutral,
      path: ancestry(mesh, root),
      pose: poseOf(mesh),
      ...(variantSurfaces ? { variantSurfaces } : {}),
      ...(mesh.userData.mycoHidden ? { hidden: true as const } : {}),
      ...(skin ? { skin } : {}),
      ...(morphTargets.length ? { morphTargets } : {}),
      ...(tangents ? { tangents } : {}),
    });
  });
  const takes = importTakes(root, { meshes, nodes, meshObjects, rig, importMatrix, mirror, scale: settings.scale, gltf: options.gltf, warn: options.warn });
  const animation: ModelAnimation | undefined = rig || takes.length ? { skeleton: rig?.skeleton ?? null, takes, clips: [], boneMap: {}, boneMapSource: "none" } : undefined;
  return { meshes, ...(nodes.length ? { nodes } : {}), ...(variantNames.length ? { variants: [...variantNames] } : {}), ...(animation ? { animation } : {}) };
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

/** A mesh name not in `used` (which it joins): `raw` made safe, else with `_2`, `_3`… */
function meshName(raw: string, used: Set<string>): string {
  const name = uniqueName(raw.replace(/[#/\\"']/g, "_").trim() || "mesh", used, { format: (stem, n) => `${stem}_${n}`, first: 2 });
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

// --- animation (ADR 0371) -------------------------------------------------------------------------

/** A model's skeleton as the bake builds it: the skeleton, each bone object's index and each bone's space. */
interface Rig {
  readonly skeleton: ImportedSkeleton;
  readonly boneIndex: ReadonlyMap<Object3D, number>;
  readonly spaces: readonly TrsSpace[];
}

type SkinnedObject = Mesh & { isSkinnedMesh?: boolean; skeleton?: { bones: (Object3D | null)[]; boneInverses: Matrix4[] }; bindMatrix?: Matrix4; morphTargetDictionary?: Record<string, number> };

const f64 = (m: Matrix4): Float64Array => Float64Array.from(m.elements);

/** A bone's name as the file wrote it (three sanitises names for its property bindings), made safe for paths. */
const boneName = (o: Object3D): string => safeName(String(o.userData.name ?? o.userData.originalName ?? o.name ?? "")) || "Bone";

/** A skinned mesh's inverse bind matrix for its palette entry `j`, engine space: `M · boneInverse · bind · meshWorld⁻¹ · M⁻¹`. */
function engineInverseBind(mesh: SkinnedObject, j: number, m: Float64Array, mInv: Float64Array): Float64Array {
  const boneInverse = f64(mesh.skeleton!.boneInverses[j]);
  const bind = mesh.bindMatrix ? f64(mesh.bindMatrix) : identity();
  return mul(mul(mul(mul(m, boneInverse), bind), inverse(f64(mesh.matrixWorld))), mInv);
}

/**
 * The skeleton of every skinned mesh's joints (ADR 0371): bones in parents-first order, each bone's parent the nearest
 * ancestor that is a bone (static nodes between fold into its rest and tracks, `space.ts`), rest poses and inverse
 * binds in engine space. Null when nothing is skinned.
 */
function importSkeleton(root: Object3D, importMatrix: Matrix4): Rig | null {
  const skinned: SkinnedObject[] = [];
  root.traverse((o) => {
    const s = o as SkinnedObject;
    if (s.isSkinnedMesh && s.skeleton) skinned.push(s);
  });
  const objects: Object3D[] = [];
  const seen = new Set<Object3D>();
  for (const s of skinned) for (const b of s.skeleton!.bones) if (b && !seen.has(b)) (seen.add(b), objects.push(b));
  if (!objects.length) return null;
  const m = f64(importMatrix), mInv = inverse(m);
  const bindOf = new Map<Object3D, Float64Array>();
  for (const s of skinned) s.skeleton!.bones.forEach((b, j) => b && !bindOf.has(b) && bindOf.set(b, engineInverseBind(s, j, m, mInv)));
  const used = new Set<string>();
  const index = new Map(objects.map((o, i) => [o, i]));
  const spaces: TrsSpace[] = [];
  const bones: ImportedBone[] = objects.map((o) => {
    let parentBone: Object3D | null = null;
    for (let p = o.parent; p; p = p.parent) if (seen.has(p)) { parentBone = p; break; }
    const parentWorld = o.parent ? f64(o.parent.matrixWorld) : identity();
    const fold = parentBone ? mul(inverse(f64(parentBone.matrixWorld)), parentWorld) : parentWorld;
    const space = trsSpace(mul(m, fold), mInv);
    spaces.push(space);
    const q = mapRotation(space, o.quaternion.toArray());
    const len = Math.hypot(...q) || 1;
    const name = uniqueName(boneName(o), used, { format: (stem, n) => `${stem}_${n}`, first: 2 });
    used.add(name);
    return {
      name,
      parent: parentBone ? index.get(parentBone)! : -1,
      rest: { position: mapTranslation(space, o.position.toArray()), rotation: q.map((v) => v / len) as [number, number, number, number], scale: mapScale(space, o.scale.toArray()) },
    };
  });
  const binds = new Float32Array(objects.length * 12);
  objects.forEach((o, i) => toRowMajor3x4(bindOf.get(o) ?? inverse(mul(m, f64(o.matrixWorld))), binds, i * 12));
  const ordered = parentsFirstSkeleton(bones, binds);
  const boneIndex = new Map(objects.map((o, i) => [o, ordered.remap[i]]));
  const orderedSpaces: TrsSpace[] = [];
  objects.forEach((_, i) => (orderedSpaces[ordered.remap[i]] = spaces[i]));
  return { skeleton: { bones: ordered.bones, inverseBinds: ordered.inverseBinds, roles: ordered.bones.map(() => null), profile: null }, boneIndex, spaces: orderedSpaces };
}

/** A skinned mesh's skin (ADR 0371): its influences limited and normalised, joint indices into the skeleton's bones. */
function meshSkin(mesh: SkinnedObject, geometry: BufferGeometry, rig: Rig, importMatrix: Matrix4, influences: SkinInfluences): MeshSkin | null {
  if (!mesh.isSkinnedMesh || !mesh.skeleton) return null;
  const sets: InfluenceSet[] = [];
  for (const [j, w] of [["skinIndex", "skinWeight"], ["joints_1", "weights_1"]]) {
    const joints = geometry.getAttribute(j) as BufferAttribute | undefined;
    const weights = geometry.getAttribute(w) as BufferAttribute | undefined;
    if (joints && weights && joints.itemSize === weights.itemSize) sets.push({ size: joints.itemSize, joints: joints.array as ArrayLike<number>, weights: weights.array as ArrayLike<number> });
  }
  if (!sets.length) return null;
  const count = geometry.getAttribute("position").count;
  const limited = limitInfluences(count, sets, influences);
  const palette = mesh.skeleton.bones.map((b) => (b ? rig.boneIndex.get(b) ?? 0 : 0));
  const joints = limited.joints.map((j, i) => (limited.weights[i] > 0 ? palette[j] ?? 0 : 0));
  // Its own inverse binds only when they differ from the skeleton's for a bone it uses.
  const m = f64(importMatrix), mInv = inverse(m);
  let own: Float32Array | null = null;
  const scratch = new Float32Array(12);
  mesh.skeleton.bones.forEach((b, j) => {
    if (!b) return;
    toRowMajor3x4(engineInverseBind(mesh, j, m, mInv), scratch, 0);
    const at = palette[j] * 12;
    if (scratch.some((v, k) => Math.abs(v - rig.skeleton.inverseBinds[at + k]) > 1e-4)) {
      own ??= Float32Array.from(rig.skeleton.inverseBinds);
      own.set(scratch, at);
    }
  });
  return { influences, joints, weights: limited.weights, ...(own ? { inverseBinds: own } : {}) };
}

/** Swaps the second and third vertex of every triangle of a non-indexed per-vertex array (as `flipWinding` does). */
function swapTriangles(a: Float32Array, size: number): void {
  for (let i = 0; i + 2 < a.length / size; i += 3) {
    for (let k = 0; k < size; k++) [a[(i + 1) * size + k], a[(i + 2) * size + k]] = [a[(i + 2) * size + k], a[(i + 1) * size + k]];
  }
}

/** A mesh's morph targets (ADR 0371): deltas through the bake's matrix (positions and tangents its linear part, normals its normal matrix). */
function meshMorphs(mesh: SkinnedObject, matrix: Matrix4, swap: boolean): MorphTargetData[] {
  const g = mesh.geometry;
  const positions = g.morphAttributes.position ?? [];
  if (!positions.length) return [];
  const { Matrix3, Vector3 } = lib();
  const linear = new Matrix3().setFromMatrix4(matrix);
  const normalMatrix = new Matrix3().getNormalMatrix(matrix);
  const base = g.getAttribute("position") as BufferAttribute;
  const v = new Vector3();
  const names = new Map(Object.entries(mesh.morphTargetDictionary ?? {}).map(([name, i]) => [i, name]));
  const used = new Set<string>();
  const deltas = (attr: BufferAttribute | undefined, m: InstanceType<typeof Matrix3>, absolute: BufferAttribute | null): Float32Array | null => {
    if (!attr) return null;
    const out = new Float32Array(attr.count * 3);
    for (let i = 0; i < attr.count; i++) {
      v.set(attr.getX(i), attr.getY(i), attr.getZ(i));
      if (absolute) v.sub(new Vector3(absolute.getX(i), absolute.getY(i), absolute.getZ(i)));
      v.applyMatrix3(m);
      out.set([v.x, v.y, v.z], i * 3);
    }
    if (swap) swapTriangles(out, 3);
    return out;
  };
  const relative = g.morphTargetsRelative;
  return positions.map((p, t) => {
    const name = uniqueName(safeName(names.get(t) ?? "") || `Morph ${t + 1}`, used, { format: (stem, n) => `${stem}_${n}`, first: 2 });
    used.add(name);
    const tangents = deltas((g.morphAttributes as unknown as Record<string, BufferAttribute[] | undefined>).tangent?.[t] as BufferAttribute | undefined, linear, null);
    return {
      name,
      positions: deltas(p as BufferAttribute, linear, relative ? null : base),
      normals: deltas(g.morphAttributes.normal?.[t] as BufferAttribute | undefined, normalMatrix, relative ? null : (g.getAttribute("normal") as BufferAttribute | null) ?? null),
      ...(tangents ? { tangents } : {}),
    };
  });
}

/** The baked geometry's tangents (x, y, z, w), w flipped when the bake mirrors (ADR 0164), or null. */
function meshTangents(geometry: BufferGeometry, matrix: Matrix4): Float32Array | null {
  const t = geometry.getAttribute("tangent") as BufferAttribute | undefined;
  if (!t || t.itemSize !== 4) return null;
  const out = Float32Array.from(t.array as ArrayLike<number>);
  if (matrix.determinant() < 0) for (let i = 3; i < out.length; i += 4) out[i] = -out[i];
  return out;
}

/** Flags glTF materials whose `KHR_texture_transform` a pointer animates (ADR 0371): they keep the transform live. */
function markAnimatedTextureTransforms(root: Object3D, gltf: GltfAnimationSource): void {
  const animated = new Set<number>();
  for (const a of gltf.animations) for (const c of a.channels) {
    const target = c.pointer ? parsePointer(c.pointer) : null;
    if (target?.type === "material" && target.textureTransform) animated.add(target.material);
  }
  if (!animated.size) return;
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const i = gltf.materialIndex(m);
      if (i === undefined || !animated.has(i) || m.userData.mycoAnimatedTextureTransform) continue;
      const t = ["map", "normalMap", "emissiveMap", "roughnessMap", "metalnessMap", "aoMap"].map((k) => (m as unknown as Record<string, Texture | null | undefined>)[k]).find((x) => x);
      m.userData.mycoAnimatedTextureTransform = t ? { offset: [t.offset.x, t.offset.y], scale: [t.repeat.x, t.repeat.y], rotation: t.rotation } : { offset: [0, 0], scale: [1, 1], rotation: 0 };
    }
  });
}

/** What turning a file's animations into takes needs from the bake. */
interface TakeContext {
  readonly meshes: readonly ModelMesh[];
  readonly nodes: readonly ModelNode[];
  readonly meshObjects: ReadonlyMap<Object3D, string>;
  readonly rig: Rig | null;
  readonly importMatrix: Matrix4;
  readonly mirror: Matrix4;
  readonly scale: number;
  readonly gltf?: GltfAnimationSource;
  readonly warn?: (message: string) => void;
}

const MESH_RENDERER = "engine.MeshRenderer";

/**
 * The file's animations as takes (ADR 0371; `animation/import/channels.ts` makes the tracks). Node paths are the ones
 * the editor's drop gives the model's nodes (ADR 0118: the file's named nodes, less the levels every node shares; a
 * model of one mesh and nothing else is one node, path ""), and node values are the local poses it gives them, so
 * tracks bind to a dropped model as it is.
 */
function importTakes(root: Object3D, cx: TakeContext): ImportedTake[] {
  const extras = cx.nodes.filter((n) => n.light || n.camera);
  const allPaths = [...cx.meshes.map((mm) => mm.path ?? []), ...extras.map((n) => n.path)];
  const oneNode = cx.meshes.length <= 1 && !extras.length;
  let shared = allPaths[0]?.length ?? 0;
  for (const p of allPaths) {
    let i = 0;
    while (i < shared && i < p.length && p[i] === allPaths[0][i]) i++;
    shared = i;
  }
  const m = f64(cx.importMatrix), mirror = f64(cx.mirror);
  const objectName = (o: Object3D) => cx.meshObjects.get(o) ?? (safeName(o.name) || ((o.userData as { mycoLight?: unknown }).mycoLight ? "Light" : (o.userData as { mycoCamera?: unknown }).mycoCamera ? "Camera" : ""));
  const nodePath = (o: Object3D): string => (oneNode && cx.meshObjects.has(o) ? "" : [...ancestry(o, root), objectName(o)].slice(shared).join("/"));
  /** The engine node above `o`: its nearest named ancestor the drop keeps. */
  const engineParent = (o: Object3D): Object3D | null => {
    if (oneNode) return null;
    for (let p = o.parent; p && p !== root; p = p.parent) if (p.name && ancestry(p, root).length >= shared) return p;
    return null;
  };
  const nodeSpace = (o: Object3D): TrsSpace => {
    const parentWorld = o.parent ? f64(o.parent.matrixWorld) : identity();
    const p = engineParent(o);
    const a = p ? mul(inverse(mul(mul(m, f64(p.matrixWorld)), mirror)), mul(m, parentWorld)) : mul(m, parentWorld);
    return trsSpace(a, mirror);
  };
  const trsTarget = (o: Object3D, path: TrsPath): ChannelTarget => {
    const bone = cx.rig?.boneIndex.get(o);
    if (bone !== undefined) return { kind: "bone", bone: cx.rig!.skeleton.bones[bone].name, path, space: cx.rig!.spaces[bone] };
    return { kind: "node", nodePath: nodePath(o), path, space: nodeSpace(o) };
  };
  const byName = new Map(cx.meshes.map((mm) => [mm.name, mm]));
  /** The model meshes a node object draws: itself, or its child meshes (a glTF mesh node holding lights or cameras). */
  const meshesOf = (o: Object3D): Object3D[] => [o, ...o.children].filter((c) => cx.meshObjects.has(c));
  const morphTargetsOf = (o: Object3D): ChannelTarget[] =>
    meshesOf(o).flatMap((mo) => {
      const names = byName.get(cx.meshObjects.get(mo)!)?.morphTargets?.map((t) => t.name) ?? [];
      return names.length ? [{ kind: "morph" as const, nodePath: nodePath(mo), names }] : [];
    });
  const takes: ImportedTake[] = [];
  if (cx.gltf) {
    const g = cx.gltf;
    const json = g.json;
    const unmapped: string[] = [];
    const nodeObject = (i: number) => g.nodes.get(i);
    const special = (o: Object3D | undefined, key: "mycoLight" | "mycoCamera") => (o ? [o, ...o.children].find((c) => c.userData[key]) : undefined);
    const meshEntries = [...cx.meshObjects].map(([o, name]) => ({ o, mesh: byName.get(name)! }));
    for (const anim of g.animations) {
      const channels: ImportChannel[] = [];
      for (const c of anim.channels) {
        const add = (target: ChannelTarget) => channels.push({ target, sampler: c.sampler });
        const pointed = c.pointer !== null ? parsePointer(c.pointer) : null;
        const node = c.pointer === null ? c.node : pointed?.type === "node" ? pointed.node : null;
        const path = c.pointer === null ? c.path : pointed?.type === "node" ? pointed.path : null;
        let mapped = false;
        if (node !== null && path !== null) {
          const o = nodeObject(node);
          if (o && (path === "translation" || path === "rotation" || path === "scale")) (add(trsTarget(o, path)), (mapped = true));
          else if (o && path === "weights") for (const t of morphTargetsOf(o)) (add(t), (mapped = true));
          else if (o && path === "visible") (add({ kind: "activation", nodePath: nodePath(o) }), (mapped = true));
        } else if (pointed?.type === "mesh") {
          (json.nodes ?? []).forEach((n, i) => {
            const o = n.mesh === pointed.mesh ? nodeObject(i) : undefined;
            if (o) for (const t of morphTargetsOf(o)) (add(t), (mapped = true));
          });
        } else if (pointed?.type === "material" && c.sampler.width === pointed.value.width) {
          const def = json.materials?.[pointed.material];
          const strength = def?.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
          const factor = def?.emissiveFactor ?? [0, 0, 0];
          const isStrength = pointed.field === "emission" && pointed.value.width === 1;
          const map = pointed.field === "emission" ? (isStrength ? (v: readonly number[]) => factor.map((f) => f * v[0]) : (v: readonly number[]) => v.map((x) => x * strength)) : undefined;
          for (const { o, mesh } of meshEntries) {
            mesh.materials.forEach((mat, slot) => {
              if (g.materialIndex(mat) !== pointed.material) return;
              add({ kind: "property", track: isStrength ? "vec3" : pointed.value.track, binding: { nodePath: nodePath(o), component: MESH_RENDERER, field: `materials[${slot}].${pointed.field}` }, ...(map ? { map } : {}) });
              mapped = true;
            });
          }
        } else if (pointed?.type === "light") {
          const def = json.extensions?.KHR_lights_punctual?.lights?.[pointed.light];
          const outer = def?.spot?.outerConeAngle ?? Math.PI / 4;
          const want = pointed.property === "color" ? 3 : 1;
          (json.nodes ?? []).forEach((n, i) => {
            const o = n.extensions?.KHR_lights_punctual?.light === pointed.light ? special(nodeObject(i), "mycoLight") : undefined;
            if (!o || c.sampler.width !== want) return;
            const binding = (field: string) => ({ nodePath: nodePath(o), component: "engine.Light", field });
            if (pointed.property === "color") add({ kind: "property", track: "color", binding: binding("color"), map: (v) => [linearToSrgb(v[0]), linearToSrgb(v[1]), linearToSrgb(v[2]), 1], linear: false });
            else if (pointed.property === "intensity") add({ kind: "property", track: "float", binding: binding("intensity") });
            else if (pointed.property === "range") add({ kind: "property", track: "float", binding: binding("range"), map: (v) => [v[0] * cx.scale] });
            else if (pointed.property === "outerConeAngle") add({ kind: "property", track: "float", binding: binding("spotAngle"), map: (v) => [(2 * v[0] * 180) / Math.PI] });
            else add({ kind: "property", track: "float", binding: binding("spotSoftness"), map: (v) => [outer > 0 ? Math.min(1, Math.max(0, 1 - v[0] / outer)) : 0], linear: false });
            mapped = true;
          });
        } else if (pointed?.type === "camera" && c.sampler.width === 1) {
          (json.nodes ?? []).forEach((n, i) => {
            const o = n.camera === pointed.camera ? special(nodeObject(i), "mycoCamera") : undefined;
            if (!o) return;
            const field = { yfov: "fieldOfView", znear: "near", zfar: "far", ymag: "orthographicSize" }[pointed.property];
            const k = pointed.property === "yfov" ? 180 / Math.PI : cx.scale;
            add({ kind: "property", track: "float", binding: { nodePath: nodePath(o), component: "engine.Camera", field }, map: (v) => [v[0] * k] });
            mapped = true;
          });
        }
        if (!mapped && c.pointer !== null) unmapped.push(c.pointer || "(no pointer)");
      }
      takes.push(buildTake(anim.name, channels));
    }
    const warning = unmappedPointerWarning(unmapped);
    if (warning) cx.warn?.(warning);
    return takes;
  }
  // FBX (and any three.js loader): the root's keyframe tracks, `<object>.<property>`.
  const clips = (root as Object3D & { animations?: { name: string; tracks: { name: string; times: ArrayLike<number>; values: ArrayLike<number>; getValueSize(): number; getInterpolation(): number }[] }[] }).animations ?? [];
  const byObjectName = new Map<string, Object3D>();
  root.traverse((o) => {
    if (o.name && !byObjectName.has(o.name)) byObjectName.set(o.name, o);
  });
  const PATHS: Record<string, TrsPath> = { position: "translation", quaternion: "rotation", scale: "scale" };
  clips.forEach((clip, ci) => {
    const channels: ImportChannel[] = [];
    for (const track of clip.tracks) {
      const parsed = /^(.*)\.(position|quaternion|scale|morphTargetInfluences)(?:\[(\d+)\])?$/.exec(track.name);
      const o = parsed ? byObjectName.get(parsed[1]) : undefined;
      if (!parsed || !o) continue;
      const sampler = { times: track.times, values: track.values, width: track.getValueSize(), interpolation: track.getInterpolation() === 2300 ? ("STEP" as const) : ("LINEAR" as const) };
      if (parsed[2] !== "morphTargetInfluences") channels.push({ target: trsTarget(o, PATHS[parsed[2]]), sampler });
      else if (parsed[3] !== undefined) {
        for (const t of morphTargetsOf(o)) if (t.kind === "morph" && t.names[Number(parsed[3])]) channels.push({ target: { ...t, names: [t.names[Number(parsed[3])]] }, sampler });
      }
    }
    takes.push(buildTake(clip.name || `Take ${ci + 1}`, channels));
  });
  return takes;
}

/**
 * A baked model's animation finished (ADR 0371): clips cut from the takes by the sidecar, and the bone map (the
 * sidecar's, else guessed by the animation core when the Animation plugin installed its guesser) giving the skeleton
 * its roles. Problems warn once each.
 */
async function finishAnimation(path: string, data: ModelData, settings: ImportSettings): Promise<ModelData> {
  const a = data.animation;
  if (!a) return data;
  const sidecar = settings.animation ?? defaultModelAnimationSettings();
  const problems: string[] = [];
  const clips = clipsFromTakes(a.takes, sidecar, problems);
  for (const p of problems) warnOnce(`${path}: ${p}`);
  let boneMap: Record<string, string> = { ...sidecar.boneMap };
  let source: ModelAnimation["boneMapSource"] = Object.keys(boneMap).length ? "sidecar" : "none";
  let skeleton = a.skeleton;
  if (skeleton && source === "none") {
    const guesser = boneMapGuesser();
    let guessed: Record<string, string> | null = null;
    if (guesser) {
      let profile: SkeletonProfile | null = null;
      if (sidecar.profile) {
        try {
          const profilePath = splitSpriteRef(normalizeAssetPath(sidecar.profile)).path;
          profile = parseSkeletonProfile(JSON.parse(new TextDecoder().decode(await fetchAssetBytes(Assets.url(profilePath))))).value;
        } catch (err) {
          warnOnce(`${path}: couldn't read the skeleton profile ${sidecar.profile} (${(err as Error).message}); guessing the bone map for the built-in Humanoid.`);
        }
      }
      guessed = await guesser(encodeSkeleton(skeleton), skeleton.bones.map((b) => b.name), profile).catch(() => null);
    }
    if (guessed) {
      boneMap = guessed;
      source = "guessed";
    } else warnOnce(`${path}: its bone map wasn't guessed (${guesser ? "the animation core can't run here" : "the Animation plugin isn't active"}); set animation.boneMap in its import settings to give its bones profile roles.`);
  }
  if (skeleton) {
    const { roles, missing } = rolesFromBoneMap(skeleton.bones, boneMap);
    if (missing.length && source === "sidecar") warnOnce(`${path}: animation.boneMap names bones the skeleton lacks (roles ${missing.join(", ")}); those roles are unmapped.`);
    skeleton = { ...skeleton, roles, profile: sidecar.profile };
  }
  return { ...data, animation: { ...a, skeleton, clips, boneMap, boneMapSource: source } };
}

/** @internal A model's skeleton sub-asset name (`model.glb#Skeleton`, ADR 0371). */
export const SKELETON_SUB_ASSET = "Skeleton";
/** @internal The prefix of a model's clip sub-assets (`model.glb#Anim/Run`, ADR 0371). */
export const CLIP_SUB_ASSET_PREFIX = "Anim/";

/** @internal The asset field kinds a model sub-asset satisfies by its name: `Skeleton` a `skeleton` field, `Anim/…` an `animclip` field. */
export function modelSubAssetKinds(sub: string): readonly string[] {
  if (sub === SKELETON_SUB_ASSET) return ["skeleton"];
  if (sub.startsWith(CLIP_SUB_ASSET_PREFIX) && sub.length > CLIP_SUB_ASSET_PREFIX.length) return ["animclip"];
  return [];
}

/** @internal A loaded model's animation sub-assets: `Skeleton` when it has one, then `Anim/<clip>` per clip. */
export function modelSubAssets(data: ModelData): string[] {
  const a = data.animation;
  if (!a) return [];
  return [...(a.skeleton ? [SKELETON_SUB_ASSET] : []), ...a.clips.map((c) => `${CLIP_SUB_ASSET_PREFIX}${c.name}`)];
}

/** @internal The animation sub-assets of the model at `path` once it has loaded (null while it loads or failed; the load isn't started). */
export function modelSubAssetsIfLoaded(path: string): readonly string[] | null {
  const data = cache.get(splitSpriteRef(normalizeAssetPath(path)).path)?.data;
  return data ? modelSubAssets(data) : null;
}

/** @internal What a model sub-asset reference resolves to (ADR 0371): `asset:hero.glb#Skeleton` or `asset:hero.glb#Anim/Run`. */
export type ModelSubAsset = { readonly kind: "skeleton"; readonly skeleton: ImportedSkeleton } | { readonly kind: "clip"; readonly clip: ImportedClip };

/** @internal The skeleton or clip a model sub-asset reference names, loading the model; null when the model has no such sub-asset. */
export async function loadModelSubAsset(ref: string): Promise<ModelSubAsset | null> {
  const { path, slice } = splitSpriteRef(normalizeAssetPath(ref));
  if (slice === null) return null;
  const a = (await loadModel(path)).animation;
  if (!a) return null;
  if (slice === SKELETON_SUB_ASSET) return a.skeleton ? { kind: "skeleton", skeleton: a.skeleton } : null;
  if (!slice.startsWith(CLIP_SUB_ASSET_PREFIX)) return null;
  const clip = a.clips.find((c) => c.name === slice.slice(CLIP_SUB_ASSET_PREFIX.length));
  return clip ? { kind: "clip", clip } : null;
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
