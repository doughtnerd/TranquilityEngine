// The scene view's grid, camera preview and tool keys (ADR 0022). The grid follows the snap settings; with a
// Camera node selected in edit mode, a picture-in-picture inset shows what it sees (the Scene panel
// draws the inset's frame, `previewFrame`; the engine renders into the canvas under it).
import { computed, effect, signal } from "@preact/signals";
import { Camera, type Engine, type GameObject } from "../engine";
import { addEditorOverlay, removeEditorOverlay, viewport } from "../engine/editor";
import { boxLines } from "./visibilityDebugLogic";
import { cameraPreviewEnabled, cleanDebugMode, cleanSnap, freezeCulling, installSceneToolKeys, lighting2DShown, occlusionValidator, sceneOcclusion, snapSettings, visibilityDebug } from "./sceneTools";
import { theme, visibilityColors } from "./theme";
import { docVersion, playState, selectedWorldNode } from "./state";

/** The overlay id of the occlusion debug view's culled boxes (ADR 0460 §6). */
const CULLED_OVERLAY = "myco.visibility.culled";

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
    viewport(world).setGrid({ cellSize: s.grid, visible: s.showGrid });
  });
  const stopPreview = effect(() => viewport(world).setCameraPreview(previewCamera.value?.getBehavior(Camera) ?? null, previewFrame.value));
  const stopLighting = effect(() => viewport(world).setLighting2D(lighting2DShown.value));
  // The View menu's visibility tools (ADR 0460 §6), tinted from the theme's --lod0..7 and --danger tokens.
  const stopVisibility = effect(() => {
    const colors = visibilityColors(theme.value);
    viewport(world).setSceneVisibility({
      occlusion: sceneOcclusion.value === true,
      freeze: freezeCulling.value === true,
      validator: occlusionValidator.value === true,
      debug: cleanDebugMode(visibilityDebug.value),
      colors: { levels: colors.levels, occluded: colors.occluded },
    });
  });
  // The occlusion debug view's red boxes: what the last run culled, through the editor overlay.
  const stopCulledBoxes = effect(() => {
    if (cleanDebugMode(visibilityDebug.value) !== "occlusion") return removeEditorOverlay(world, CULLED_OVERLAY);
    const color = visibilityColors(theme.value).occluded;
    addEditorOverlay(world, CULLED_OVERLAY, () => {
      const debug = viewport(world).occlusionDebug(world);
      return { lines: debug ? boxLines(debug.culled, color) : [], handles: [] };
    });
  });
  const stopKeys = typeof window === "undefined" ? () => {} : installSceneToolKeys(window);
  return () => {
    stopGrid();
    stopPreview();
    stopLighting();
    stopVisibility();
    stopCulledBoxes();
    removeEditorOverlay(world, CULLED_OVERLAY);
    stopKeys();
    viewport(world).setCameraPreview(null, null);
  };
}
