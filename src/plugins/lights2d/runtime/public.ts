// The Lights 2D plugin's public runtime surface: every name `myco` exports for it (`src/myco.ts` re-exports this module
// whole, ADR 0447). Public names only: the plugin's RuntimePlugin object and its internals stay in `index.ts`.
export { CompositeShadowCaster2D, Light2D, ShadowCaster2D, type Light2DNormals, type Light2DOverlap, type Light2DType, type ShadowCaster2DShape } from "../../../engine/render/components";
export type { BlendStyleMask, LightBlendStyle, Lighting2DSettings } from "../../../engine/render/lights2D/settings";
