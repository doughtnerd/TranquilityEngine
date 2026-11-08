// First-party plugins' runtime halves (ADR 0133). The player and the dedicated server import this
// list, never `editor.ts`; nothing here may import from `src/editor/` or a plugin's `editor/` folder.
import type { PluginManifest } from "./manifest";
import { materialsRuntimePlugin } from "./materials/runtime";
import { skyRuntimePlugin } from "./sky/runtime";

export const RUNTIME_PLUGINS: readonly { manifest: PluginManifest }[] = [materialsRuntimePlugin, skyRuntimePlugin];
