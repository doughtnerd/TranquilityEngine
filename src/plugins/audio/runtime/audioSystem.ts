/**
 * The audio engine system (ADR 0074): the plugin's `activate` registers it (`registerEngineSystems`), so it
 * runs in every World and is listed with the engine's systems.
 */
import { mixer } from "../../../engine/audio/mixer";
import type { BuiltinSystem } from "../../../engine/core/systems";
import type { World } from "../../../engine/core/World";
import { Camera } from "../../../engine/render/components";
import type { GameObject } from "../../../engine/scene/GameObject";
import { AudioListener, listenerPose } from "./AudioListener";
import { AudioSource, worldPlays } from "./AudioSource";
import { audioBackend } from "./backend";

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
