// Registration seam: events (T20t). Notifies are delivered by `animation.Apply` through the World's named behaviour messages
// (`deliver.ts`); `audio` keys play through the audio plugin's public API only while `on.audio` (ADR 0374: read at each
// activation; the plugin activates again when audio comes or goes). `activate()` (`../../index.ts`) calls it once per activation.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";
import { setAudioTracks } from "./audio";

/** @internal */
export function registerEvents(_context: RuntimePluginContext, on: AnimationIntegrations): void {
  setAudioTracks(on.audio);
}
