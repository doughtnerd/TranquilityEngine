/**
 * The audio engine system (ADR 0074): the plugin's `activate` registers it (`registerEngineSystems`), so it
 * runs in every World and is listed with the engine's systems.
 */
import { mixer } from "../../../engine/audio/mixer";
import type { BuiltinSystem } from "../../../engine/core/systems";
import type { World } from "../../../engine/core/World";
import { _startWorldService, _worldServiceIds, _worldServiceOf } from "../../../engine/core/worldServices";
import { Camera } from "../../../engine/render/components";
import type { GameObject } from "../../../engine/scene/GameObject";
import { AudioListener, listenerPose } from "./AudioListener";
import { AudioSource, worldPlays } from "./AudioSource";
import { audioBackend, hasAudioBackend, isPendingCoreBackend } from "./backend";
import { AUDIO, type AudioWorldService } from "./core/service";

/** Worlds whose audio system already asked for the core's World service. */
const askedCore = new WeakSet<World>();

/** What the audio system needs of the core backend to say which World has the view (A3.1 `CoreBackend.setWorldAudible`). */
interface WorldAudibleSink {
  setWorldAudible(key: number, audible: boolean): void;
}

const hasWorldAudible = (b: unknown): b is WorldAudibleSink => typeof (b as Partial<WorldAudibleSink>).setWorldAudible === "function";

/**
 * A3.4b, architecture §3.9: tells the core which Worlds have the view. Runs in every World the Engine steps (the view's
 * World, and an editor World that keeps running beside play mode), and reports every World holding a share of the
 * host, not only the caller, so a World that no longer steps (paused, or its Engine stopped) still goes inaudible
 * when another World has the view, and comes back when it gets it. Its voices go virtual (in time, silent); they
 * aren't stopped. A cheap loop over the Worlds; nothing allocates.
 */
function reportView(world: World): void {
  if (!hasAudioBackend()) return;
  const backend: unknown = audioBackend();
  if (!hasWorldAudible(backend)) return;
  const service = _worldServiceOf(world, AUDIO) as AudioWorldService | null;
  if (!service?.core.host) return;
  reportTo = backend;
  service.core.host.forEachWorld(reportOne);
  reportTo = null;
}

let reportTo: WorldAudibleSink | null = null;
const reportOne = (key: number, owner: object): void => reportTo?.setWorldAudible(key, worldPlays(owner as World));

/**
 * Per frame, in the World that has the view: place the backend's listener at the first enabled
 * AudioListener (else the main camera) and move the spatial sources to their nodes (ADR 0074).
 */
export const AUDIO_SYSTEMS: readonly BuiltinSystem[] = [
  {
    name: "engine.Audio",
    phase: "lateUpdate",
    after: ["engine.NetSend"], // as before the move: audio last in lateUpdate
    run(world: World, dt: number): void {
      reportView(world);
      if (!worldPlays(world)) return;
      // "core" with no AudioSource or AudioListener to start the service (a script's one-shots only): start it here,
      // once per World, so the pending backend's locked voices don't wait for a load nobody began (§2.1).
      if (isPendingCoreBackend(audioBackend()) && !askedCore.has(world) && !_worldServiceOf(world, AUDIO) && _worldServiceIds().includes(AUDIO)) {
        askedCore.add(world);
        _startWorldService(world, AUDIO).catch((err: unknown) => console.error(`[myco] World service "${AUDIO}" couldn't load:`, err));
      }
      let listener: GameObject | null = null;
      for (const l of world._componentsOfType(AudioListener)) {
        if (l.isActiveAndEnabled) {
          listener = l.node;
          break;
        }
      }
      if (!listener) {
        let best: Camera | null = null;
        for (const c of world._componentsOfType(Camera)) if (c.isActiveAndEnabled && (!best || c.depth < best.depth)) best = c;
        listener = best?.node ?? null;
      }
      if (listener) {
        const { position: p, forward: f, up: u } = listenerPose(listener);
        audioBackend().setListener({ position: p, forward: f, up: u });
      }
      mixer.update(dt);
      audioBackend().update?.(dt);
      for (const s of world._componentsOfType(AudioSource)) s._sync();
    },
  },
];
