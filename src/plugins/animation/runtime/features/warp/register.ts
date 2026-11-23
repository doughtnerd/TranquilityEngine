// Registration seam: warp (T40t). Motion-warp targets (`../warp.ts`) are per-Animator host state sent by
// `animation.Gather` (`./gather.ts`) as `WARP_TARGET` commands; nothing is registered per activation.
// `activate()` (`../../index.ts`) calls it once per activation.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerWarp(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
