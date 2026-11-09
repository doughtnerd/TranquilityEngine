// The files a model names in its own format (ADR 0148), contributed through the Meshes plugin's
// asset kinds as their `references`: an .obj's material libraries, an .mtl's texture maps and a
// .gltf's external buffers and images (ADR 0088). Paths are resolved against the file's folder;
// the asset reference module keeps the ones that are project files.
import type { AssetReferenceExtractor } from "../../../editor/sdk";

const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name).replace(/\\/g, "/");

/** An .obj's material libraries (`mtllib`) and an .mtl's texture maps (`map_Kd`, `bump`…), relative to the file. */
export function wavefrontReferences(path: string, text: string): string[] {
  const out: string[] = [];
  const folder = folderOf(path);
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(mtllib|map_\w+|bump|disp|norm)\s+(.+?)\s*$/i.exec(line);
    if (!m) continue;
    // Options (`-bm 1 file.png`) come first; the file is the last token.
    out.push(join(folder, m[2].split(/\s+/).pop()!.replace(/^\.\//, "")));
  }
  return out;
}

/** A .gltf's external buffers and images (not `data:` URIs), relative to the file. A .glb or .fbx names nothing readable as text. */
export function gltfReferences(path: string, text: string): string[] {
  if (!path.toLowerCase().endsWith(".gltf")) return [];
  let json: { buffers?: { uri?: unknown }[]; images?: { uri?: unknown }[] };
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const folder = folderOf(path);
  const out: string[] = [];
  for (const item of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (typeof item?.uri !== "string" || item.uri.startsWith("data:")) continue;
    let name = item.uri;
    try {
      name = decodeURIComponent(name);
    } catch {
      // kept as written
    }
    out.push(join(folder, name.replace(/^\.\//, "")));
  }
  return out;
}

/** The `model` kind's extractor: Wavefront for .obj, glTF for .gltf (binary .glb and .fbx aren't read). */
export const modelReferences: AssetReferenceExtractor = {
  extensions: [".obj", ".gltf"],
  read: (path, text) => (path.toLowerCase().endsWith(".obj") ? wavefrontReferences(path, text) : gltfReferences(path, text)),
};

/** The `mtl` kind's extractor: an .mtl's texture maps. */
export const materialLibraryReferences: AssetReferenceExtractor = { read: wavefrontReferences };
