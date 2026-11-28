// The UI plugin's manifest (ADR 0133, 0140), shared by its runtime and editor halves.
import type { PluginManifest } from "../manifest";

export const uiManifest: PluginManifest = {
  name: "myco.ui",
  title: "UI",
  description: "Game UI: Svelte components mounted by UIView onto canvases, panels, text, images, buttons, form controls and media.",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
  // Where the Add Component menu lists its Components.
  componentCategories: {
    UI: ["engine.UIView", "engine.UIControlMapper"],
  },
};
