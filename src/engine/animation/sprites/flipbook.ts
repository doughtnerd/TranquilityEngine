/**
 * Flipbooks (ADR 0371 "Sprites and 2D"): an image sidecar's `flipbooks.<name>` is a clip `image.png#Flip/<name>`, one
 * `discrete` track writing `engine.SpriteRenderer` `sprite` on the Animator's own node: slice `i` from `i / fps`
 * seconds, for `slices.length / fps` seconds, looping as the flipbook says. The image's sub-assets follow the model's
 * (`model.glb#Anim/<name>`, `scene/models.ts`): a sub-asset name says what field kinds it satisfies, an image lists its
 * flipbooks, and a reference resolves to the flipbook's clip.
 *
 * Internal: not public API.
 */
import { Assets, normalizeAssetPath } from "../../scene/Assets";
import { splitSpriteRef, type ImportSettings } from "../../scene/importSettings";
import type { Track } from "../tracks";
import type { SpriteFlipbook } from "./sidecar";

/** @internal The prefix of an image's flipbook clips (`hero.png#Flip/Run`). */
export const FLIP_SUB_ASSET_PREFIX = "Flip/";

/** @internal A flipbook as a clip: its timing and one discrete track (the raw clip writer's input). */
export interface FlipbookClip {
  readonly name: string;
  /** Samples per second: the flipbook's fps. */
  readonly rate: number;
  readonly duration: number;
  readonly loop: boolean;
  readonly tracks: readonly Track[];
}

/** @internal The clip of flipbook `name` of the image at `imagePath`. */
export function flipbookClip(imagePath: string, name: string, flipbook: SpriteFlipbook): FlipbookClip {
  const fps = flipbook.fps;
  const keys = flipbook.slices.map((slice, i) => [i / fps, `asset:${imagePath}#${slice}`] as const);
  return {
    name,
    rate: fps,
    duration: flipbook.slices.length / fps,
    loop: flipbook.loop,
    tracks: keys.length ? [{ kind: "discrete", target: { nodePath: "", component: "engine.SpriteRenderer", field: "sprite" }, valueType: "asset", keys }] : [],
  };
}

/** @internal The field kinds an image sub-asset satisfies by its name: `Flip/…` an `animclip` field; anything else is a slice. */
export function imageSubAssetKinds(sub: string): readonly string[] {
  return sub.startsWith(FLIP_SUB_ASSET_PREFIX) && sub.length > FLIP_SUB_ASSET_PREFIX.length ? ["animclip"] : ["sprite"];
}

/** @internal An image's flipbook sub-assets (`Flip/<name>` per flipbook). */
export function imageSubAssets(settings: Pick<ImportSettings, "flipbooks">): string[] {
  return Object.keys(settings.flipbooks).map((n) => `${FLIP_SUB_ASSET_PREFIX}${n}`);
}

/** @internal Whether `ref` names an image's flipbook (`…#Flip/<name>`), whatever its sidecar holds. */
export function isFlipbookRef(ref: string): boolean {
  const { slice } = splitSpriteRef(ref);
  return slice !== null && slice.startsWith(FLIP_SUB_ASSET_PREFIX) && slice.length > FLIP_SUB_ASSET_PREFIX.length;
}

/**
 * @internal The flipbook a reference names (`asset:hero.png#Flip/Run`) from the image's sidecar as it is now, or null
 * when it isn't a flipbook reference or the sidecar has no such flipbook.
 */
export function resolveFlipbook(ref: string): { readonly imagePath: string; readonly name: string; readonly flipbook: SpriteFlipbook } | null {
  if (!isFlipbookRef(ref)) return null;
  const { path, slice } = splitSpriteRef(normalizeAssetPath(ref));
  const name = slice!.slice(FLIP_SUB_ASSET_PREFIX.length);
  const flipbook = Assets.importSettings(path).flipbooks[name];
  return flipbook ? { imagePath: path, name, flipbook } : null;
}

/** @internal What an image sub-asset reference resolves to (ADR 0371), as `loadModelSubAsset` for models: a flipbook's clip. */
export type ImageSubAsset = { readonly kind: "clip"; readonly clip: FlipbookClip };

/** @internal The clip an image sub-asset reference names (`asset:hero.png#Flip/Run`), or null when the image has no such sub-asset. */
export function imageSubAsset(ref: string): ImageSubAsset | null {
  const f = resolveFlipbook(ref);
  return f ? { kind: "clip", clip: flipbookClip(f.imagePath, f.name, f.flipbook) } : null;
}
