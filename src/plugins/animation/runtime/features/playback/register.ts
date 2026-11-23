// Registration seam: playback (T17). Registers code-first playback's per-World state (plays, promises, the implicit graph).
// `activate()` (`../../index.ts`) calls it once per activation; empty until T17.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerPlayback(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
