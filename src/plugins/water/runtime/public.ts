// The Water plugin's public runtime surface: every name `myco` exports for it (`src/myco.ts` re-exports this module
// whole, ADR 0447). Public names only: the plugin's RuntimePlugin object and its internals stay in `index.ts`.
export { Water, WaterSurface, type WaterSample } from "../../../engine/render/water/WaterSurface";
