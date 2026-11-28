// The Post-processing plugin's runtime half (ADR 0140): claims the PostProcessing component. The frame
// plan reads it per camera and the frame graph composes it (ADR 0129), both renderer core, so it
// registers no render feature: with the plugin off, cameras find no PostProcessing and draw plain.
// `myco` exports its public parts (`./public.ts`).
import { PostProcessing } from "../../../engine/render/components";
import type { RuntimePlugin } from "../../runtimeContext";
import { postProcessingManifest } from "../manifest";

export * from "./public";

export const postProcessingRuntimePlugin: RuntimePlugin = {
  manifest: postProcessingManifest,
  activate(context) {
    context.registerComponents([PostProcessing]);
  },
};
