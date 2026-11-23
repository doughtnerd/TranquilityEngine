// Editor registration seam: animationWindow (T50). Registers the Animation window: dope sheet, curves, record mode, event, marker, audio and activation rows, onion skin.
// The editor half's `activate()` (`../index.ts`) calls it once per activation.
//
// - The window is a single dockable panel, opened from the Add Panel dialog, by double-clicking an authored clip (the
//   `animclip` kind names it as its panel) or with the Animator card's "Animation window" button.
// - Key buttons beside animatable fields in the Inspector are a field adornment; record mode is a field write
//   interceptor (both editor SDK points added for this window, ADR 0373).
import { h } from "preact";
import type { ComponentHeaderActionProps, EditorPluginContext } from "../../../../editor/sdk";
import { editor } from "../../../../editor/sdk";
import type { AnimationEditorIntegrations } from "../registration";
import { ANIMATION_WINDOW_PANEL, recordInterceptor } from "./animationSession";
import { KeyButton } from "./KeyButton";

/** The Animator card's header button that opens the window. */
function OpenWindowButton(props: ComponentHeaderActionProps) {
  if (props.paths.length !== 1) return null;
  return h(
    "button",
    { type: "button", class: "edit-handles aw-open", title: "Open the Animation window on this Animator's clip", "aria-label": "Open the Animation window", onClick: () => editor.showPanel(ANIMATION_WINDOW_PANEL) },
    "◆",
  );
}

/** @internal */
export function registerAnimationWindow(context: EditorPluginContext, _on: AnimationEditorIntegrations): void {
  context.registerPanel({
    id: ANIMATION_WINDOW_PANEL,
    title: "Animation",
    view: () => import("./AnimationWindow").then((m) => m.AnimationWindow),
    dock: "bottom",
    single: true,
    onDemand: true,
  });
  context.registerFieldAdornment({ id: "myco.animation.keyButton", view: KeyButton });
  context.registerFieldWriteInterceptor(recordInterceptor);
  context.registerComponentHeaderAction({ id: "myco.animation.openWindow", types: ["engine.Animator"], view: OpenWindowButton });
}
