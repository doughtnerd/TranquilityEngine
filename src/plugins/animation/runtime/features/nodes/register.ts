// Registration seam: nodes (T45t). Registers third-party graph and rig nodes declared in `plugin.json` (wasm modules with a fuel pass).
// `activate()` (`../../index.ts`) calls it once per activation; empty until T45t.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerNodes(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
