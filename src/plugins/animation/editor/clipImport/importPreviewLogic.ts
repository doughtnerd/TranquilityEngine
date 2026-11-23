// What the clip import card's preview plays (ADR 0373 "Clip import settings", T18b): the selected clip as the draft cuts it,
// before Apply. `clipsFromTakes` (the importer's own cut, `engine/animation/import/clips.ts`) turns the draft's settings
// into the clip's authored source: the take cut to its `from`..`to` range and shifted to start at 0, with the loop flag, the
// root motion (bone, axes, bake into pose), markers and events as the draft has them. The runtime plays that source as it
// plays any authored clip, so the preview shows the split range, loops with the playhead, and takes root motion the way the
// game will: out of the pose (the preview's Animator uses none-mode root motion, so the character stays in place).
import type { AnimSource } from "../../../../engine/animation/animSource";
import type { ImportedTake } from "../../../../engine/animation/import/channels";
import { clipsFromTakes, type ModelAnimationSettings } from "../../../../engine/animation/import/clips";
import { clipsOfTake } from "./clipImportLogic";

/**
 * The draft's clip `name` of take `take`, as its authored source, or null when the draft has no such clip (a take or clip
 * that was removed, or a take the model doesn't have). Pure: reads only its arguments.
 */
export function draftClipSource(takes: readonly ImportedTake[], settings: ModelAnimationSettings, take: string, name: string): AnimSource | null {
  const index = clipsOfTake(settings, take).findIndex((c) => c.name === name);
  if (index < 0) return null;
  // Clips come out take by take in the entries' order, so the clip's place within its take is its entry's.
  const cut = clipsFromTakes(takes, settings, []).filter((c) => c.take === take);
  return cut[index]?.source ?? null;
}
