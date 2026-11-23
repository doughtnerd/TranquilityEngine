// Registration seam: music (T72). Registers musical timing against `AudioPlaylistHandle`, only when `on.audio`.
// `activate()` (`../../index.ts`) calls it once per activation; empty until T72.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerMusic(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
