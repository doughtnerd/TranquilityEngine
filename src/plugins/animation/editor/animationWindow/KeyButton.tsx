// The key button beside an animatable field in the Inspector (ADR 0373), contributed as a field adornment
// (`registerFieldAdornment`). It shows while the Animation window is open on an Animator above the field's node:
// filled with a key at the playhead, outlined when the clip animates the field elsewhere, empty otherwise. Clicking it
// adds or removes the key at the playhead, one undo step on the clip (`keyButtonLogic.ts`).
import type { FieldAdornmentProps } from "../../../../editor/sdk";
import { animationSession } from "./animationSession";
import { keyButtonState, toggleKey } from "./keyButtonLogic";
import "./animationWindow.css";

/** The diamond's look for each state. */
const LOOK = {
  key: { cls: "key", title: "Remove the key at the playhead" },
  animated: { cls: "animated", title: "Animated: add a key at the playhead" },
  none: { cls: "", title: "Add a key at the playhead" },
} as const;

export function KeyButton(props: FieldAdornmentProps) {
  const s = animationSession;
  if (!s.open.value) return null;
  const binding = s.bindingOf(props.scene, props.path, props.type, props.field);
  const doc = s.document.value;
  if (!binding || !doc) return null;
  const clip = doc.value.value;
  const t = s.playhead.time.value;
  const state = keyButtonState(clip, binding, t);
  if (state === null) return null;
  const look = LOOK[state];
  return (
    <button
      type="button"
      class={`aw-keybtn ${look.cls}`}
      aria-label={`${state === "key" ? "Remove key" : "Add key"}: ${props.field}`}
      aria-pressed={state === "key"}
      title={`${look.title} (${t.toFixed(2)} s)`}
      onClick={(e) => {
        e.stopPropagation();
        const { label, result } = toggleKey(clip, binding, props.value, t);
        if (s.apply(result, label)) s.show();
      }}
    />
  );
}
