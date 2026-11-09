// The scene view's particle preview (ADR 0057): with a ParticleSystem node selected in edit mode, its
// effect plays in the scene view, steered by a small overlay (ui/ParticlePreviewOverlay.tsx). Installed on
// each scene view as the Particles plugin's viewport tool `myco.particles.preview` (ADR 0138, 0146).
import { computed, effect, signal } from "@preact/signals";
import type { Engine, GameObject } from "../../../engine";
import { ParticleSystem } from "../../../engine/render/components";
import { renderDiagnostics, viewport } from "../../../engine/editor";
import { editor } from "../../../editor/sdk";

/** Play or pause, speed, and whether every ParticleSystem plays (not only the selected one). */
export const particlePreview = signal({ playing: true, speed: 1, simulateAll: false });

/** The selected node with a ParticleSystem, in edit mode, or null. */
export const selectedParticleSystem = computed<GameObject | null>(() => {
  editor.project.version; // nodes are rebuilt by structural edits
  if (editor.scene.playState !== "edit") return null;
  const node = editor.scene.selection.node();
  return node && node.isValid && node.getBehavior(ParticleSystem) ? node : null;
});

let engine: Engine | null = null;

/** Keep the editor World's particle preview in step with `particlePreview`. Returns a function that stops. */
export function installParticlePreview(e: Engine): () => void {
  engine = e;
  const stop = effect(() => viewport(e.world).setParticlePreview(particlePreview.value));
  return () => {
    stop();
    if (engine === e) engine = null;
  };
}

/** Restart the previewed effects (the overlay's Restart). */
export function restartPreview(): void {
  if (engine) viewport(engine.world).restartParticlePreview();
}

/** The previewed effect's time and particle count, or null when none is playing. */
export function previewStats(): { time: number; count: number } | null {
  return engine ? (renderDiagnostics(engine.world)?.features.particles?.previewed ?? null) : null;
}
