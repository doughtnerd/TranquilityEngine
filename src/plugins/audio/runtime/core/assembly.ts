// ADR 0221: the one assembly of the audio core over a host. Production and the loopback tests build the same stack here:
// the host follows the mixer's settings (and every Engine's reconfigure of the page mixer), a trap in the core starts the
// hard rebuild (A3.4a), and the core backend is made over the host (ADR 0178's session, 0179's capabilities) once the core
// has answered. The seam is the host: `service.ts` passes the AudioWorklet host (`startAudioHost`), the loopback tests
// (`runtime/testing.ts` `loopbackAudio`) an `AudioHost` whose node runs the committed wasm in Node. Any change to how the
// core is put together is made here, so no rig assembles it slightly differently.
import { mixer as pageMixer, type Mixer } from "../../../../engine/audio/mixer";
import type { AudioSettings } from "../../../../engine/audio/settings";
import { onAudioConfigured } from "../../../../engine/core/audioConfigure";
import type { AudioHost } from "./context";
import { createCoreBackend, type CoreBackend, type CoreBackendDeps } from "./coreBackend";
import { watchForTraps, type RecoveryOptions } from "./recovery";

/** What `assembleCore` takes beyond the host: the backend's dependencies (`createCoreBackend`'s) and recovery's options. */
export interface CoreAssemblyDeps extends CoreBackendDeps {
  /** The trap recovery's rate-limit clock, numbers and warning, used the first time this host is armed (default: `performance.now`, 3 per 60 s, `console.warn`). */
  readonly recovery?: RecoveryOptions;
}

/** The assembled core over one host. */
export interface CoreAssembly {
  readonly host: AudioHost;
  /** Resolves once the core answered (its first STATUS with the ready flag and this ABI, §3.1); rejects when it failed to start. */
  readonly ready: Promise<void>;
  /**
   * Makes the core backend over the host with the assembly's dependencies (`createCoreBackend`: the clip registry, the clock
   * and the background controller). Call it once `ready` resolved, as the service's registration does.
   */
  createBackend(): CoreBackend;
}

/** Hosts connected to their mixer, with their disconnect. */
const connections = new WeakMap<AudioHost, () => void>();
/** Hosts whose traps start a rebuild (A3.4a), so a second assembly doesn't watch twice. */
const armed = new WeakSet<AudioHost>();

/**
 * Assembles the core over `host` (ADR 0221): connects the host to the mixer's settings, arms trap recovery once per host,
 * and returns the backend factory. `deps.mixer` defaults to the page's mixer; production passes nothing else.
 */
export function assembleCore(host: AudioHost, deps: CoreAssemblyDeps = {}): CoreAssembly {
  const { recovery, ...backendDeps } = deps;
  connectHostToMixer(host, deps.mixer ?? pageMixer);
  // A3.4a: a trap in the core starts the hard rebuild (3 per 60 s, then silent "failed").
  if (!armed.has(host)) {
    armed.add(host);
    watchForTraps(host, recovery);
  }
  return {
    host,
    ready: host.link.ready,
    createBackend: () => createCoreBackend(host, backendDeps),
  };
}

/**
 * Connects a freshly started host to its mixer: applies the mixer's current settings (`host.reconfigure`). For the page's
 * mixer it then follows every later `Engine.create`'s `_onAudioConfigured` (`Engine.ts` reconfigure) until the host
 * closes; another mixer (a test's own) is configured by no Engine, so the host takes its settings once. Connecting the
 * same host again (the service registered again, so `load` ran again) adds nothing.
 */
function connectHostToMixer(host: AudioHost, mixer: Mixer): void {
  if (connections.has(host) || host.closed) return;
  const stopFollowing =
    mixer === pageMixer
      ? onAudioConfigured((settings: AudioSettings) => {
          if (!host.closed) host.reconfigure(settings);
        })
      : () => {};
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
}
