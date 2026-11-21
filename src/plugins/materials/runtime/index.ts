// The Materials plugin's runtime half (ADR 0134, 0135). It contributes no Components and no render feature:
// the `Material` handle, the material, shader graph and shader asset formats and the graph compiler stay in
// `src/engine/` (`myco` exports `Material` and the `MaterialSettings` types from there), because material
// resolution and the material library are shared render services the renderer, the thumbnails and the
// warm-up all use (ADR 0133, 0135, 0140: renderers stay first-party). The half registers nothing.
// Runtime code: never imports from `src/editor/` or the plugin's `editor/` folder.
import type { RuntimePlugin } from "../../runtimeContext";
import { materialsManifest } from "../manifest";

export const materialsRuntimePlugin: RuntimePlugin = { manifest: materialsManifest, activate() {} };
