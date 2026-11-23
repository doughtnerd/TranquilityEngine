// Registration seam: tweens (T22t). The per-World tween tables and their promises are made on first use by `tween()`,
// `sequence()` and `parallel()` (`../tweens.ts`), which start the World's core lazily; nothing is registered at
// activation. `activate()` (`../../index.ts`) calls it once per activation.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerTweens(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
