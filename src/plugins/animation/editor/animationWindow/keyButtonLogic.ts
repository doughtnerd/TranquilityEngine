// The Inspector's key buttons (ADR 0373, 0371: "the Inspector shows key buttons on animatable fields"): what the button
// beside a field shows, and what clicking it does, for a field of a node under the Animation window's Animator.
//
// - Shown on fields a track can drive: the field itself, or a plain object's animatable sub-paths (D86; one button
//   keys all of them).
// - **Filled** when a key of the field lies at the playhead, **outlined** when the clip animates it elsewhere, empty
//   otherwise.
// - Clicking a filled button removes the keys at the playhead; otherwise it keys the field's value there.
//
// Pure; no DOM.
import type { AnimSource } from "../../../../engine/animation/animSource";
import { fieldPathValue } from "../../../../engine/animation/bindingPath";
import type { Binding } from "../../../../engine/animation/tracks";
import { accept, type EditResult } from "../../../../editor/sdk";
import { keyField, keyState, unkeyField, type KeyState } from "./clipEditLogic";
import { animatedPaths } from "./fieldTracksLogic";

/** A field's key button: its state, or null where there is no button (the field can't be animated). */
export function keyButtonState(clip: AnimSource, field: Binding, t: number): KeyState | null {
  const paths = animatedPaths(field.component, field.field);
  if (!paths.length) return null;
  const states = paths.map((p) => keyState(clip, { ...field, field: p }, t));
  return states.includes("key") ? "key" : states.includes("animated") ? "animated" : "none";
}

/** What clicking the key button does: the clip edit and its label (`value` is the field's value now, scene-file JSON). */
export function toggleKey(clip: AnimSource, field: Binding, value: unknown, t: number): { label: string; result: EditResult<AnimSource> } {
  const paths = animatedPaths(field.component, field.field);
  const on = keyButtonState(clip, field, t) === "key";
  let result: EditResult<AnimSource> = accept(clip);
  for (const p of paths) {
    if ("refused" in result) break;
    const b = { ...field, field: p };
    if (on) {
      if (keyState(result.next, b, t) === "key") result = unkeyField(result.next, b, t);
    } else {
      result = keyField(result.next, b, fieldPathValue(value, p), t);
    }
  }
  return { label: `${on ? "Remove" : "Add"} key: ${field.field}`, result: paths.length ? result : keyField(clip, field, value, t) };
}
