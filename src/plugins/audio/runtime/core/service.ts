// The `myco.audio` World service (ADR 0157, K3): started in a World that has the view when the project
// picks `audio.backend: "core"`. Its lazy `load` is the dynamic-import boundary: servers and headless
// Worlds never run it, and a project on `"babylon"` never loads the core.
// A0.4 shipped the stub; A0.3 filled `load()` (loader, worklet, host), A0.8 the lifecycle: each World takes a
// share of the one page host and releases it on teardown (architecture §3.9), and the host follows every
// Engine's mixer reconfigure (`Engine._onAudioConfigured`).
import { mixer } from "../../../../engine/audio/mixer";
import type { AudioSettings } from "../../../../engine/audio/settings";
import { onAudioConfigured } from "../../../../engine/core/audioConfigure";
import type { World } from "../../../../engine/core/World";
import type { WorldServiceDef } from "../../../../engine/core/worldServices";
import { registerCoreBackend } from "../backend";
import type { AudioHost, WorldKey, WorldShare } from "./context";

export const AUDIO = "myco.audio";

/** @internal What `load()` gives: the page's host once the core loaded (`ready`), else why not (`reason`). */
export interface AudioCoreModule {
  readonly ready: boolean;
  readonly host?: AudioHost;
  /** Why the core didn't load (probe refusal, fetch, compile or start failure); A0.6's fallback warns with it. */
  readonly reason?: string;
}

/**
 * @internal One World's handle on the (page-wide) audio host (§3.9). `create` attaches the World to the host;
 * `dispose` (World teardown: play stop, Engine dispose, `destroyWorld`) releases it, which stops that World's voices
 * and drops its clip holds once A1.1 and A1.3a listen. Without a host (the core didn't load) it holds nothing.
 */
export class AudioWorldService {
  /** The World's share of the host, or null when the core didn't load. */
  readonly share: WorldShare | null;

  private disposed = false;

  constructor(readonly world: World, readonly core: AudioCoreModule) {
    const host = core.ready && core.host && !core.host.closed ? core.host : null;
    this.share = host ? host.attachWorld(world) : null;
  }

  /** The World's key (the voice table's `world` byte), or 0 without a share. */
  get key(): WorldKey {
    return this.share && !this.share.released ? this.share.key : 0;
  }

  /** Releases the World's share (`host.releaseWorld`). A second call does nothing. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const share = this.share;
    // A released share's key may already be another World's: never release it twice.
    if (share && !share.released) this.core.host?.releaseWorld(share.key);
  }
}

/**
 * @internal Connects a freshly started host to the Engines (`Engine.ts` reconfigure): applies the mixer's current
 * settings (`host.reconfigure(mixer.audioSettings)`), then follows every later `Engine.create`'s
 * `_onAudioConfigured`. Returns the disconnect, which also runs when the host closes. Connecting the same host again
 * (the service registered again, so `load` ran again) adds nothing and returns the first disconnect. `onConfigured` defaults to
 * `Engine._onAudioConfigured` (tests may pass their own source).
 */
export function connectHostToEngines(
  host: AudioHost,
  onConfigured: (listener: (settings: AudioSettings) => void) => () => void = onAudioConfigured,
): () => void {
  const existing = connections.get(host);
  if (existing) return existing;
  if (host.closed) return () => {};
  const stopFollowing = onConfigured((settings) => {
    if (!host.closed) host.reconfigure(settings);
  });
  let removeListener: () => void = () => {};
  const disconnect = () => {
    if (connections.get(host) !== disconnect) return;
    connections.delete(host);
    stopFollowing();
    removeListener();
  };
  connections.set(host, disconnect);
  removeListener = host.addLifecycleListener({ onClose: disconnect });
  host.reconfigure(mixer.audioSettings);
  return disconnect;
}

/** Hosts connected to the Engines, with their disconnect. */
const connections = new WeakMap<AudioHost, () => void>();

/** @internal The World service (K3): whether `audio.backend` is `"core"` decides if a World runs it at all. */
export const AUDIO_SERVICE: WorldServiceDef<AudioCoreModule, AudioWorldService> = {
  id: AUDIO,
  neededBy: { components: ["engine.AudioSource", "engine.AudioListener"] },
  runsIn: (world) => !!world.render && mixer.audioSettings.backend === "core",
  /**
   * Probes the engine (K8: `probe.ts`, which A0.6 fills), then dynamic-imports the host and starts it: the wasm is
   * fetched and compiled, the context created (suspended while autoplay is blocked) and the worklet node made, so
   * the first gesture only resumes (architecture §3.1). The host is the page's one (`acquireAudioHost`), and it is
   * connected to the Engines' reconfigure once. Resolving, not throwing, keeps scene loads working:
   * `audioBackend()` falls back to "babylon" until a core backend registers (A1.4), and A0.6 warns with `reason`.
   */
  load: async (): Promise<AudioCoreModule> => {
    const { probeCoreSupport } = await import("./probe");
    const probe = await probeCoreSupport();
    if (!probe.supported) return { ready: false, reason: probe.reason };
    try {
      const { startAudioHost } = await import("./context");
      const host = await startAudioHost(mixer.audioSettings);
      connectHostToEngines(host);
      // A1.4: the core backend, made on first use by `audioBackend()` (the registry and voice table belong to it).
      const { createCoreBackend } = await import("./coreBackend");
      registerCoreBackend(() => createCoreBackend(host));
      return { ready: true, host };
    } catch (error) {
      return { ready: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },
  create: (world, core) => new AudioWorldService(world, core),
  dispose: (s) => s.dispose(),
};
