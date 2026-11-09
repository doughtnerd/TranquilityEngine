// The Meshes plugin's render feature (ADR 0140): `BabylonMeshes` built from the renderer's shared
// services (the material library, the probe lookup). Loaded on demand (before the renderer starts:
// it's eager), so Babylon stays out of `myco`.
import type { BabylonFeatureFactory } from "../../../engine/render/babylon/feature";
import { BabylonMeshes } from "../../../engine/render/babylon/meshes";

/** @internal Builds the feature from the renderer's shared services. */
export const createMeshesFeature: BabylonFeatureFactory = (host) => new BabylonMeshes({ scene: host.scene, materials: host.materials, probes: host.probes, reflected: () => host.probes.reflected() });
