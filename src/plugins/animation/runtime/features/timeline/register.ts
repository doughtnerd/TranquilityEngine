// Registration seam: timeline (T22t). Registers timeline playback state, control tracks (particles, camera cuts, nested slots) and playlist audio tracks (when `on.audio`).
// `activate()` (`../../index.ts`) calls it once per activation; empty until T22t.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerTimeline(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
