// Registration seam: network (T33). Registers replication of the Animator's net fields; predicted root motion (its system is registered by `activate()` when `on.physics`).
// `activate()` (`../../index.ts`) calls it once per activation; empty until T33.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerNetwork(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
