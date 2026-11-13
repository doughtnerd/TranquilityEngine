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
import { noteCoreUnavailable, registerCoreBackend } from "../backend";
import { capturePlayStopped } from "../capture/capture";
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
    // No host (the Babylon fallback, or a core that didn't load): Runtime Worlds are counted here, as the host's shares count them.
    if (!host && world.kind === "runtime") hostlessRuntime.add(this);
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
    // G7b (architecture §2.1 "Released"): Play stops with the last Runtime World. The editor's own World, a server World and a
    // Runtime World still running keep the capture going; a take is Held for the save (`capturePlayStopped`).
    hostlessRuntime.delete(this);
    if (this.world.kind === "runtime" && !(this.share ? hasRuntimeShare(this.core.host) : hostlessRuntime.size > 0)) capturePlayStopped();
  }
}

/** FU3: the Runtime Worlds running this service with no host (`audio.backend: "babylon"`, or the core failed to load): the last one's dispose is Play stop. */
const hostlessRuntime = new Set<AudioWorldService>();

/** Whether a Runtime World still holds a share of `host`. */
function hasRuntimeShare(host: AudioHost | undefined): boolean {
  let found = false;
  host?.forEachWorld((_key, owner) => {
    if ((owner as { kind?: string }).kind === "runtime") found = true;
  });
  return found;
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

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Hosts connected to the Engines, with their disconnect. */
const connections = new WeakMap<AudioHost, () => void>();
/** Hosts whose traps start a rebuild (A3.4a), so a second `load` doesn't watch twice. */
const armed = new WeakSet<AudioHost>();

/** @internal The World service (K3): whether `audio.backend` is `"core"` decides if a World runs it at all. */
export const AUDIO_SERVICE: WorldServiceDef<AudioCoreModule, AudioWorldService> = {
  id: AUDIO,
  neededBy: { components: ["engine.AudioSource", "engine.AudioListener"] },
  // FU3: a World with a view runs the service whatever the backend, so Play stop reaches the capture on the Babylon fallback
  // too (`load` answers "no host" there; the service then holds nothing but the Play-stop signal).
  runsIn: (world) => !!world.render,
  variant: () => (mixer.audioSettings.backend === "core" ? "core" : "babylon"),
  /**
   * Probes the engine (K8: `probe.ts`, which A0.6 fills), then dynamic-imports the host and starts it: the wasm is
   * fetched and compiled, the context created (suspended while autoplay is blocked) and the worklet node made, so
   * the first gesture only resumes (architecture §3.1). The host is the page's one (`acquireAudioHost`), and it is
   * connected to the Engines' reconfigure once. Resolving, not throwing, keeps scene loads working. Until the core
   * answers, `audioBackend()` is a pending stand-in whose plays wait as locked voices; they move to the core when it
   * registers, or to "babylon" (with A0.6's one warning) when the load fails.
   */
  load: async (variant: string): Promise<AudioCoreModule> => {
    if (variant === "babylon") return { ready: false, reason: `audio.backend is "babylon"` };
    const { probeCoreSupport } = await import("./probe");
    const probe = await probeCoreSupport();
    if (!probe.supported) return { ready: false, reason: probe.reason };
    try {
      const { startAudioHost } = await import("./context");
      const host = await startAudioHost(mixer.audioSettings);
      connectHostToEngines(host);
      // A3.4a: a trap in the core starts the hard rebuild (3 per 60 s, then silent "failed").
      const { watchForTraps } = await import("./recovery");
      if (!armed.has(host)) {
        armed.add(host);
        watchForTraps(host);
      }
      // A1.4: the core backend, made by `audioBackend()` (the registry and voice table belong to it). It registers once
      // the core has answered (the first STATUS with the ready flag and this ABI, §3.1); until then `audioBackend()` is
      // the pending stand-in whose plays wait as locked voices, so sound never settles on "babylon" just because the
      // core was slower than the first play. An ABI mismatch, a shell error or no first STATUS in 5 s is a failed load
      // (§2.1 fallback rule): one warning, then "babylon" for the page. Not awaited: a locked context answers only after
      // the gesture, and scene loads mustn't wait for it.
      const { createCoreBackend } = await import("./coreBackend");
      host.link.ready.then(
        () => registerCoreBackend(() => createCoreBackend(host)),
        (error: unknown) => noteCoreUnavailable(`audio core couldn't start (${errorText(error)}); using "babylon".`),
      );
      return { ready: true, host };
    } catch (error) {
      const reason = errorText(error);
      noteCoreUnavailable(`audio core couldn't load (${reason}); using "babylon".`);
      return { ready: false, reason };
    }
  },
  create: (world, core) => new AudioWorldService(world, core),
  dispose: (s) => s.dispose(),
};
