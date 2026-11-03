// The scene view's particle preview (ADR 0057): with a ParticleSystem node selected in edit mode, its
// effect plays in the scene view, steered by a small overlay (ui/ParticlePreviewOverlay.tsx).
import { computed, effect, signal } from "@preact/signals";
import { ParticleSystem, type Engine, type GameObject } from "../engine";
import { particleState, restartParticlePreview, setParticlePreview } from "../engine/editor";
import { docVersion, playState, selectedWorldNode } from "./state";

/** Play or pause, speed, and whether every ParticleSystem plays (not only the selected one). */
export const particlePreview = signal({ playing: true, speed: 1, simulateAll: false });

/** The selected node with a ParticleSystem, in edit mode, or null. */
export const selectedParticleSystem = computed<GameObject | null>(() => {
  docVersion.value; // nodes are rebuilt by structural edits
  if (playState.value !== "edit") return null;
  const node = selectedWorldNode();
  return node && node.isValid && node.getBehavior(ParticleSystem) ? node : null;
});

let engine: Engine | null = null;

/** Keep the editor World's particle preview in step with `particlePreview`. Returns a function that stops. */
export function installParticlePreview(e: Engine): () => void {
  engine = e;
  const stop = effect(() => setParticlePreview(e.world, particlePreview.value));
  return () => {
    stop();
    if (engine === e) engine = null;
  };
}

/** Restart the previewed effects (the overlay's Restart). */
export function restartPreview(): void {
  if (engine) restartParticlePreview(engine.world);
}

/** The previewed effect's time and particle count, or null when none is playing. */
export function previewStats(): { time: number; count: number } | null {
  return engine ? (particleState(engine.world)?.previewed ?? null) : null;
}
