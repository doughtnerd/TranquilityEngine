// Registration seam: skinning (T16). Registers the skinning render feature (the `mycoSkin` kernel on `render/gpuKernels/`, bone matrices and morph weights uploaded at render sync).
// `activate()` (`../../index.ts`) calls it once per activation; empty until T16.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerSkinning(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
