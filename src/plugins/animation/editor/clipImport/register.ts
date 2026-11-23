// Editor registration seam: clipImport (T54). Registers clip import settings: takes, loop match, root motion, additive reference, compression report, markers, events and curves.
// The editor half's `activate()` (`../index.ts`) calls it once per activation.
import type { EditorPluginContext } from "../../../../editor/sdk";
import type { AnimationEditorIntegrations } from "../registration";

/** @internal */
export function registerClipImport(context: EditorPluginContext, _on: AnimationEditorIntegrations): void {
  // A card of the `model` kind's Import Settings (the kind is the Meshes plugin's): it edits the same draft as the model's own
  // rows, and the shell's Apply and Revert write it (ADR 0143, 0373; `ClipImportSettings.tsx`).
  context.registerImportSettingsSection({ id: "myco.animation.clips", kind: "model", title: "Animation Clips", view: () => import("./ClipImportSettings").then((m) => m.ClipImportSettings) });
}
