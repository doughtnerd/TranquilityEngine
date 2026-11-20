/**
 * The World's Fog on the Babylon backend (ADR 0071, 0110, 0130): a render feature in the `lighting`
 * phase. It sets the scene's distance and height fog, and contributes how much it covers the sky to the
 * lighting rig (ADR 0252), which dims the skybox by it when it resolves after the phase.
 */
import { Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Scene as BabylonScene } from "@babylonjs/core/scene.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { World } from "../../core/World";
import { Fog } from "../components";
import type { RenderFeatureSpec } from "../renderFeatures";
import type { BabylonFeature } from "./feature";
import { setHeightFog } from "./heightFog";
import type { LightingContributions } from "./lighting";

const HEIGHT_FOG_OFF = { on: false, density: 0, base: 0, falloff: 1, color: [1, 1, 1] as [number, number, number] };
const HEIGHT_FOG_SCRATCH = { on: false, density: 0, base: 0, falloff: 1, color: [1, 1, 1] as [number, number, number] };

/** What fog needs from the renderer: the scene, and the lighting rig it contributes the sky fog to. */
export interface FogHost {
  readonly scene: Scene;
  readonly lighting: LightingContributions;
}

/** The fog's spec: core, eager, owns Fog. No `after`: it only contributes to the lighting rig (ADR 0252). */
export const FOG_SPEC: RenderFeatureSpec = { name: "fog", phase: "lighting", types: [Fog], lazy: false };

/** @internal The World's first enabled Fog, mirrored into the scene's distance and height fog. */
export class FogFeature implements BabylonFeature {
  private skyFogState: { amount: number; color: Color4 } | null = null;

  constructor(private readonly host: FogHost) {}

  /** The fog the sky fades to (the frame plan reads it), or null when the fog doesn't affect the sky. */
  skyFog(): { amount: number; color: Color4 } | null {
    return this.skyFogState;
  }

  /**
   * The World's first enabled Fog sets the scene's distance fog (ADR 0071): linear or exponential
   * squared, like three.js's Fog and FogExp2. Its colour is linear here, since the scene renders in
   * linear HDR. With `affectsSkybox`, the sky dims towards the fog and a plain background lerps to it.
   */
  sync(world: World): void {
    const fog = world._componentsOfType(Fog).find((f) => f.isActiveAndEnabled) ?? null;
    const s = this.host.scene;
    if (!fog) {
      s.fogMode = BabylonScene.FOGMODE_NONE;
      this.skyFogState = null;
      setHeightFog(s, HEIGHT_FOG_OFF);
      return;
    }
    const exp = fog.mode === "exponential";
    s.fogMode = fog.mode === "none" ? BabylonScene.FOGMODE_NONE : exp ? BabylonScene.FOGMODE_EXP2 : BabylonScene.FOGMODE_LINEAR;
    s.fogColor.set(fog.color.r, fog.color.g, fog.color.b).toLinearSpaceToRef(s.fogColor); // in place: no colour per frame
    s.fogDensity = Math.max(0, fog.density);
    s.fogStart = Math.max(0, fog.near);
    s.fogEnd = Math.max(s.fogStart + 1e-3, fog.far);
    const amount = fog.affectsSkybox ? Math.min(1, Math.max(0, fog.skyboxFog)) : 0;
    if (amount <= 0) this.skyFogState = null;
    else {
      this.skyFogState ??= { amount, color: new Color4() };
      this.skyFogState.amount = amount;
      this.skyFogState.color.set(fog.color.r, fog.color.g, fog.color.b, 1);
    }
    this.host.lighting.contribute({ skyFog: amount });
    // Height fog (ADR 0110): in the same linear colour as distance fog.
    const hf = HEIGHT_FOG_SCRATCH;
    hf.on = fog.heightFog;
    hf.density = Math.max(0, fog.heightFogDensity);
    hf.base = fog.heightFogBase;
    hf.falloff = Math.max(1e-4, fog.heightFogFalloff);
    hf.color[0] = s.fogColor.r;
    hf.color[1] = s.fogColor.g;
    hf.color[2] = s.fogColor.b;
    setHeightFog(s, hf);
  }

  /** Nothing to free: it only sets scene fields, and the scene's disposal ends them. */
  dispose(): void {
    this.skyFogState = null;
  }
}
