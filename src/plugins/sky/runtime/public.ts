// The Sky plugin's public runtime surface: every name `myco` exports for it (`src/myco.ts` re-exports this module
// whole, ADR 0447). Public names only: the plugin's RuntimePlugin object and its internals stay in `index.ts`.
export { Sky } from "./Sky";
export { SKY_FORMAT, MAX_CLOUD_LAYERS, defaultSky, defaultCloudLayer, parseSky, formatSky, type SkySettings, type SkyMode, type SunPlacement, type SkySun, type SkyAtmosphere, type SkyGradient, type SkySunDisc, type SkyMoon, type SkyCloudLayer, type SkyStars, type SkyHorizon, type SkyLighting, type SkyProblem } from "../../../engine/sky/skyFormat";
export { SKY_PRESETS, skyPreset, type SkyPresetId } from "../../../engine/sky/presets";
