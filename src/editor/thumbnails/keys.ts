// Asset thumbnails (ADR 0061): which assets get a rendered preview, what each preview depends on,
// and the content key that names its cached file. Pure apart from hashing (WebCrypto), so the
// rules are unit-tested.
import { isSidecarPath, sidecarPath } from "../../engine/scene/importSettings";

/** Bumped when the renderer's look changes, so every cached thumbnail is rendered again. */
export const THUMBNAIL_FORMAT = 1;

/** Assets with a rendered preview (images and sprite slices are shown as they are). */
export type PreviewKind = "model" | "material" | "shadergraph" | "environment" | "sky" | "particles" | "prefab" | "audio";

/** The preview an asset gets, or null for none. */
export function previewKind(path: string): PreviewKind | null {
  const p = path.toLowerCase();
  if (p.includes("#") || isSidecarPath(p)) return null;
  if (/\.(obj|fbx)$/.test(p)) return "model";
  if (p.endsWith(".material.json")) return "material";
  if (p.endsWith(".shadergraph.json")) return "shadergraph";
  if (/\.(hdr|exr|env|dds)$/.test(p) || p.endsWith(".cubemap.json")) return "environment";
  if (p.endsWith(".sky.json")) return "sky";
  if (p.endsWith(".particles.json")) return "particles";
  if (p.endsWith(".prefab.json")) return "prefab";
  if (/\.(mp3|ogg|wav)$/.test(p)) return "audio";
  return null;
}

/** What a dependency walk can read: the project's files and the text of its text files. */
export interface DependencySource {
  readonly files: readonly string[];
  /** A text file's text (JSON, .obj, .mtl), or undefined for binaries and missing files. */
  text(path: string): string | undefined;
}

const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name).replace(/\\/g, "/");

/** Paths named in an asset's JSON: every string that is a project file (with or without `asset:`). */
function jsonReferences(text: string, files: ReadonlySet<string>): string[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      const p = v.replace(/^asset:/, "").split("#")[0];
      if (files.has(p)) out.add(p);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return [...out];
}

/** An .obj's material libraries, and an .mtl's texture maps, relative to the file. */
function wavefrontReferences(path: string, text: string, files: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const folder = folderOf(path);
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(mtllib|map_\w+|bump|disp|norm)\s+(.+?)\s*$/i.exec(line);
    if (!m) continue;
    // Options (`-bm 1 file.png`) come first; the file is the last token.
    const name = m[2].split(/\s+/).pop()!;
    const p = join(folder, name);
    if (files.has(p)) out.push(p);
  }
  return out;
}

/**
 * Every file an asset's preview depends on, besides the asset itself, sorted: textures, shader
 * graphs, models, materials, and import settings sidecars (which change how models and images
 * load). Followed transitively (a prefab's material's texture); cycles are cut.
 */
export function previewDependencies(path: string, source: DependencySource): string[] {
  const files = new Set(source.files);
  const seen = new Set<string>([path]);
  const stack = [path];
  while (stack.length) {
    const p = stack.pop()!;
    const refs: string[] = [];
    const text = source.text(p);
    const lower = p.toLowerCase();
    if (text !== undefined && lower.endsWith(".json")) refs.push(...jsonReferences(text, files));
    else if (text !== undefined && /\.(obj|mtl)$/.test(lower)) refs.push(...wavefrontReferences(p, text, files));
    const sidecar = sidecarPath(p);
    if (files.has(sidecar)) refs.push(sidecar);
    for (const r of refs) {
      if (seen.has(r)) continue;
      seen.add(r);
      stack.push(r);
    }
  }
  seen.delete(path);
  return [...seen].sort();
}

/**
 * A thumbnail's key: the first 20 hex characters of a SHA-256 over the format version, the kind,
 * and the bytes of the asset then its dependencies (in `previewDependencies` order). Paths aren't
 * hashed, so a renamed asset keeps its key, and the same files give the same key on any machine.
 */
export async function contentKey(kind: PreviewKind, asset: Uint8Array, dependencies: readonly Uint8Array[]): Promise<string> {
  const header = new TextEncoder().encode(`myco-thumbnail/${THUMBNAIL_FORMAT}/${kind}`);
  const parts = [header, asset, ...dependencies];
  // Each part is length-prefixed, so ["ab", "c"] and ["a", "bc"] hash differently.
  let total = 0;
  for (const p of parts) total += 4 + p.length;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  let at = 0;
  for (const p of parts) {
    view.setUint32(at, p.length);
    buf.set(p, at + 4);
    at += 4 + p.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...digest.slice(0, 10)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A cache file's key, or null for files that aren't thumbnails (`<20 hex>.<ext>`). */
export function keyOfFile(name: string): string | null {
  const m = /^([0-9a-f]{20})\.(webp|png|peaks\.json)$/.exec(name);
  return m ? m[1] : null;
}
