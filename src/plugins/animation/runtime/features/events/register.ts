// Registration seam: events (T20t). Registers notify delivery through the World's named behaviour messages; `audio` tracks through the audio plugin's public API when `on.audio`.
// `activate()` (`../../index.ts`) calls it once per activation; empty until T20t.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerEvents(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
