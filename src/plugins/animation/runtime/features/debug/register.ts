// Registration seam: debug (T60). Registers the animation debug-link topic the live debugger reads (T52, ADR 0376).
// `activate()` (`../../index.ts`) calls it once per activation. The topic's code loads by `import()`, only in a build
// whose link starts (debugging on); a release export holds none of it.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerDebug(context: RuntimePluginContext, _on: AnimationIntegrations): void {
  context.debugLink.topic("animation", () => import("./debugLink/topic").then((m) => m.animationTopic));
}
