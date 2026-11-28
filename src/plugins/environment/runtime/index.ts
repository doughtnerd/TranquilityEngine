// The Environment plugin's runtime half (ADR 0140): claims the Environment component. Its drawing (image
// lighting, the skybox) is the renderer core's lighting rig, which gives every World the studio lighting
// and carries the Sky plugin's bake into the scene with or without an Environment, so it registers no
// render feature: with the plugin off, the rig finds no Environment and lights with the studio map.
// `myco` exports its public parts (`./public.ts`).
import { Environment } from "../../../engine/render/components";
import type { RuntimePlugin } from "../../runtimeContext";
import { environmentManifest } from "../manifest";

export * from "./public";

export const environmentRuntimePlugin: RuntimePlugin = {
  manifest: environmentManifest,
  activate(context) {
    context.registerComponents([Environment]);
  },
};
