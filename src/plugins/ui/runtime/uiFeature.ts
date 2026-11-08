// The UI plugin's render feature (ADR 0140): `BabylonUIFeature` (UICore laid out and drawn with Babylon
// GUI) built from the renderer's UI services. Loaded the first time a World has UI (ADR 0083), so Yoga
// and Babylon GUI stay out of games without it.
import type { BabylonFeatureFactory } from "../../../engine/render/babylon/feature";
import { BabylonUIFeature } from "../../../engine/render/babylon/uiFeature";
import { loadBundledFont } from "../../../engine/ui/fonts";

/** @internal Loads the bundled font first (text isn't measured in a fallback font), then gives the factory. */
export async function loadUIFeature(): Promise<BabylonFeatureFactory> {
  await loadBundledFont();
  return (host) => BabylonUIFeature.fromHost(host.uiHost());
}
