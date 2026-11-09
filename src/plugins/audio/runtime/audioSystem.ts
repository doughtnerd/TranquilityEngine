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
import { audioBackend, isPendingCoreBackend } from "./backend";
import { AUDIO } from "./core/service";

/** Worlds whose audio system already asked for the core's World service. */
const askedCore = new WeakSet<World>();

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
