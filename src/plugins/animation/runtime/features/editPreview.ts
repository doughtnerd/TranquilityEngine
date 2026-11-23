// Editor previews of a clip on an Animator (ADR 0373 "Preview"; ADR 0026, D135): the Animation window poses the scene
// being edited in the viewport, as Unity's does. In edit mode an Animator is inert (`instances.ts`); a preview gives it
// an implicit-graph instance (`setAnimatorPreview`) and plays the clip at speed 0 from the playhead on layer 0, past a
// `graph` the Animator may have (which doesn't run in edit mode). Ending the preview destroys the instance, so the pose
// goes back to rest; the scene's fields are put back by the editor, which knows the scene. Outside edit mode (an
// Animator already running) the preview plays through `Animator.play` and ends with `Animator.stop`, as before.
import type { Animator } from "../components/Animator";
import { animatorRuntime, inEditMode, setAnimatorPreview } from "./instances";
import { queuePlay } from "./playback/plays";

/** @internal Show `clip` (an asset path) on `animator` at `normalizedTime` (0–1), held there (speed 0). */
export function previewClip(animator: Animator, clip: string, normalizedTime: number): void {
  const rt = animatorRuntime(animator);
  if (!rt) return;
  if (!inEditMode(rt)) {
    void animator.play(clip, { speed: 0, normalizedTime, loop: false });
    return;
  }
  setAnimatorPreview(animator, true);
  queuePlay(rt, clip, { layer: 0, fade: 0, speed: 0, startNormalized: normalizedTime, loop: false });
}

/** @internal End the preview on `animator`: in edit mode it is inert again, at rest; outside it, its plays stop. */
export function endClipPreview(animator: Animator): void {
  const rt = animatorRuntime(animator);
  if (!rt) return;
  if (!inEditMode(rt)) animator.stop();
  setAnimatorPreview(animator, false);
}
