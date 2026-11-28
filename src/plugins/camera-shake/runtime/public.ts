// The Camera Shake plugin's public runtime surface: every name `myco` exports for it (`src/myco.ts` re-exports this module
// whole, ADR 0447). Public names only: the plugin's RuntimePlugin object and its internals stay in `index.ts`.
export { CameraShake } from "./CameraShake";
export { ShakeImpulseSource, type ShakeImpulseTrigger } from "./ShakeImpulseSource";
export { ShakeImpulses, type ShakeImpulse } from "./buffers";
export { CAMERA_NOISE_PRESETS, SHAKE_IMPULSE_PRESETS, type CameraNoisePreset, type ShakeImpulsePreset } from "./presets";
