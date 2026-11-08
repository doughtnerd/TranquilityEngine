// The UI plugin's manifest (ADR 0133, 0140), shared by its runtime and editor halves.
import type { PluginManifest } from "../manifest";

export const uiManifest: PluginManifest = {
  name: "myco.ui",
  title: "UI",
  description: "Game UI: canvases, panels, text, images, buttons, input fields, UI documents and stylesheets, and world-space Text.",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
};
