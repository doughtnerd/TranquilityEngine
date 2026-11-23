// Registration seam: timeline (T22t). Sets the `control` track actions (particles, camera cuts, nested slots) on the events
// feature's dispatch point (`../timeline/controls.ts`). Timeline playback state lives per director
// (`../timeline.ts`); a timeline's `audio` keys play through the events feature's audio path, active while `on.audio`
// (set by `../events/register.ts`). `activate()` (`../../index.ts`) calls it once per activation.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";
import { registerControlHandlers } from "./controls";

/** @internal */
export function registerTimeline(_context: RuntimePluginContext, _on: AnimationIntegrations): void {
  registerControlHandlers();
}
