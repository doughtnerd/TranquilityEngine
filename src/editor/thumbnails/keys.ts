// Asset thumbnails (ADR 0061): which assets get a rendered preview, what each preview depends on
// (an asset's dependencies from the asset reference module, ADR 0148, followed transitively, plus
// import settings sidecars), and the content key that names its cached file. Pure apart from
// hashing (WebCrypto), so the rules are unit-tested.
import { previewOf, type PreviewKind } from "../assetKindLookup";
import { sidecarPath } from "../../engine/scene/importSettings";
import { assetDependencies, type ReferenceSource } from "../assetReferences";

export type { PreviewKind };

/** Bumped when the renderer's look changes, so every cached thumbnail is rendered again. */
export const THUMBNAIL_FORMAT = 2;

/** The preview an asset gets, or null for none: its kind's `preview` (ADR 0133, 0143). Images and sprite slices are shown as they are. */
export const previewKind = (path: string): PreviewKind | null => previewOf(path);

/** What a dependency walk can read: the project's files and the text of its text files. */
export type DependencySource = ReferenceSource;

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
    const refs = assetDependencies(source, p);
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
