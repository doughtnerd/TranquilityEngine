// Registration seam: properties (T20t). Registers the binding table that scatters property-track outputs into ECS columns.
// `activate()` (`../../index.ts`) calls it once per activation; empty until T20t.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerProperties(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
