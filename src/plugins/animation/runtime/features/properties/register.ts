// Registration seam: properties (T20t). The binding tables are built lazily per Animator and clip by `animation.Apply`
// (`scatter.ts`, `bindings.ts`) and need nothing registered at activation; the seam stays for later property features.
// `activate()` (`../../index.ts`) calls it once per activation.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerProperties(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
