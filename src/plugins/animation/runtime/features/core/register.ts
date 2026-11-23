// Registration seam: core (T13t). Registers the `AnimationCore` World service that loads the wasm core lazily (one instance per page, Node too) and releases assets between editor play sessions.
// `activate()` (`../../index.ts`) calls it once per activation; empty until T13t.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerCore(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
