// The `myco.audio` World service (ADR 0157, K3): started in a World that has the view when the project
// picks `audio.backend: "core"`. Its lazy `load` is the dynamic-import boundary: servers and headless
// Worlds never run it, and a project on `"babylon"` never loads the core.
// A0.4 ships only the stub; A0.3 fills `load()` (loader, worklet, host), A0.8 the lifecycle.
import { mixer } from "../../../../engine/audio/mixer";
import type { World } from "../../../../engine/core/World";
import type { WorldServiceDef } from "../../../../engine/core/worldServices";

export const AUDIO = "myco.audio";

/** @internal What `load()` gives: the core's code. A0.3 adds the host; `ready` is false for the stub. */
export interface AudioCoreModule {
  readonly ready: boolean;
}

/** @internal One World's handle on the (page-wide) audio host. A0.3 and A0.8 fill it. */
export class AudioWorldService {
  constructor(readonly world: World, readonly core: AudioCoreModule) {}
  dispose(): void {}
}

/** @internal The World service (K3): whether `audio.backend` is `"core"` decides if a World runs it at all. */
export const AUDIO_SERVICE: WorldServiceDef<AudioCoreModule, AudioWorldService> = {
  id: AUDIO,
  neededBy: { components: ["engine.AudioSource", "engine.AudioListener"] },
  runsIn: (world) => !!world.render && mixer.audioSettings.backend === "core",
  /** A0.3 replaces the body (the dynamic import of the loader). Resolving, not throwing, keeps scene loads working: `audioBackend()` falls back to "babylon" until a core backend registers. */
  load: () => Promise.resolve({ ready: false }),
  create: (world, core) => new AudioWorldService(world, core),
  dispose: (s) => s.dispose(),
};
