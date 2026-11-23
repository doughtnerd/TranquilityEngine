// Registration seam: tweens (T22t). Registers the per-World tween table and its promises.
// `activate()` (`../../index.ts`) calls it once per activation; empty until T22t.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerTweens(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
