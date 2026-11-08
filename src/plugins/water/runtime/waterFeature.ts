// The Water plugin's render feature (ADR 0140): `WaterFeature` (which draws with `BabylonWater`) built
// from the renderer's scene and probe lookup. Loaded the first time a World has water (ADR 0083).
import type { BabylonFeatureFactory } from "../../../engine/render/babylon/feature";
import { WaterFeature } from "../../../engine/render/babylon/waterFeature";

/** @internal Builds the feature from the renderer's shared services. */
export const createWaterFeature: BabylonFeatureFactory = (host) => new WaterFeature(host.scene, (x, y, z) => host.probeLookup(x, y, z));
