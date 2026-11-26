// The Decals plugin's runtime half (ADR 0395): `DecalProjector` and `Decal2D`, the `Decals` pool and its aging system,
// and the lazy `decals` render feature. The decal logic is here, renderer-neutral (`decalRenderer.ts`); the renderer core
// draws decal volumes and quads. `myco` (`src/myco.ts`) exports this module's public parts.
// Runtime code: never imports from `src/editor/` or the plugin's `editor/` folder; never imports Babylon (the
// feature's code loads on demand).
import type { RenderFeatureSpec } from "../../../engine/render/renderFeatures";
import type { RuntimePlugin } from "../../runtimeContext";
import { decalsManifest } from "../manifest";
import { Decal2D, DecalProjector } from "./components";
import { DECAL_POOL_SYSTEM, decalPoolOf } from "./Decals";

export { Decal2D, DecalProjector, type Decal2DClip, type DecalBlend } from "./components";
export { Decals, type DecalHandle, type DecalProjectOptions, type DecalStampOptions } from "./Decals";

/**
 * In `effects`; loaded the first time a World has a decal Component or a spawned decal, and holding its first frame
 * meanwhile, so a level's decals show from frame one (ADR 0120).
 */
const DECALS_SPEC: RenderFeatureSpec = {
  name: "decals",
  phase: "effects",
  types: [DecalProjector, Decal2D],
  lazy: true,
  holdsFirstFrame: true,
  needed: (world) => world._componentsOfType(DecalProjector).length > 0 || world._componentsOfType(Decal2D).length > 0 || (decalPoolOf(world, false)?.count ?? 0) > 0,
};

export const decalsRuntimePlugin: RuntimePlugin = {
  manifest: decalsManifest,
  activate(context) {
    context.registerComponents([DecalProjector, Decal2D]);
    context.registerEngineSystems([DECAL_POOL_SYSTEM]);
    context.registerRenderFeature({ spec: DECALS_SPEC, load: () => import("./decalRenderer").then((m) => m.createDecalsFeature) });
  },
};
