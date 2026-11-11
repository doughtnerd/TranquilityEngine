/**
 * The audio engine system (ADR 0074): the plugin's `activate` registers it (`registerEngineSystems`), so it
 * runs in every World and is listed with the engine's systems.
 *
 * ADR 0162 (K4): the frame runs main's M3 passes in one order for both backends (api-and-models §6, architecture §1):
 *
 * 1. **attenuation**: the core's `frameAttenuate` (gain, direction, `audibility0`); the Babylon fallback pans itself;
 * 2. **Doppler** (`core/doppler.ts`, D3), 3. **zones** (`core/zones.ts`, C5, the core only: inert on the fallback),
 *    4. **occlusion** (`core/occlusion.ts`, D2a): over the backend's `SpatialVoiceView`, results back through it;
 * 5. **audibility × smoothed occlusion** and **selection**: the core's `frameSelect`;
 * 6. **panner pick** (`core/pannerPick.ts`, A5), 7. **fx staging** (`core/voiceFx.ts`), 8. **listener** (LISTENER,
 *    `core/listener.ts`, B5), then the core's BATCH (`frameCommit`).
 *
 * On a backend that implements only `SpatialPassHost` (the Babylon fallback, F1), Doppler and occlusion run on main the
 * same way and its `update(dt)` follows; a backend with neither (the pending backend, test fakes) just gets `update(dt)`.
 * Nothing in this file changes for a feature: each fills its own file.
 */
import { mixer } from "../../../engine/audio/mixer";
import type { BuiltinSystem } from "../../../engine/core/systems";
import type { World } from "../../../engine/core/World";
import { _startWorldService, _worldServiceIds, _worldServiceOf } from "../../../engine/core/worldServices";
import { Camera } from "../../../engine/render/components";
import type { GameObject } from "../../../engine/scene/GameObject";
import { AudioListener, listenerPose } from "./AudioListener";
import { isSpatialPassHost, isStagedFrameHost, ListenerFrame } from "./core/spatial";
import type { OcclusionPass } from "./core/occlusion";
import type { AudioBackend } from "./backend";
import { AudioSource, worldKeyOf, worldPlays } from "./AudioSource";
import { audioBackend, hasAudioBackend, isPendingCoreBackend } from "./backend";
import { events } from "./events/eventRuntime";
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
  liveKeys.clear();
  service.core.host.forEachWorld(reportOne);
  reportTo = null;
  // A World the host no longer lists is gone: its random generator and sequence positions go with it (ADR 0158 §6).
  events().keepWorlds(liveKeys);
}

let reportTo: WorldAudibleSink | null = null;
const reportOne = (key: number, owner: object): void => {
  reportTo?.setWorldAudible(key, worldPlays(owner as World));
  liveKeys.add(key);
};
/** The keys the host lists this frame (reused, so nothing allocates). */
const liveKeys = new Set<number>();

/** ADR 0162 (K4): the listener frame main's passes share (one: only the World with the view runs the frame). */
const frame = new ListenerFrame();

/**
 * ADR 0162 (D2a, C14): tells the occlusion pass which node plays each AudioSource's voice, so its rays exclude the
 * source's subtree. Before the passes, every frame (a voice started this frame is bound before its first ray). An
 * event-driven source's voices belong to its instance and stay unbound (their rays exclude the listener only).
 */
function bindOcclusionSources(world: World, pass: OcclusionPass): void {
  const sources = world._componentsOfType(AudioSource);
  for (let k = 0; k < sources.length; k++) {
    const s = sources[k]!;
    const id = s._voiceId;
    if (id !== 0) pass.bindSource(id, s.node);
  }
}

/**
 * ADR 0162 (K4): one backend frame in the M3 order (see the header). The settings are read once; each pass takes what it
 * needs from them.
 */
function runFrame(backend: AudioBackend, dt: number): void {
  if (isStagedFrameHost(backend)) {
    const settings = mixer.audioSettings;
    const view = backend.spatialVoices;
    backend.frameAttenuate(dt); // 1. attenuation
    backend.collectSpatialVoices();
    backend.doppler.run(frame, view, settings); // 2. Doppler
    backend.zones.run(frame, view, settings); // 3. zones
    backend.occlusion.run(frame, view, settings); // 4. occlusion
    backend.frameSelect(); // 5. audibility × smoothed occlusion, selection
    backend.framePickPanners(); // 6. panner pick
    backend.frameStageFx(); // 7. fx staging
    backend.frameStageListener(frame); // 8. listener
    backend.frameCommit();
    return;
  }
  if (isSpatialPassHost(backend)) {
    // The Babylon fallback (F1, api-and-models §8): main's Doppler and occlusion, then its own frame. No zones (inert).
    const settings = mixer.audioSettings;
    backend.collectSpatialVoices();
    backend.doppler.run(frame, backend.spatialVoices, settings);
    backend.occlusion.run(frame, backend.spatialVoices, settings);
  }
  backend.update?.(dt);
}

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
      events().noteWorld(worldKeyOf(world), world); // a key now held by another World drops the old one's event state
      // "core" with no AudioSource or AudioListener to start the service (a script's one-shots only): start it here,
      // once per World, so the pending backend's locked voices don't wait for a load nobody began (§2.1).
      if (isPendingCoreBackend(audioBackend()) && !askedCore.has(world) && !_worldServiceOf(world, AUDIO) && _worldServiceIds().includes(AUDIO)) {
        askedCore.add(world);
        _startWorldService(world, AUDIO).catch((err: unknown) => console.error(`[myco] World service "${AUDIO}" couldn't load:`, err));
      }
      let listener: GameObject | null = null;
      let listenerComponent: AudioListener | null = null;
      for (const l of world._componentsOfType(AudioListener)) {
        if (l.isActiveAndEnabled) {
          listener = l.node;
          listenerComponent = l;
          break;
        }
      }
      if (!listener) {
        let best: Camera | null = null;
        for (const c of world._componentsOfType(Camera)) if (c.isActiveAndEnabled && (!best || c.depth < best.depth)) best = c;
        listener = best?.node ?? null;
      }
      const pose = listener ? listenerPose(listener) : null;
      if (pose) audioBackend().setListener({ position: pose.position, forward: pose.forward, up: pose.up });
      // ADR 0162 (K4): the frame's listener for the passes (R14: this World has the view).
      frame.set(world, worldKeyOf(world), listener, pose, dt);
      frame.setOverride(listenerComponent?._velocityOverride ?? null);
      mixer.update(dt);
      const backend = audioBackend();
      if (isSpatialPassHost(backend)) bindOcclusionSources(world, backend.occlusion);
      runFrame(backend, dt);
      listenerComponent?._noteVelocity(frame.velX, frame.velY, frame.velZ);
      events().update(dt); // ADR 0158: due continuous-container timers; the fallback's automation
      for (const s of world._componentsOfType(AudioSource)) s._sync();
    },
  },
];
