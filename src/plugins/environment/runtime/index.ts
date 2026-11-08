// The Environment plugin's runtime half (ADR 0140): claims the Environment component. Its drawing (image
// lighting, the skybox) is the renderer core's lighting rig, which gives every World the studio lighting
// and carries the Sky plugin's bake into the scene with or without an Environment, so it registers no
// render feature: with the plugin off, the rig finds no Environment and lights with the studio map.
// `myco` (`src/myco.ts`) exports the public parts from here.
import { Environment } from "../../../engine/render/components";
import type { RuntimePlugin } from "../../runtimeContext";
import { environmentManifest } from "../manifest";

export { Environment } from "../../../engine/render/components";

export const environmentRuntimePlugin: RuntimePlugin = {
  manifest: environmentManifest,
  activate(context) {
    context.registerComponents([Environment]);
  },
};
