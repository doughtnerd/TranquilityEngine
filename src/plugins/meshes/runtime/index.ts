// The Meshes and models plugin's runtime half (ADR 0140): claims MeshRenderer and registers the meshes
// render feature. The component class, the model loaders (`scene/models.ts`, ADR 0088) and the Babylon
// adapter (`BabylonMeshes`) stay in core: the adapter must stay under `render/babylon/` (ADR 0075) and
// reads the class, physics' MeshCollider and the editor's thumbnails read models, and core never imports
// plugins (ADR 0135). `myco` (`src/myco.ts`) exports the public parts from here.
// Runtime code: never imports from `src/editor/` or Babylon (the feature's code loads on demand).
import { MeshRenderer } from "../../../engine/render/components";
import type { RenderFeatureSpec } from "../../../engine/render/renderFeatures";
import type { RuntimePlugin } from "../../runtimeContext";
import { meshesManifest } from "../manifest";

export { MeshRenderer } from "../../../engine/render/components";

/** @internal After sprites and tilemaps (absent names are ignored), as before (ADR 0130, 0136). */
export const MESHES_SPEC: RenderFeatureSpec = { name: "meshes", phase: "content", types: [MeshRenderer], lazy: false, after: ["sprites", "tilemaps"] };

export const meshesRuntimePlugin: RuntimePlugin = {
  manifest: meshesManifest,
  activate(context) {
    context.registerComponents([MeshRenderer]);
    context.registerRenderFeature({ spec: MESHES_SPEC, load: () => import("./meshesFeature").then((m) => m.createMeshesFeature) });
  },
};
