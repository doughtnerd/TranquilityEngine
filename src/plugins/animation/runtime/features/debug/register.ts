// Registration seam: debug (T60). Registers the animation debug-link topic the live debugger reads (T52).
// `activate()` (`../../index.ts`) calls it once per activation; empty until T60.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerDebug(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
