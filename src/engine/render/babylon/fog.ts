/**
 * The World's Fog on the Babylon backend (ADR 0071, 0110, 0130): moved from `BabylonRenderer.syncFog`
 * so it runs as a render feature in the `lighting` phase, after the lights and before the environment
 * (the environment's skybox dims by the sky fog this sets).
 */
import { Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Scene as BabylonScene } from "@babylonjs/core/scene.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { World } from "../../core/World";
import { Fog } from "../components";
import type { BabylonFeature } from "./feature";
import { setHeightFog } from "./heightFog";

const HEIGHT_FOG_OFF = { on: false, density: 0, base: 0, falloff: 1, color: [1, 1, 1] as [number, number, number] };
const HEIGHT_FOG_SCRATCH = { on: false, density: 0, base: 0, falloff: 1, color: [1, 1, 1] as [number, number, number] };

/** What fog needs from the renderer. */
export interface FogHost {
  readonly scene: Scene;
  /** How much the fog covers the sky this frame, 0 to 1 (`BabylonLighting.setSkyFog`). */
  setSkyFog(amount: number): void;
}

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
      this.host.setSkyFog(0);
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
    this.host.setSkyFog(amount);
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
