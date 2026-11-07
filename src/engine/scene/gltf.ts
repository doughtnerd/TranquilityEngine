/**
 * glTF 2.0 models (ADR 0088): `.gltf` (embedded or external buffers and images) and `.glb`, parsed
 * with three.js's `GLTFLoader` behind the asset layer and baked like OBJ and FBX models
 * (`models.ts`). Internal: nothing here reaches the public API.
 *
 * What differs from three's own loading:
 * - **Files come from the project.** External buffers and images are found among the project's
 *   assets relative to the `.gltf` (the editor serves assets as blob URLs, which relative URLs can't
 *   resolve against), and `file:` URLs are read from disk headless.
 * - **Images aren't decoded here.** Each texture keeps its image's URL (a project asset or a `data:`
 *   URI) or, for an image stored in a buffer, its bytes, and its MIME type; the renderer decodes it. So parsing works headless and costs no image decode before the first frame.
 * - **Draco** (`KHR_draco_mesh_compression`) decodes in-thread with Google's pure-JavaScript decoder
 *   (`vendor/draco_decoder.js`, loaded only for a Draco file), so it also works headless where workers
 *   and wasm paths don't. **meshopt** (`EXT_meshopt_compression`) uses three's bundled decoder.
 * - **Primitives of one mesh merge** into one geometry with a group per primitive, so a glTF mesh
 *   is one engine mesh with a material slot per primitive (ADR 0089).
 *
 * Ignored (for the animation design to pick up, ADR 0088): skins (skinned meshes bake in their bind
 * pose), animations, morph targets (the base shape is used), cameras, lights, and scenes other than
 * the default one.
 */
// Types only: three.js is imported with the first glTF parse (`parseGltf`), never at start-up
// (ADR 0082, 0088). The helpers below take three's classes from `lib()`.
import type { BufferGeometry, Group, Material, Mesh, Object3D, Texture, Wrapping } from "three";
import { Assets } from "./Assets";

/** What a texture's image is, kept on its three.js texture (`userData.mycoSource`) for the bake. */
export interface GltfImageSource {
  /** A URL the renderer can load (a project asset's URL or a `data:` URI), or null for `bytes`. */
  readonly src: string | null;
  /** The image's bytes, for an image stored in a buffer (GLB). */
  readonly bytes?: Uint8Array;
  /** The project path of an image that's a project file. */
  readonly path?: string;
  /** `image/png`, `image/jpeg`, `image/webp`, `image/ktx2`… when known. */
  readonly mimeType: string | null;
}

/** The parse's result: the default scene and what it couldn't keep. */
export interface GltfResult {
  readonly root: Object3D;
  /** One line per kind of data that was ignored (skins, animations…), for one warning. */
  readonly ignored: string[];
}

/** How the parse finds files: a project path's URL, or null when the project lacks it. */
export interface GltfFiles {
  /** The project path of a file the glTF names (relative to it), or null when the project lacks it. */
  resolve(uri: string): string | null;
  /** A project path's URL. */
  url(path: string): string;
  fetch(url: string): Promise<ArrayBuffer>;
  warn(message: string): void;
}

let three: typeof import("three") | null = null;
/** three.js, once `parseGltf` has loaded it. */
function lib(): typeof import("three") {
  if (!three) throw new Error("three.js isn't loaded: glTF files are parsed through parseGltf.");
  return three;
}

/** glTF sampler wrap modes as three.js's (same numbers: three uses WebGL's), without loading three.js. */
const WRAPS: Record<number, Wrapping> = { 33071: 1001 as Wrapping, 33648: 1002 as Wrapping, 10497: 1000 as Wrapping };
const REPEAT = 1000 as Wrapping;

interface GltfJson {
  textures?: { source?: number; sampler?: number; name?: string; extensions?: Record<string, { source?: number }> }[];
  images?: { uri?: string; bufferView?: number; mimeType?: string; name?: string }[];
  samplers?: { wrapS?: number; wrapT?: number }[];
  buffers?: { uri?: string; byteLength: number }[];
  skins?: unknown[];
  animations?: unknown[];
  cameras?: unknown[];
  scenes?: unknown[];
  meshes?: { primitives: { targets?: unknown[] }[] }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}

/** The minimum of three's GLTFParser this module reaches into. */
interface Parser {
  json: GltfJson;
  associations: Map<object, { meshes?: number; primitives?: number; textures?: number }>;
  getDependency(type: "bufferView", index: number): Promise<ArrayBuffer>;
  loadBuffer(index: number): Promise<ArrayBuffer>;
}

/** Extensions the engine reads (three's loader handles them; listed so a file requiring another one is refused clearly). */
const SUPPORTED_EXTENSIONS = new Set([
  "KHR_materials_emissive_strength",
  "KHR_materials_clearcoat",
  "KHR_materials_sheen",
  "KHR_materials_transmission",
  "KHR_materials_volume",
  "KHR_materials_ior",
  "KHR_materials_specular",
  "KHR_materials_iridescence",
  "KHR_materials_unlit",
  "KHR_texture_transform",
  "KHR_mesh_quantization",
  "KHR_draco_mesh_compression",
  "EXT_meshopt_compression",
  "EXT_mesh_gpu_instancing",
  "KHR_texture_basisu",
  "EXT_texture_webp",
  "EXT_texture_avif",
  "KHR_lights_punctual",
  "KHR_materials_variants",
]);

/** Parse a `.gltf` (JSON) or `.glb` file's bytes into three.js objects (internal to the model bake). */
export async function parseGltf(bytes: ArrayBuffer, files: GltfFiles): Promise<GltfResult> {
  three ??= await import("three");
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  const loader = new GLTFLoader();
  const json = readJson(bytes);
  const used = new Set([...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])]);
  for (const ext of json.extensionsRequired ?? []) {
    if (!SUPPORTED_EXTENSIONS.has(ext)) throw new Error(`it requires the glTF extension ${ext}, which the engine doesn't support`);
  }
  if (used.has("EXT_meshopt_compression")) {
    const { MeshoptDecoder } = await import("three/examples/jsm/libs/meshopt_decoder.module.js");
    loader.setMeshoptDecoder(MeshoptDecoder);
  }
  if (used.has("KHR_draco_mesh_compression")) loader.setDRACOLoader(dracoDecoder() as never);
  // Ahead of three's own plugins, so no image is decoded (and KTX2, WebP and AVIF go to the renderer as they are).
  const pluginCallbacks = (loader as unknown as { pluginCallbacks: ((parser: Parser) => { name: string })[] }).pluginCallbacks;
  pluginCallbacks.unshift((parser) => sourcePlugin(parser, files));

  const gltf = await new Promise<{ scene: Object3D; parser: Parser }>((resolve, reject) => {
    loader.parse(bytes, "", (g) => resolve(g as never), (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
  mergePrimitives(gltf.scene, gltf.parser);
  markMaterials(gltf.scene);
  return { root: gltf.scene, ignored: ignoredData(json) };
}

/** The glTF JSON of a `.gltf` or `.glb` file (for the checks made before three parses it). */
function readJson(bytes: ArrayBuffer): GltfJson {
  const view = new DataView(bytes);
  try {
    if (bytes.byteLength >= 20 && view.getUint32(0, true) === 0x46546c67) {
      // GLB: header (12 bytes), then the JSON chunk.
      const length = view.getUint32(12, true);
      return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length))) as GltfJson;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as GltfJson;
  } catch {
    throw new Error("it isn't a glTF file (neither glTF JSON nor a GLB container)");
  }
}

/** What the engine doesn't import yet (said once per model). */
function ignoredData(json: GltfJson): string[] {
  const out: string[] = [];
  const n = (a: unknown[] | undefined) => a?.length ?? 0;
  if (n(json.skins)) out.push(`${n(json.skins)} skin(s) (skinned meshes show their bind pose)`);
  if (n(json.animations)) out.push(`${n(json.animations)} animation(s)`);
  if (json.meshes?.some((m) => m.primitives.some((p) => p.targets?.length))) out.push("morph targets (the base shape is used)");
  if (n(json.cameras)) out.push(`${n(json.cameras)} camera(s)`);
  if (json.extensionsUsed?.includes("KHR_lights_punctual")) out.push("lights");
  if (n(json.scenes) > 1) out.push(`${n(json.scenes) - 1} scene(s) besides the default one`);
  return out;
}

/**
 * A GLTFLoader plugin (and patches on its parser) that reads external buffers through the project
 * and turns every texture into a blank three.js texture carrying its image's URL, never decoding it.
 */
function sourcePlugin(parser: Parser, files: GltfFiles): { name: string; loadTexture(index: number): Promise<Texture> | null } {
  const loadBuffer = parser.loadBuffer.bind(parser);
  parser.loadBuffer = async (index) => {
    const def = parser.json.buffers?.[index];
    if (!def || def.uri === undefined) return loadBuffer(index); // the GLB's own binary chunk
    const path = def.uri.startsWith("data:") ? null : files.resolve(def.uri);
    const url = def.uri.startsWith("data:") ? def.uri : path && files.url(path);
    if (!url) throw new Error(`its buffer "${def.uri}" isn't in the project`);
    return files.fetch(url);
  };
  const cache = new Map<string, Promise<Texture>>();
  return {
    name: "MYCO_texture_source",
    loadTexture(index) {
      const json = parser.json;
      const def = json.textures?.[index];
      if (!def) return null;
      const ext = def.extensions ?? {};
      const source = ext.KHR_texture_basisu?.source ?? ext.EXT_texture_webp?.source ?? ext.EXT_texture_avif?.source ?? def.source;
      const image = source === undefined ? undefined : json.images?.[source];
      if (!image) return null;
      const key = `${source}:${def.sampler}`;
      let promise = cache.get(key);
      if (!promise) {
        promise = imageSource(parser, image, files).then((src) => {
          const texture = new (lib().Texture)();
          texture.name = def.name || image.name || "";
          texture.flipY = false;
          const sampler = json.samplers?.[def.sampler ?? -1] ?? {};
          texture.wrapS = WRAPS[sampler.wrapS ?? 10497] ?? REPEAT;
          texture.wrapT = WRAPS[sampler.wrapT ?? 10497] ?? REPEAT;
          texture.userData.mycoSource = src satisfies GltfImageSource | null;
          parser.associations.set(texture, { textures: index });
          return texture;
        });
        cache.set(key, promise);
      }
      return promise;
    },
  };
}

const EXTENSION_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", ktx2: "image/ktx2", avif: "image/avif", gif: "image/gif" };

async function imageSource(parser: Parser, image: NonNullable<GltfJson["images"]>[number], files: GltfFiles): Promise<GltfImageSource | null> {
  if (image.bufferView !== undefined) {
    const bytes = new Uint8Array(await parser.getDependency("bufferView", image.bufferView));
    return { src: null, bytes, mimeType: image.mimeType ?? null };
  }
  const uri = image.uri;
  if (!uri) return null;
  if (uri.startsWith("data:")) return { src: uri, mimeType: image.mimeType ?? /^data:([^;,]+)/.exec(uri)?.[1] ?? null };
  const path = files.resolve(uri);
  const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(uri)?.[1]?.toLowerCase() ?? "";
  if (!path) {
    files.warn(`its texture "${uri}" isn't in the project; it draws white.`);
    return null;
  }
  return { src: files.url(path), path, mimeType: image.mimeType ?? EXTENSION_TYPES[ext] ?? null };
}

/** Each multi-primitive glTF mesh (a Group of Meshes in three) as one Mesh with a geometry group per primitive. */
function mergePrimitives(root: Object3D, parser: Parser): void {
  const groups: Group[] = [];
  root.traverse((o) => {
    const a = parser.associations.get(o);
    if ((o as Group).isGroup && a?.meshes !== undefined && a.primitives === undefined) groups.push(o as Group);
  });
  for (const group of groups) {
    const parts = group.children.filter((c): c is Mesh => (c as Mesh).isMesh && !(c as { isSkinnedMesh?: boolean }).isSkinnedMesh && !(c as { isInstancedMesh?: boolean }).isInstancedMesh && parser.associations.get(c)?.primitives !== undefined);
    if (parts.length < 2) continue;
    const merged = mergeGeometries(parts.map((p) => p.geometry));
    if (!merged) continue; // primitives with different attributes stay separate meshes
    const mesh = new (lib().Mesh)(merged, parts.map((p) => p.material as Material));
    mesh.name = group.name || parts[0].name;
    for (const p of parts) {
      group.remove(p);
      p.geometry.dispose();
    }
    group.add(mesh);
    // A Group holding only the merged mesh: the mesh takes the node's place (and name).
    if (group.children.length === 1 && group.parent) {
      mesh.position.copy(group.position);
      mesh.quaternion.copy(group.quaternion);
      mesh.scale.copy(group.scale);
      const parent = group.parent;
      const at = parent.children.indexOf(group);
      parent.remove(group);
      parent.children.splice(at, 0, mesh);
      mesh.parent = parent;
    }
  }
}

/**
 * Primitives' geometries as one, with a group per primitive (material index = primitive index).
 * Null if their attributes differ. Indices become 32-bit; non-indexed primitives get indices.
 */
export function mergeGeometries(geometries: readonly BufferGeometry[]): BufferGeometry | null {
  const names = Object.keys(geometries[0].attributes).sort();
  for (const g of geometries) {
    const own = Object.keys(g.attributes).sort();
    if (own.length !== names.length || own.some((n, i) => n !== names[i])) return null;
    for (const n of names) if (g.getAttribute(n).itemSize !== geometries[0].getAttribute(n).itemSize) return null;
  }
  const { BufferAttribute, BufferGeometry } = lib();
  const out = new BufferGeometry();
  let vertexCount = 0;
  let indexCount = 0;
  for (const g of geometries) {
    vertexCount += g.getAttribute("position").count;
    indexCount += g.index ? g.index.count : g.getAttribute("position").count;
  }
  for (const name of names) {
    const first = geometries[0].getAttribute(name);
    const size = first.itemSize;
    const array = new Float32Array(vertexCount * size);
    let at = 0;
    for (const g of geometries) {
      const attr = g.getAttribute(name);
      for (let i = 0; i < attr.count; i++, at++) for (let k = 0; k < size; k++) array[at * size + k] = attr.getComponent(i, k);
    }
    out.setAttribute(name, new BufferAttribute(array, size)); // normalized values read as floats above
  }
  const index = new Uint32Array(indexCount);
  let base = 0;
  let start = 0;
  geometries.forEach((g, materialIndex) => {
    const count = g.index ? g.index.count : g.getAttribute("position").count;
    for (let i = 0; i < count; i++) index[start + i] = base + (g.index ? g.index.getX(i) : i);
    out.addGroup(start, count, materialIndex);
    start += count;
    base += g.getAttribute("position").count;
  });
  out.setIndex(new BufferAttribute(index, 1));
  return out;
}

/**
 * Mark glTF materials for the bake: each has an explicit alpha mode (`mycoGltf`), and
 * `KHR_materials_unlit` ones (MeshBasicMaterial) stay unlit (`mycoUnlit`).
 */
function markMaterials(root: Object3D): void {
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      m.userData.mycoGltf = true;
      if ((m as Material & { isMeshBasicMaterial?: boolean }).isMeshBasicMaterial) m.userData.mycoUnlit = true;
    }
  });
}

// --- Draco -----------------------------------------------------------------------------------------

type DracoModule = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let draco: Promise<DracoModule> | null = null;

/** Google's Draco decoder (pure JavaScript, no wasm file to serve), loaded once, on the first Draco file. */
function dracoModule(): Promise<DracoModule> {
  if (draco) return draco;
  const loading = (async () => {
    const factory = (await import("./vendor/draco_decoder.js")).default as unknown as (config: object) => unknown;
    // The module is promise-like itself, so it's resolved wrapped.
    const wrapped = await new Promise<{ m: DracoModule }>((resolve) => {
      factory({ onModuleLoaded: (m: DracoModule) => resolve({ m }) });
    });
    return wrapped.m;
  })();
  draco = loading;
  loading.catch(() => {
    if (draco === loading) draco = null;
  });
  return loading;
}

const TYPED: Record<string, { array: new (n: number) => ArrayLike<number> & { buffer: ArrayBufferLike }; draco: string }> = {
  Float32Array: { array: Float32Array, draco: "DT_FLOAT32" },
  Int8Array: { array: Int8Array, draco: "DT_INT8" },
  Int16Array: { array: Int16Array, draco: "DT_INT16" },
  Int32Array: { array: Int32Array, draco: "DT_INT32" },
  Uint8Array: { array: Uint8Array, draco: "DT_UINT8" },
  Uint16Array: { array: Uint16Array, draco: "DT_UINT16" },
  Uint32Array: { array: Uint32Array, draco: "DT_UINT32" },
};

/** What GLTFLoader asks of a DRACOLoader, done in-thread. */
function dracoDecoder() {
  return {
    preload() {
      return this;
    },
    decodeDracoFile(buffer: ArrayBuffer, done: (g: BufferGeometry) => void, attributeIds: Record<string, number>, attributeTypes: Record<string, string>, _colorSpace: unknown, fail: (e: unknown) => void) {
      dracoModule()
        .then((d) => done(decodeDraco(d, new Int8Array(buffer), attributeIds, attributeTypes)))
        .catch(fail);
    },
  };
}

function decodeDraco(d: DracoModule, array: Int8Array, attributeIds: Record<string, number>, attributeTypes: Record<string, string>): BufferGeometry {
  const decoder = new d.Decoder();
  const mesh = new d.Mesh();
  try {
    if (decoder.GetEncodedGeometryType(array) !== d.TRIANGULAR_MESH) throw new Error("a Draco primitive isn't a triangle mesh");
    const status = decoder.DecodeArrayToMesh(array, array.byteLength, mesh);
    if (!status.ok() || mesh.ptr === 0) throw new Error(`Draco decoding failed: ${status.error_msg()}`);
    const { BufferAttribute, BufferGeometry } = lib();
    const geometry = new BufferGeometry();
    const count = mesh.num_points();
    for (const [name, id] of Object.entries(attributeIds)) {
      const type = TYPED[attributeTypes[name]] ?? TYPED.Float32Array;
      const attribute = decoder.GetAttributeByUniqueId(mesh, id);
      const size = attribute.num_components();
      const n = count * size;
      const bytes = n * (type.array as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT;
      const ptr = d._malloc(bytes);
      decoder.GetAttributeDataArrayForAllPoints(mesh, attribute, d[type.draco], bytes, ptr);
      const view = new (type.array as unknown as new (b: ArrayBufferLike, o: number, n: number) => ArrayLike<number> & { slice(): ArrayLike<number> })(d.HEAPF32.buffer, ptr, n);
      geometry.setAttribute(name, new BufferAttribute(view.slice() as unknown as Float32Array, size));
      d._free(ptr);
    }
    const faces = mesh.num_faces();
    const ptr = d._malloc(faces * 12);
    decoder.GetTrianglesUInt32Array(mesh, faces * 12, ptr);
    geometry.setIndex(new BufferAttribute(new Uint32Array(d.HEAPF32.buffer, ptr, faces * 3).slice(), 1));
    d._free(ptr);
    return geometry;
  } finally {
    d.destroy(mesh);
    d.destroy(decoder);
  }
}

/** The project files a glTF at `modelPath` names (buffers, images), resolved like the other model formats' textures. */
export function projectFiles(modelPath: string, fetchBytes: (url: string) => Promise<ArrayBuffer>, warn: (m: string) => void): GltfFiles {
  const folder = modelPath.includes("/") ? modelPath.slice(0, modelPath.lastIndexOf("/") + 1) : "";
  return {
    resolve(uri) {
      let name: string;
      try {
        name = decodeURIComponent(uri);
      } catch {
        name = uri;
      }
      name = name.replace(/\\/g, "/").replace(/^\.\//, "");
      const parts = (folder + name).split("/");
      const out: string[] = [];
      for (const p of parts) {
        if (p === "..") out.pop();
        else if (p !== "." && p !== "") out.push(p);
      }
      const candidate = out.join("/");
      return Assets.has(candidate) ? candidate : null;
    },
    url: (path) => Assets.url(path),
    fetch: fetchBytes,
    warn: (m) => warn(`${modelPath}: ${m}`),
  };
}
