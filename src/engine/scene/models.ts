/**
 * Model assets (ADR 0044): `.obj` (with its `.mtl`, when there is one) and `.fbx` files, loaded
 * with three.js's loaders behind the asset layer. Internal: game code refers to meshes by path in
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
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color as ThreeColor,
  CylinderGeometry,
  DoubleSide,
  FrontSide,
  LoadingManager,
  Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  SphereGeometry,
  Texture,
  type Side,
} from "three";
import { Assets, normalizeAssetPath, sidecarValue } from "./Assets";
import { splitSpriteRef, type ImportSettings } from "./importSettings";

/** @internal True for a model file the engine imports. */
export const isModelPath = (path: string): boolean => /\.(obj|fbx)$/i.test(splitSpriteRef(path).path);

/** @internal */
export const BUILTIN_PREFIX = "builtin:";
/** @internal The engine's own meshes, by the name after `builtin:`. */
export const BUILTIN_MESHES = ["cube", "sphere", "capsule", "cylinder", "plane", "quad"] as const;
/** @internal */
export type BuiltinMesh = (typeof BUILTIN_MESHES)[number];

/** @internal One mesh of a model, in model space. */
export interface ModelMesh {
  /** Unique within its model; what `#name` refers to. */
  readonly name: string;
  readonly geometry: BufferGeometry;
  /** The model's own materials for this mesh, as the engine's default lit material (one per geometry group). */
  readonly materials: readonly Material[];
}

/** @internal A loaded model. */
export interface ModelData {
  readonly meshes: readonly ModelMesh[];
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
  entry.promise.catch(() => {}); // reported by whoever awaits it, or by `modelIfLoaded`
  cache.set(path, entry);
  if (cached?.data) disposeModel(cached.data);
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

function selectMeshes(data: ModelData, path: string, slice: string | null): readonly ModelMesh[] {
  if (slice === null) return data.meshes;
  const mesh = data.meshes.find((m) => m.name === slice);
  if (!mesh) warnOnce(`${path} has no mesh named "${slice}".`);
  return mesh ? [mesh] : [];
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
    data = { meshes: [{ name, geometry: builtinGeometry(name), materials: [] }] };
    builtins.set(name, data);
  }
  return data.meshes;
}

/** Built-in meshes, Unity's sizes: a 1 m cube and sphere, a 2 m tall capsule and cylinder, a 10 m ground plane, a 1 m quad facing +Z. */
function builtinGeometry(name: BuiltinMesh): BufferGeometry {
  let g: BufferGeometry;
  switch (name) {
    case "cube": g = new BoxGeometry(1, 1, 1); break;
    case "sphere": g = new SphereGeometry(0.5, 32, 16); break;
    case "capsule": g = new CapsuleGeometry(0.5, 1, 8, 24); break;
    case "cylinder": g = new CylinderGeometry(0.5, 0.5, 2, 32); break;
    case "plane": g = new PlaneGeometry(10, 10).rotateX(-Math.PI / 2); break;
    case "quad": g = new PlaneGeometry(1, 1); break;
  }
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
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
    if (candidate && Assets.has(candidate)) return Assets.url(candidate);
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

/** A loading manager that finds a model's textures in the project, and (headless) leaves them blank. */
function manager(modelPath: string): LoadingManager {
  const m = new LoadingManager();
  m.setURLModifier((url) => textureUrl(modelPath, url));
  if (typeof document === "undefined") {
    const blank = { path: "", setPath() { return blank; }, setCrossOrigin() { return blank; }, load: () => new Texture() };
    m.addHandler(/\.(png|jpe?g|gif|webp|bmp|tga|tiff?|dds)$/i, blank as never);
  }
  return m;
}

async function parseModel(path: string, url: string, settings: ImportSettings): Promise<ModelData> {
  const bytes = await fetchBytes(url);
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
  const data = bakeMeshes(root, settings);
  if (!data.meshes.length) warnOnce(`${path} has no meshes.`);
  return data;
}

/** @internal The model's meshes with their place in the file and the import settings baked into copies of their geometry. */
export function bakeMeshes(root: Object3D, settings: Pick<ImportSettings, "scale" | "upAxis" | "normals">): ModelData {
  root.updateMatrixWorld(true);
  const importMatrix = new Matrix4().makeScale(settings.scale, settings.scale, settings.scale);
  if (settings.upAxis === "z") importMatrix.multiply(new Matrix4().makeRotationX(-Math.PI / 2));
  const meshes: ModelMesh[] = [];
  const used = new Set<string>();
  const converted = new Map<Material, Material>();
  const matrix = new Matrix4();
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || !mesh.geometry?.getAttribute("position")) return;
    const geometry = mesh.geometry.clone();
    matrix.multiplyMatrices(importMatrix, mesh.matrixWorld);
    geometry.applyMatrix4(matrix);
    if (matrix.determinant() < 0) flipWinding(geometry);
    if (settings.normals === "calculate" || !geometry.getAttribute("normal")) {
      geometry.deleteAttribute("normal");
      geometry.computeVertexNormals();
    }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const sources = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    const materials = sources.map((m) => {
      let c = converted.get(m);
      if (!c) converted.set(m, (c = standardMaterial(m)));
      return c;
    });
    meshes.push({ name: uniqueName(mesh.name || mesh.parent?.name || "mesh", used), geometry, materials });
  });
  return { meshes };
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
  if (source instanceof MeshStandardMaterial) return source;
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
    mesh.geometry.dispose();
    for (const m of mesh.materials) m.dispose();
  }
}

/**
 * @internal A mesh's triangles for physics: vertex positions (x, y, z per vertex) and three
 * vertex indices per triangle.
 */
export function meshTriangles(mesh: ModelMesh): { vertices: Float32Array; indices: Uint32Array } {
  const pos = mesh.geometry.getAttribute("position");
  const vertices = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    vertices[i * 3] = pos.getX(i);
    vertices[i * 3 + 1] = pos.getY(i);
    vertices[i * 3 + 2] = pos.getZ(i);
  }
  const index = mesh.geometry.getIndex();
  const indices = index ? Uint32Array.from(index.array as ArrayLike<number>) : Uint32Array.from({ length: pos.count - (pos.count % 3) }, (_, i) => i);
  return { vertices, indices };
}

/** @internal Forget every loaded model (tests). */
export function clearModelCache(): void {
  for (const e of cache.values()) if (e.data) disposeModel(e.data);
  cache.clear();
  warned.clear();
}

/** @internal The names of a model's meshes if it has loaded (starting the load if not), else null. */
export function meshNamesIfLoaded(path: string): string[] | null {
  return meshesIfLoaded(splitSpriteRef(normalizeAssetPath(path)).path)?.map((m) => m.name) ?? null;
}
