// A slice's 2D skin as the runtime reads it (ADR 0371 "2D bones"; T21): the slice a reference names
// (`asset:hero.png#torso`), its `skin` from the image's sidecar, and the frame its pixels sit in (pivot and pixels per
// unit: the sidecar's, else the project's). The Skeleton2D's skeleton (`../sprites2d.ts`) and the skinned sprite draw
// (`skinnedSprites.ts`) both resolve skins here, so they agree on units.
import type { SliceSkin } from "../../../../../engine/animation/sprites/sidecar";
import { sliceFrame, type SliceFrame } from "../../../../../engine/animation/sprites/skeleton2d";
import { Assets } from "../../../../../engine/scene/Assets";
import { findSlice, splitSpriteRef, type SpriteSlice } from "../../../../../engine/scene/importSettings";

/** @internal A slice with a skin. */
export interface SliceSkinSource {
  readonly imagePath: string;
  readonly slice: SpriteSlice;
  readonly skin: SliceSkin;
  readonly frame: SliceFrame;
}

/** @internal The skin of the slice `ref` names, or null (no slice, or a slice without a skin). `projectPpu`: the project's pixels per unit. */
export function sliceSkin(ref: string, projectPpu: number): SliceSkinSource | null {
  const { path, slice: name } = splitSpriteRef(ref);
  if (!path || name === null) return null;
  const settings = Assets.importSettings(path);
  const slice = findSlice(settings, name);
  if (!slice?.skin) return null;
  return { imagePath: path, slice, skin: slice.skin, frame: sliceFrame(slice, settings.pixelsPerUnit, projectPpu) };
}
