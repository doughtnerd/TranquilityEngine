/**
 * Babylon materials and meshes built from the engine's renderer-neutral data (ADR 0043, 0044, 0075):
 * material assets as PBR materials, model geometry as vertex data, model surfaces as PBR materials.
 * Shared by the World renderer (`BabylonRenderer.ts`) and the editor's preview renderers
 * (`previews/`), so a material looks the same in the scene, the Inspector and a thumbnail.
 */
import { Material as BabylonMaterial } from "@babylonjs/core/Materials/material.js";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { SubMesh } from "@babylonjs/core/Meshes/subMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { Color as EngineColor, type Color } from "../../core/math";
import type { MaterialSettings } from "../../scene/material";
import { DEFAULT_SLOT, type ModelMesh, type SurfaceInfo, type TextureInfo } from "../../scene/models";
import type { GraphValue } from "../../scene/shaderGraph";

/**
 * A PBR material for engine geometry. The engine's meshes wind their front faces counter-clockwise
 * (three.js and glTF convention); Babylon's default, even in a right-handed scene, is clockwise.
 */
export function pbr(name: string, scene: Scene): PBRMaterial {
  const m = new PBRMaterial(name, scene);
  m.sideOrientation = BabylonMaterial.CounterClockWiseSideOrientation;
  m.maxSimultaneousLights = 8; // Babylon's default is 4
  useEngineLightFalloff(m);
  return m;
}

/**
 * Light the material as the Light component says: point and spot lights fade with the square of
 * distance to nothing at their `range`, and a spot's edge is as soft as its `spotSoftness`. That is
 * Babylon's glTF falloff (KHR_lights_punctual, as three.js lit); its default physical falloff ignores
 * both the range and a spot's inner angle, so every spot drew as the same soft blob. The clustered
 * lights (ADR 0079) follow the material's falloff too.
 */
export function useEngineLightFalloff(m: PBRMaterial): void {
  m.useGLTFLightFalloff = true;
}

/** An sRGB engine colour as a linear Babylon colour (PBR colours are linear). */
export function linear(c: Color): Color3 {
  return new Color3(c.r, c.g, c.b).toLinearSpace();
}

/** Vertex data made from each model geometry, shared by every mesh drawing it. */
const vertexDatas = new WeakMap<object, VertexData>();

/** A model mesh's vertices (its renderer-neutral data) as Babylon vertex data, made once per mesh. */
export function vertexDataOf(src: ModelMesh): VertexData {
  let data = vertexDatas.get(src.data);
  if (data) return data;
  const d = src.data;
  data = new VertexData();
  data.positions = d.positions;
  data.indices = d.indices;
  if (d.uvs) data.uvs = d.uvs;
  if (d.uvs2) data.uvs2 = d.uvs2;
  if (d.colors) data.colors = d.colors;
  if (d.normals) data.normals = d.normals;
  else {
    const normals: number[] = [];
    VertexData.ComputeNormals(d.positions, d.indices, normals);
    data.normals = normals;
  }
  vertexDatas.set(src.data, data);
  return data;
}

let bufferTextures = 0;

/** A model texture (decoded image, bytes or URL) as a Babylon texture, or null. */
function surfaceTexture(scene: Scene, info: TextureInfo | null | undefined, linearData = false): Texture | null {
  if (!info) return null;
  const options = { invertY: true, gammaSpace: !linearData };
  let tex: Texture;
  if (info.src) {
    const ktx2 = info.mimeType === "image/ktx2";
    if (ktx2) ensureKtx2Loader();
    tex = new Texture(info.src, scene, { ...options, forcedExtension: ktx2 ? ".ktx2" : undefined });
    // Compressed images can't be flipped on upload: flip them in the texture matrix instead.
    if (ktx2) {
      tex.vScale = -1; // v → 1 - v
      tex.vOffset = 1;
    }
  } else if (info.bytes) {
    const ktx2 = info.mimeType === "image/ktx2";
    if (ktx2) ensureKtx2Loader();
    // A unique name: Babylon caches textures by URL, and every buffer would share one.
    tex = new Texture(`data:myco-model-texture-${++bufferTextures}`, scene, { ...options, buffer: info.bytes, forcedExtension: ktx2 ? ".ktx2" : undefined });
    if (ktx2) {
      tex.vScale = -1;
      tex.vOffset = 1;
    }
  } else if (info.image) tex = new Texture(`data:myco-model-texture-${++bufferTextures}`, scene, { ...options, buffer: info.image as HTMLImageElement });
  else return null;
  if (info.uvSet) tex.coordinatesIndex = info.uvSet;
  return tex;
}

let ktx2Registered: Promise<unknown> | null = null;
/** Babylon's KTX2 texture loader, registered on the first KTX2 texture (glTF KHR_texture_basisu, ADR 0088). */
function ensureKtx2Loader(): void {
  ktx2Registered ??= import("@babylonjs/core/Materials/Textures/Loaders/ktxTextureLoader.js");
}

/** One model surface as a PBR material, shared by every mesh using it (`cache` is the owner's, per scene). */
export function surfaceMaterial(scene: Scene, cache: WeakMap<object, BabylonMaterial>, surface: SurfaceInfo, meshName: string): BabylonMaterial {
  let m = cache.get(surface);
  if (m) return m;
  const made = pbr(`model:${meshName}:${surface.name}`, scene);
  made.albedoColor = new Color3(surface.color[0], surface.color[1], surface.color[2]); // already linear
  made.metallic = surface.metalness;
  made.roughness = surface.roughness;
  made.backFaceCulling = !surface.doubleSided;
  if (surface.doubleSided) made.twoSidedLighting = true;
  made.albedoTexture = surfaceTexture(scene, surface.map);
  if (surface.alphaMode === undefined) {
    if (surface.transparent && surface.opacity < 1) {
      made.alpha = surface.opacity;
      made.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    }
  } else if (surface.alphaMode === "blend") {
    made.alpha = surface.opacity;
    made.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    made.useAlphaFromAlbedoTexture = !!made.albedoTexture;
  } else if (surface.alphaMode === "mask") {
    made.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
    made.alphaCutOff = surface.alphaCutoff ?? 0.5;
    made.useAlphaFromAlbedoTexture = !!made.albedoTexture;
  } else {
    made.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE;
  }
  if (surface.unlit) made.unlit = true;
  if (surface.emissive) made.emissiveColor = new Color3(surface.emissive[0], surface.emissive[1], surface.emissive[2]);
  made.emissiveTexture = surfaceTexture(scene, surface.emissiveMap);
  const normal = surfaceTexture(scene, surface.normalMap, true);
  if (normal) {
    made.bumpTexture = normal;
    normal.level = surface.normalScale ?? 1;
  }
  const metalRough = surfaceTexture(scene, surface.metalRoughMap, true);
  if (metalRough) {
    made.metallicTexture = metalRough;
    made.useRoughnessFromMetallicTextureAlpha = false;
    made.useRoughnessFromMetallicTextureGreen = true;
    made.useMetallnessFromMetallicTextureBlue = true;
  }
  const occlusion = surfaceTexture(scene, surface.occlusionMap, true);
  if (occlusion) {
    made.ambientTexture = occlusion;
    made.useAmbientInGrayScale = true;
    made.ambientTextureStrength = surface.occlusionStrength ?? 1;
  }
  const p = surface.physical;
  if (p) {
    made.clearCoat.isEnabled = p.clearcoat > 0;
    made.clearCoat.intensity = p.clearcoat;
    made.clearCoat.roughness = p.clearcoatRoughness;
    made.sheen.isEnabled = p.sheen > 0;
    made.sheen.intensity = p.sheen;
    made.sheen.color = new Color3(p.sheenColor[0], p.sheenColor[1], p.sheenColor[2]);
    made.sheen.roughness = p.sheenRoughness;
    made.subSurface.isRefractionEnabled = p.transmission > 0;
    made.subSurface.refractionIntensity = p.transmission;
    made.subSurface.maximumThickness = Math.max(p.thickness, 0.001);
    made.indexOfRefraction = p.ior;
    made.metallicF0Factor = p.specularIntensity;
    made.metallicReflectanceColor = new Color3(p.specularColor[0], p.specularColor[1], p.specularColor[2]);
    made.iridescence.isEnabled = p.iridescence > 0;
    made.iridescence.intensity = p.iridescence;
    made.iridescence.indexOfRefraction = p.iridescenceIOR;
  }
  m = made;
  cache.set(surface, m);
  return m;
}

/**
 * A model mesh's materials as Babylon materials: for each of its surfaces, `pick`'s material (a
 * renderer's or the import settings' material asset for that slot, ADR 0089) or the surface's own
 * as a PBR material. A mesh drawing several, one per index group, gets a submesh per group under a
 * `MultiMaterial` (returned in `made` too, for its owner to dispose). A mesh without surfaces asks
 * `pick` for the default slot. Null when nothing applies (the caller draws the default material).
 */
export function modelMaterial(
  scene: Scene,
  cache: WeakMap<object, BabylonMaterial>,
  src: ModelMesh,
  mesh: Mesh,
  pick: (surface: SurfaceInfo) => BabylonMaterial | null = () => null,
  made?: BabylonMaterial[],
): BabylonMaterial | null {
  if (!src.surfaces.length) return pick(DEFAULT_SLOT);
  const one = (i: number) => {
    const surface = src.surfaces[i] ?? src.surfaces[0];
    return pick(surface) ?? surfaceMaterial(scene, cache, surface, src.name);
  };
  const groups = src.data.groups;
  if (src.surfaces.length < 2 || groups.length < 2) return one(0);
  const subs = src.surfaces.map((_, i) => one(i));
  if (subs.every((m) => m === subs[0])) return subs[0]; // one material for every group: the mesh's one submesh does
  const multi = new MultiMaterial(`model:${src.name}`, scene);
  multi.subMaterials = subs;
  made?.push(multi);
  mesh.subMeshes = [];
  const vertices = src.data.positions.length / 3;
  for (const g of groups) new SubMesh(Math.min(g.materialIndex, src.surfaces.length - 1), 0, vertices, g.start, g.count, mesh);
  return multi;
}

/** A Babylon mesh of a model mesh's renderer-neutral geometry (no material yet). */
export function meshOf(scene: Scene, name: string, src: ModelMesh): Mesh {
  const mesh = new Mesh(name, scene);
  vertexDataOf(src).applyToMesh(mesh, false);
  return mesh;
}

/** A lit, unlit or physical material asset's settings (all but its textures) on a PBR material (ADR 0043, 0052). */
export function applyBuiltinSettings(m: PBRMaterial, settings: MaterialSettings): void {
  m.albedoColor = linear(settings.color);
  m.backFaceCulling = !settings.doubleSided;
  m.twoSidedLighting = settings.doubleSided;
  if (settings.color.a < 1) {
    m.alpha = settings.color.a;
    m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  }
  if (settings.shader === "unlit") {
    m.unlit = true;
  } else {
    m.metallic = settings.metalness;
    m.roughness = settings.roughness;
    m.emissiveColor = linear(settings.emission);
  }
  if (settings.shader === "physical") {
    m.clearCoat.isEnabled = settings.clearcoat > 0;
    m.clearCoat.intensity = settings.clearcoat;
    m.clearCoat.roughness = settings.clearcoatRoughness;
    m.sheen.isEnabled = settings.sheen > 0;
    m.sheen.intensity = settings.sheen;
    m.sheen.color = linear(settings.sheenColor);
    m.sheen.roughness = settings.sheenRoughness;
    m.subSurface.isRefractionEnabled = settings.transmission > 0;
    m.subSurface.refractionIntensity = settings.transmission;
    m.subSurface.maximumThickness = Math.max(settings.thickness, 0.001);
    m.indexOfRefraction = settings.ior;
    m.iridescence.isEnabled = settings.iridescence > 0;
    m.iridescence.intensity = settings.iridescence;
    m.iridescence.indexOfRefraction = settings.iridescenceIOR;
    m.anisotropy.isEnabled = settings.anisotropy > 0;
    m.anisotropy.intensity = settings.anisotropy;
    m.anisotropy.angle = (settings.anisotropyRotation * Math.PI) / 180;
    m.metallicF0Factor = settings.specularIntensity;
    m.metallicReflectanceColor = linear(settings.specularColor);
  }
}

/** A texture sharing `shared`'s image with its own tiling (a material's `tiling`); `shared` itself when it's 1×1. */
export function tiledTexture(shared: Texture, tiling: readonly [number, number]): { texture: Texture; owned: boolean } {
  const [tx, ty] = tiling;
  if (tx === 1 && ty === 1) return { texture: shared, owned: false };
  const tex = shared.clone(); // its own tiling; shares the image
  tex.uScale = tx;
  tex.vScale = ty;
  tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return { texture: tex, owned: true };
}

/** An override's colour value (a hex string or an [r, g, b, a] array), or null. */
function overrideColor(v: GraphValue | undefined): EngineColor | null {
  return typeof v === "string" || Array.isArray(v) ? EngineColor.from(v as string) : null;
}

/** `into` set to the sRGB colour `c` in linear space, without allocating. */
function setLinear(into: Color3, c: EngineColor): void {
  into.set(c.r, c.g, c.b).toLinearSpaceToRef(into);
}

/**
 * A renderer's copy of a built-in material set in place (ADR 0049): every property an override can
 * touch back to `base`'s value, then `values`' overrides (all but `texture`). Done in place so the copy
 * (and the meshes drawing it, and its compiled effect) live as long as the renderer: changing an
 * override every frame, as a fade does, only changes uniforms.
 */
export function applyBuiltinOverrides(m: PBRMaterial, base: PBRMaterial, values: Record<string, GraphValue>): void {
  m.albedoColor.copyFrom(base.albedoColor);
  m.alpha = base.alpha;
  m.transparencyMode = base.transparencyMode;
  m.emissiveColor.copyFrom(base.emissiveColor);
  m.metallic = base.metallic;
  m.roughness = base.roughness;
  m.clearCoat.isEnabled = base.clearCoat.isEnabled;
  m.clearCoat.intensity = base.clearCoat.intensity;
  m.clearCoat.roughness = base.clearCoat.roughness;
  m.sheen.isEnabled = base.sheen.isEnabled;
  m.sheen.intensity = base.sheen.intensity;
  m.sheen.roughness = base.sheen.roughness;
  m.sheen.color.copyFrom(base.sheen.color);
  m.subSurface.isRefractionEnabled = base.subSurface.isRefractionEnabled;
  m.subSurface.refractionIntensity = base.subSurface.refractionIntensity;
  m.subSurface.maximumThickness = base.subSurface.maximumThickness;
  m.indexOfRefraction = base.indexOfRefraction;
  m.iridescence.isEnabled = base.iridescence.isEnabled;
  m.iridescence.intensity = base.iridescence.intensity;
  m.iridescence.indexOfRefraction = base.iridescence.indexOfRefraction;
  m.anisotropy.isEnabled = base.anisotropy.isEnabled;
  m.anisotropy.intensity = base.anisotropy.intensity;
  m.anisotropy.angle = base.anisotropy.angle;
  m.metallicF0Factor = base.metallicF0Factor;
  m.metallicReflectanceColor.copyFrom(base.metallicReflectanceColor);

  const color = overrideColor(values.color);
  if (color) {
    setLinear(m.albedoColor, color);
    m.alpha = color.a;
    m.transparencyMode = color.a < 1 ? PBRMaterial.PBRMATERIAL_ALPHABLEND : base.transparencyMode;
  }
  const emission = overrideColor(values.emission);
  if (emission) setLinear(m.emissiveColor, emission);
  const num = (k: string): number | undefined => (typeof values[k] === "number" ? (values[k] as number) : undefined);
  let v: number | undefined;
  if ((v = num("metalness")) !== undefined) m.metallic = v;
  if ((v = num("roughness")) !== undefined) m.roughness = v;
  if ((v = num("clearcoat")) !== undefined) {
    m.clearCoat.isEnabled = v > 0;
    m.clearCoat.intensity = v;
  }
  if ((v = num("clearcoatRoughness")) !== undefined) m.clearCoat.roughness = v;
  if ((v = num("sheen")) !== undefined) {
    m.sheen.isEnabled = v > 0;
    m.sheen.intensity = v;
  }
  if ((v = num("sheenRoughness")) !== undefined) m.sheen.roughness = v;
  const sheenColor = overrideColor(values.sheenColor);
  if (sheenColor) setLinear(m.sheen.color, sheenColor);
  if ((v = num("transmission")) !== undefined) {
    m.subSurface.isRefractionEnabled = v > 0;
    m.subSurface.refractionIntensity = v;
  }
  if ((v = num("thickness")) !== undefined) m.subSurface.maximumThickness = Math.max(v, 0.001);
  if ((v = num("ior")) !== undefined) m.indexOfRefraction = v;
  if ((v = num("iridescence")) !== undefined) {
    m.iridescence.isEnabled = v > 0;
    m.iridescence.intensity = v;
  }
  if ((v = num("iridescenceIOR")) !== undefined) m.iridescence.indexOfRefraction = v;
  if ((v = num("anisotropy")) !== undefined) {
    m.anisotropy.isEnabled = v > 0;
    m.anisotropy.intensity = v;
  }
  if ((v = num("anisotropyRotation")) !== undefined) m.anisotropy.angle = (v * Math.PI) / 180;
  if ((v = num("specularIntensity")) !== undefined) m.metallicF0Factor = v;
  const specular = overrideColor(values.specularColor);
  if (specular) setLinear(m.metallicReflectanceColor, specular);
}
