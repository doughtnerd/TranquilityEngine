// The Camera Shake plugin's runtime half (ADR 0435): the CameraShake and ShakeImpulseSource components, the
// ShakeImpulses buffer and the two engine systems that turn impulses and noise into each camera's CameraViewOffset,
// which the renderer core adds to the drawn view. `myco` (`src/myco.ts`) exports this module's public parts.
// Runtime code: never imports from `src/editor/` or the plugin's `editor/` folder; never imports Babylon.
import type { RuntimePlugin } from "../../runtimeContext";
import { cameraShakeManifest } from "../manifest";
import { CameraShake } from "./CameraShake";
import { ShakeImpulseSource } from "./ShakeImpulseSource";
import { setShakePhysics } from "./physics";
import { LISTEN_SYSTEM, SOURCES_SYSTEM } from "./systems";

export { CameraShake } from "./CameraShake";
export { ShakeImpulseSource, type ShakeImpulseTrigger } from "./ShakeImpulseSource";
export { ShakeImpulses, type ShakeImpulse } from "./buffers";
export { CAMERA_NOISE_PRESETS, SHAKE_IMPULSE_PRESETS, type CameraNoisePreset, type ShakeImpulsePreset } from "./presets";

export const cameraShakeRuntimePlugin: RuntimePlugin = {
  manifest: cameraShakeManifest,
  activate(context) {
    setShakePhysics(context.plugins.isActive("myco.physics"));
    context.registerComponents([CameraShake, ShakeImpulseSource]);
    context.registerEngineSystems([SOURCES_SYSTEM, LISTEN_SYSTEM]);
  },
};
