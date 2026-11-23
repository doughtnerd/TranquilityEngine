// Registration seam: sprites2d (T21). Registers 2D skeletons and skinned sprites through the quad-batch path.
// `activate()` (`../../index.ts`) calls it once per activation; empty until T21.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerSprites2D(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
