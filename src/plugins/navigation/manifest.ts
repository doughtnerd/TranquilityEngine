// The Navigation plugin's manifest (ADR 0065, 0133, 0135): navmesh chunks, agents, groups, gates and
// volumes on the navigation WebAssembly module. Runtime only for now: its editor parts (baking, the
// inspectors, gizmos and previews, the Navigation panel and settings section) still live in
// `src/editor/`, and the bake-side code they share with `npm run nav:bake` (settings, geometry, plan,
// bake, the module loader and its committed `wasm/` output) stays in `src/engine/nav/`.
import type { PluginManifest } from "../manifest";

export const navigationManifest: PluginManifest = {
  name: "myco.navigation",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
};
