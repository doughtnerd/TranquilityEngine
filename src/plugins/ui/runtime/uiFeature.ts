// The UI plugin's render feature (ADR 0140): `BabylonUIFeature` (UICore laid out and drawn with Babylon
// GUI) built from the renderer's core services. Loaded the first time a World has UI (ADR 0083), so Yoga
// and Babylon GUI stay out of games without it. ADR 0154: the UI's own host is built here, from the
// renderer's core host; the renderer names nothing of the UI.
import type { BabylonFeatureFactory, BabylonFeatureHost } from "../../../engine/render/babylon/feature";
import { BabylonUIFeature, type BabylonUIHost } from "../../../engine/render/babylon/uiFeature";
import { loadBundledFont } from "../../../engine/ui/fonts";

/** @internal The UI feature's host, from the renderer's core host (ADR 0130's model, ADR 0154). */
export function uiHost(host: BabylonFeatureHost): BabylonUIHost {
  return {
    scene: host.scene,
    texture: (ref) => host.materials.texture(ref),
    viewCamera: () => host.viewCamera(),
    interactive: () => !host.policy().sceneView, // the editor's scene view: clicks select, they don't press buttons
    previewRect: () => host.previewRect(),
    canvasSize: () => {
      const grid = host.pixelGrid();
      return { cssW: grid.width, cssH: grid.height, pixelRatio: grid.pixelRatio };
    },
    setFrameUI: (draw) => host.setScreenLayer(draw),
    setFramePreviewUI: (draw) => host.setPreviewLayer(draw),
  };
}

/** @internal Loads the bundled font first (text isn't measured in a fallback font), then gives the factory. */
export async function loadUIFeature(): Promise<BabylonFeatureFactory> {
  await loadBundledFont();
  return (host) => BabylonUIFeature.fromHost(uiHost(host));
}
