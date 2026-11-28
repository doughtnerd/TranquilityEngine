/**
 * The audio engine system (ADR 0074): the plugin's `activate` registers it (`registerEngineSystems`), so it
 * runs in every World and is listed with the engine's systems.
 *
 * ADR 0162 (K4): the frame runs main's M3 passes in one order for both backends (api-and-models §6, architecture §1).
 * (ADR 0166's early music step, `engine.AudioMusic`, went with the music player, ADR 0343: a playlist's beats, bars and
 * markers arrive in late update.)
 *
 * `engine.Audio` (lateUpdate): the listener (an enabled `AudioListener`, else the main camera) into the backend and
 * the frame's `ListenerFrame`, the occlusion pass's source bindings, then the main-thread audio frame (`audioFrame.ts`
 * `stepAudioFrame`, ADR 0446: `mixer.update`, the backend frame of ADR 0270, the playlist runtime), then the sources' sync.
 * The order inside the frame is written there, once, for the system and the test rigs alike. Nothing in this file changes
 * for a feature: each fills its own file.
 */
import { mixer } from "../../../engine/audio/mixer";
import type { BuiltinSystem } from "../../../engine/core/systems";
import type { World } from "../../../engine/core/World";
import { _startWorldService, _worldServiceIds, _worldServiceOf } from "../../../engine/core/worldServices";
import { Camera } from "../../../engine/render/components";
import type { GameObject } from "../../../engine/scene/GameObject";
import { AudioListener, listenerPose } from "./AudioListener";
import { isSpatialPassHost, ListenerFrame } from "./core/spatial";
import type { OcclusionPass } from "./core/occlusion";
import { stepAudioFrame, type AudioFrameParts } from "./audioFrame";
import { AudioSource, worldKeyOf, worldPlays } from "./AudioSource";
import { audioBackend, hasAudioBackend, isPendingCoreBackend, type AudioWorldViews } from "./backend";
import { playlistHost } from "./playlists/host";
import { AUDIO, type AudioWorldService } from "./core/service";

/** Worlds whose audio system already asked for the core's World service. */
const askedCore = new WeakSet<World>();

/**
 * A3.4b, architecture §3.9: tells the core which Worlds have the view. Runs in every World the Engine steps (the view's
 * World, and an editor World that keeps running beside play mode), and reports every World holding a share of the
 * host, not only the caller, so a World that no longer steps (paused, or its Engine stopped) still goes inaudible
 * when another World has the view, and comes back when it gets it. Its voices go virtual (in time, silent); they
 * aren't stopped. A cheap loop over the Worlds; nothing allocates.
 */
function reportView(world: World): void {
  if (!hasAudioBackend()) return;
  const views = audioBackend().worldViews; // ADR 0446: a capability (0179); the core has it
  if (!views) return;
  const service = _worldServiceOf(world, AUDIO) as AudioWorldService | null;
  if (!service?.core.host) return;
  reportTo = views;
  liveKeys.clear();
  service.core.host.forEachWorld(reportOne);
  reportTo = null;
  // A World the host no longer lists is gone: its random generator and pick state go with it (ADR 0158 §6).
  playlistHost().keepWorlds(liveKeys);
}

let reportTo: AudioWorldViews | null = null;
const reportOne = (key: number, owner: object): void => {
  reportTo?.setWorldAudible(key, worldPlays(owner as World));
  liveKeys.add(key);
};
/** The keys the host lists this frame (reused, so nothing allocates). */
const liveKeys = new Set<number>();

/** ADR 0162 (K4): the listener frame main's passes share (one: only the World with the view runs the frame). */
const frame = new ListenerFrame();

/** ADR 0446: what the main-thread audio frame runs over; the backend and the playlist host are read each frame (reused, so nothing allocates). */
let parts: AudioFrameParts | null = null;

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
      playlistHost().noteWorld(worldKeyOf(world), world); // a key now held by another World drops the old one's playlist state
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
      const backend = audioBackend();
      if (isSpatialPassHost(backend)) bindOcclusionSources(world, backend.occlusion);
      parts ??= { mixer, playlists: null, backend, frame };
      parts.backend = backend;
      parts.playlists = playlistHost();
      stepAudioFrame(parts, dt); // ADR 0446: mixer, backend frame (0270), playlists, in one module
      listenerComponent?._noteVelocity(frame.velX, frame.velY, frame.velZ);
      for (const s of world._componentsOfType(AudioSource)) s._sync();
    },
  },
];
