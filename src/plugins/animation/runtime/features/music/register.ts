// Registration seam: music (T72). Turns musical timing (`at` against an `AudioPlaylistHandle`, `../music.ts`) on only
// when `on.audio`; without it `at` is refused with one warning. `activate()` (`../../index.ts`) calls it once per
// activation, and again when the audio plugin comes or goes (ADR 0374).
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";
import { setMusicTiming } from "../music";

/** @internal */
export function registerMusic(_context: RuntimePluginContext, on: AnimationIntegrations): void {
  setMusicTiming(on.audio);
}
