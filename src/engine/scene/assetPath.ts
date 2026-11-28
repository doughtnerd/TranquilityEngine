/**
 * How an asset reference string names a project path (ADR 0013, 0459): the one rule.
 *
 * A reference names a project path, written bare or with an `asset:` prefix and a leading `./` or `/`, all optional,
 * and may end in a `#sub-asset` (a sprite slice `images/sheet.png#walk_0`, ADR 0040; a model's clip
 * `models/hero.glb#Anim/Run`, ADR 0371): `images/a.png`, `asset:images/a.png`, `asset:./images/a.png` and
 * `/images/a.png` all name `images/a.png`. Everything that turns a reference into a path goes through here; the editor's
 * reference parsing (`assetRefValues.ts`) builds on `assetRefPrefix`.
 *
 * Pure: no imports, so any module (the asset store, import settings, the animation compiler) can use it.
 */

const PREFIX = /^(?:asset:)?(?:\.?\/)?/;
const SCHEME = "asset:";

/** The prefix a reference was written with: `asset:`, `./`, `/`, `asset:./`, `asset:/` or "" (`asset:./a.png` → `asset:./`). */
export const assetRefPrefix = (ref: string): string => PREFIX.exec(ref)![0];

/**
 * The project path a reference names, its `#sub-asset` kept: without `asset:` or a leading `./` or `/`
 * (`asset:./images/a.png#walk` → `images/a.png#walk`).
 */
export function normalizeAssetPath(ref: string): string {
  return ref.slice(assetRefPrefix(ref).length);
}

/**
 * A reference without its `asset:` scheme only, a leading `./` or `/` kept: for paths a document resolves against its
 * own folder, where `./x` and `/x` (the project root) differ (UI documents, `resolvePath` in `ui/document/sourceText.ts`).
 * Anything that wants the project path uses `normalizeAssetPath`.
 */
export const withoutAssetScheme = (ref: string): string => (ref.startsWith(SCHEME) ? ref.slice(SCHEME.length) : ref);
