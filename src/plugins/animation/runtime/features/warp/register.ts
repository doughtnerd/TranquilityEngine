// Registration seam: warp (T40t). Registers motion-warp targets.
// `activate()` (`../../index.ts`) calls it once per activation; empty until T40t.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerWarp(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
