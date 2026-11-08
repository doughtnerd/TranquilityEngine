// The Sky plugin's runtime half (ADR 0134). The Sky component, its format and presets still live in
// `src/engine/sky/` (and are exported from `myco`) until the runtime contribution points
// (Components, render features) exist; this re-exports them so the plugin already has its shape.
// Runtime code: never imports from `src/editor/` or the plugin's `editor/` folder.
import { skyManifest } from "../manifest";

export { Sky } from "../../../engine/sky/Sky";
export {
  SKY_FORMAT,
  MAX_CLOUD_LAYERS,
  defaultSky,
  defaultCloudLayer,
  parseSky,
  formatSky,
  cloneSky,
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
} from "../../../engine/sky/skyFormat";
export { SKY_PRESETS, skyPreset, type SkyPresetId } from "../../../engine/sky/presets";

export const skyRuntimePlugin = { manifest: skyManifest } as const;
