// Registration seam: core (T13t). Registers the `AnimationCore` World service (`../../core/service.ts`), which loads the
// wasm core lazily (one instance per page, Node too) the first time a World needs animation; idle assets are released
// between editor play sessions (`../../core/loader.ts`). `activate()` (`../../index.ts`) calls it once per activation.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import { ANIMATION_CORE_SERVICE } from "../../core/service";
import { setBoneMapGuesser } from "../../../../../engine/animation/import/boneMapGuess";
import { createBoneMapGuesser } from "../../core/boneMap";
import { loadAnimationCore } from "../../core/loader";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerCore(context: RuntimePluginContext, _on: AnimationIntegrations): void {
  context.registerWorldService(ANIMATION_CORE_SERVICE);
  // T14: models imported while the plugin is active get their bone map guessed by the core (ADR 0371).
  setBoneMapGuesser(createBoneMapGuesser(loadAnimationCore));
}
