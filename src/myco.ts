/**
 * The public `myco` module (ADR 0135): the core (`src/engine/index.ts`) plus every first-party runtime
 * half's public exports. Game code and project scripts import from here (`import { Sky } from "myco"`);
 * the engine library, the player's `myco.js` and the code editor's declarations are built from it.
 * three.js, Babylon.js, Rapier and Howler are never part of this surface (ADR 0010).
 */
export * from "./engine/index";

// The Sky plugin (ADR 0112–0114, 0135).
export {
  Sky,
  SKY_FORMAT,
  MAX_CLOUD_LAYERS,
  defaultSky,
  defaultCloudLayer,
  parseSky,
  formatSky,
  SKY_PRESETS,
  skyPreset,
  type SkySettings,
  type SkyMode,
  type SunPlacement,
  type SkySun,
  type SkyAtmosphere,
  type SkyGradient,
  type SkySunDisc,
  type SkyMoon,
  type SkyCloudLayer,
  type SkyStars,
  type SkyHorizon,
  type SkyLighting,
  type SkyProblem,
  type SkyPresetId,
} from "./plugins/sky/runtime";

// The Materials plugin's public types (`Material`, `MaterialSettings`) are core exports: material
// resolution is a shared render service (ADR 0133).
