// The scene view's grid, camera preview and tool keys (ADR 0022). The grid follows the snap settings; with a
// Camera node selected in edit mode, a picture-in-picture inset shows what it sees (the Scene panel
// draws the inset's frame, `previewFrame`; the engine renders into the canvas under it).
import { computed, effect, signal } from "@preact/signals";
import { Camera, type Engine, type GameObject } from "../engine";
import { cameraPreviewDrawn, editorGrid, setCameraPreview, setEditorGrid } from "../engine/editor";
import { installParticlePreview } from "./particlePreview";
import { cameraPreviewEnabled, cleanSnap, installSceneToolKeys, snapSettings } from "./sceneTools";
import { docVersion, playState, selectedWorldNode } from "./state";

/** The inset's frame element in the Scene panel, while it's shown. */
export const previewFrame = signal<HTMLElement | null>(null);

/** The selected Camera node the preview shows (whether or not the preview is turned on), or null. */
export const selectedCamera = computed<GameObject | null>(() => {
  docVersion.value; // nodes are rebuilt by structural edits
  if (playState.value !== "edit") return null;
  const node = selectedWorldNode();
  return node && node.isValid && node.getBehavior(Camera) ? node : null;
});

/** The camera the preview is showing: selected, and the preview is on. */
export const previewCamera = computed(() => (cameraPreviewEnabled.value ? selectedCamera.value : null));

/** Keep the grid and the camera preview in step with the settings and selection. Returns a function that stops. */
export function installSceneView(engine: Engine): () => void {
  const world = engine.world;
  const stopGrid = effect(() => {
    const s = cleanSnap(snapSettings.value);
    setEditorGrid(world, s.grid, s.showGrid);
  });
  const stopPreview = effect(() => setCameraPreview(world, previewCamera.value, previewFrame.value));
  const stopParticles = installParticlePreview(engine);
  const stopKeys = typeof window === "undefined" ? () => {} : installSceneToolKeys(window);
  // Debug and end-to-end test hooks.
  if (typeof window !== "undefined") Object.assign(window, { sceneView: { grid: () => editorGrid(world), previewDrawn: () => cameraPreviewDrawn(world) } });
  return () => {
    stopGrid();
    stopPreview();
    stopParticles();
    stopKeys();
    setCameraPreview(world, null, null);
  };
}
