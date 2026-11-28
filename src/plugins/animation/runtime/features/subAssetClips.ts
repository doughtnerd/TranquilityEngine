// Clips no file holds, made on the host from their reference (ADR 0371): an image's flipbook `image.png#Flip/<name>`
// (T21) is its sidecar's `flipbooks.<name>` written as a raw `myco.anim@1` clip (`compileRawClip`). An Animator's
// clip loading (`instances.ts` `clipEntry`) asks here before fetching a file. The key names the clip and what it was
// made from, so a sidecar edit makes a new clip rather than reusing the old one.
import { flipbookClip, isFlipbookRef, resolveFlipbook } from "../../../../engine/animation/sprites/flipbook";
import { normalizeAssetPath } from "../../../../engine/scene/Assets";
import { compileRawClip } from "../../../../engine/animation/compile/rawClip";

/** @internal A clip made from its reference: the asset key it loads under, and its bytes. */
export interface SubAssetClip {
  readonly key: string;
  readonly bytes: Uint8Array;
}

/**
 * @internal The clip `path` names when no file holds it (an image's flipbook): `undefined` when `path` isn't such a
 * reference (load the file), null when it is one but names nothing (no such flipbook).
 */
export function subAssetClip(path: string): SubAssetClip | null | undefined {
  if (!isFlipbookRef(path)) return undefined;
  const f = resolveFlipbook(path);
  if (!f) return null;
  const clip = flipbookClip(f.imagePath, f.name, f.flipbook);
  return { key: `flipbook:${normalizeAssetPath(path)}:${JSON.stringify(f.flipbook)}`, bytes: compileRawClip(clip, null).bytes };
}
