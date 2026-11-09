// The `myco.audio` World service (ADR 0157, K3): started in a World that has the view when the project
// picks `audio.backend: "core"`. Its lazy `load` is the dynamic-import boundary: servers and headless
// Worlds never run it, and a project on `"babylon"` never loads the core.
// A0.4 ships only the stub; A0.3 fills `load()` (loader, worklet, host), A0.8 the lifecycle.
import { mixer } from "../../../../engine/audio/mixer";
import type { World } from "../../../../engine/core/World";
import type { WorldServiceDef } from "../../../../engine/core/worldServices";
import type { AudioHost } from "./context";

export const AUDIO = "myco.audio";

/** @internal What `load()` gives: the page's host once the core loaded (`ready`), else why not (`reason`). */
export interface AudioCoreModule {
  readonly ready: boolean;
  readonly host?: AudioHost;
  /** Why the core didn't load (probe refusal, fetch, compile or start failure); A0.6's fallback warns with it. */
  readonly reason?: string;
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
  /**
   * Probes the engine (K8: `probe.ts`, which A0.6 fills), then dynamic-imports the host and starts it: the wasm is
   * fetched and compiled, the context created (suspended while autoplay is blocked) and the worklet node made, so
   * the first gesture only resumes (architecture §3.1). Resolving, not throwing, keeps scene loads working:
   * `audioBackend()` falls back to "babylon" until a core backend registers (A1.4), and A0.6 warns with `reason`.
   */
  load: async (): Promise<AudioCoreModule> => {
    const { probeCoreSupport } = await import("./probe");
    const probe = await probeCoreSupport();
    if (!probe.supported) return { ready: false, reason: probe.reason };
    try {
      const { startAudioHost } = await import("./context");
      return { ready: true, host: await startAudioHost(mixer.audioSettings) };
    } catch (error) {
      return { ready: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },
  create: (world, core) => new AudioWorldService(world, core),
  dispose: (s) => s.dispose(),
};
