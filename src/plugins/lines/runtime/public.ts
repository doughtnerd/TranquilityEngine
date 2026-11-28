// The Lines and Trails plugin's public runtime surface: every name `myco` exports for it (`src/myco.ts` re-exports this module
// whole, ADR 0447). Public names only: the plugin's RuntimePlugin object and its internals stay in `index.ts`.
export { LineRenderer } from "./LineRenderer";
export { TrailRenderer } from "./TrailRenderer";
export type { RibbonAlignment, RibbonMode, RibbonTextureMode } from "./RibbonRenderer";
