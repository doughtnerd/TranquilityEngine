// The Subtitles plugin's editor half (ADR 0357 §6): the Play toolbar's Subtitles overlay toggle. Turning the plugin off
// takes the toggle away with the display it would overlay.
import type { EditorPlugin } from "../../../editor/sdk";
import { subtitlesManifest } from "../manifest";

export const subtitlesEditorPlugin: EditorPlugin = {
  manifest: subtitlesManifest,
  activate(context) {
    context.registerPlayToolbarItem({ id: "myco.subtitles.overlay", view: () => import("./OverlayToggle").then((m) => m.OverlayToggle) });
  },
};
