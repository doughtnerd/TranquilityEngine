// The plugin set's editor adapter (ADR 0144): activates and deactivates editor halves through their
// context (ADR 0134). The editor host (`editorPlugins.ts`) passes it to its plugin set. Editor code only.
import { activatePlugin, deactivatePlugin, isPluginActive, type EditorPlugin } from "../editor/sdk/plugins";
import type { HalfActivator } from "./pluginSet";

export const editorActivator: HalfActivator<EditorPlugin> = {
  activate: activatePlugin,
  deactivate: deactivatePlugin,
  isActive: isPluginActive,
};
