// Registration seam: core (T13t). Registers the `AnimationCore` World service (`../../core/service.ts`), which loads the
// wasm core lazily (one instance per page, Node too) the first time a World needs animation; idle assets are released
// between editor play sessions (`../../core/loader.ts`). `activate()` (`../../index.ts`) calls it once per activation.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import { ANIMATION_CORE_SERVICE } from "../../core/service";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerCore(context: RuntimePluginContext, _on: AnimationIntegrations): void {
  context.registerWorldService(ANIMATION_CORE_SERVICE);
}
