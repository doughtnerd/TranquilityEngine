// The Particles plugin's runtime half (ADR 0057, 0060, 0135): the ParticleSystem component and the
// particles render feature, registered when the plugin activates. `myco` (`src/myco.ts`) exports the
// public parts from here.
// The component class, the effect format and compiler (`src/engine/scene/particle*.ts`) and the
// particle player (`src/engine/render/babylon/particles.ts`, `render/particles/`) stay in core: the
// asset thumbnails' effect previews, the editor's overlays and preview, and the warm-up use them too
// (renderers stay first-party, ADR 0133).
// Runtime code: never imports from `src/editor/` or the plugin's `editor/` folder; never imports
// Babylon (the feature's code loads on demand).
import { ParticleSystem } from "../../../engine/render/components";
import type { RenderFeatureSpec } from "../../../engine/render/renderFeatures";
import type { RuntimePlugin } from "../../runtimeContext";
import { particlesManifest } from "../manifest";

export { ParticleSystem, type ParticlePropertyValue } from "../../../engine/render/components";

/**
 * @internal Plays ParticleSystems; loaded the first time a World has one (ADR 0083). The only feature
 * of the `effects` phase, which runs after content and lighting and before probes capture.
 */
export const PARTICLES_SPEC: RenderFeatureSpec = { name: "particles", phase: "effects", types: [ParticleSystem], lazy: true, holdsFirstFrame: false };

export const particlesRuntimePlugin: RuntimePlugin = {
  manifest: particlesManifest,
  activate(context) {
    context.registerComponents([ParticleSystem]);
    // Its phase keeps today's order (after content and lighting, before probes); no `after` is needed
    // while it's the phase's only feature.
    context.registerRenderFeature({ spec: PARTICLES_SPEC, load: () => import("./particlesFeature").then((m) => m.createParticlesFeature) });
  },
};
