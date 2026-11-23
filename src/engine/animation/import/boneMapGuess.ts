/**
 * Guessing a model's bone map on import (ADR 0371 "Model import": `boneMap` "auto-filled by name heuristics on
 * import"). The heuristics are the animation core's (`guess_bone_map`, Rust, T41g), which the engine can't import: the
 * Animation plugin's runtime half installs a guesser here when it activates (in the editor, games and Node alike), and
 * the model import asks it for any skeleton whose sidecar has no `boneMap`. Without a guesser (the plugin is off), or
 * where the core can't run (no `simd128`), the bone map stays empty and the import says so once per model.
 *
 * Internal: not public API.
 */
import type { SkeletonProfile } from "../skeletonProfile";

/**
 * @internal Guesses `profile`'s role → bone name map (null: the built-in Humanoid) for the skeleton in `skeleton`
 * (`myco.skel@1` bytes), whose bones are named `bones` (in its order). Resolves to null when the core can't run here;
 * never rejects.
 */
export type BoneMapGuesser = (skeleton: Uint8Array, bones: readonly string[], profile: SkeletonProfile | null) => Promise<Record<string, string> | null>;

let installed: BoneMapGuesser | null = null;

/** @internal Installs the guesser (the Animation plugin's runtime half, on activation); null removes it. */
export function setBoneMapGuesser(guesser: BoneMapGuesser | null): void {
  installed = guesser;
}

/** @internal The installed guesser, or null. */
export const boneMapGuesser = (): BoneMapGuesser | null => installed;
