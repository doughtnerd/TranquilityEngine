// Registration seam: core (T13t). Registers the `AnimationCore` World service (`../../core/service.ts`), which loads the
// wasm core lazily (one instance per page, Node too) the first time a World needs animation; idle assets are released
// between editor play sessions (`../../core/loader.ts`). Also installs the engine's tween backend provider (ADR 0424): UI
// animation then runs on the core's tween table (`../../core/tweenBackend.ts`) instead of the standalone tween module.
// `activate()` (`../../index.ts`) calls it once per activation.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import { ANIMATION_CORE_SERVICE } from "../../core/service";
import { setBoneMapGuesser } from "../../../../../engine/animation/import/boneMapGuess";
import { createBoneMapGuesser } from "../../core/boneMap";
import { loadAnimationCore } from "../../core/loader";
import { createCoreTweenBackend } from "../../core/tweenBackend";
import { TWEEN_BACKEND_PROVIDER } from "../../../../../engine/tween/backend";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerCore(context: RuntimePluginContext, _on: AnimationIntegrations): void {
  context.registerWorldService(ANIMATION_CORE_SERVICE);
  // T14: models imported while the plugin is active get their bone map guessed by the core (ADR 0371).
  setBoneMapGuesser(createBoneMapGuesser(loadAnimationCore));
  // ADR 0424: UI animation runs on the core's tween table while the plugin is active (removed again on deactivation).
  context.contribute(TWEEN_BACKEND_PROVIDER, async () => {
    const load = await loadAnimationCore();
    return load.status === "ready" ? createCoreTweenBackend(load.core) : null;
  });
}
