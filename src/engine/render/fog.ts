/**
 * Distance fog (ADR 0071): mirrors the World's first enabled `Fog` component onto three's scene fog.
 * The existing fog object is updated in place every frame, so materials aren't recompiled; a new one
 * is made only when fog turns on or off or its mode changes (three recompiles then).
 */
import { Color as ThreeColor, Fog as ThreeFog, FogExp2, SRGBColorSpace, Texture, type Scene } from "three";
import type { Color } from "../core/math";
import type { Fog } from "./components";

const tmp = new ThreeColor();
const tmp2 = new ThreeColor();

const setColor = (target: ThreeColor, c: Color) => target.setRGB(c.r, c.g, c.b, SRGBColorSpace);

/**
 * Apply `fog` (null: no fog) to `scene`. Call after the environment sets `scene.background` for the
 * frame; `clear` is the colour shown where no skybox is drawn. When `fog.affectsSkybox` is on, the
 * background fades towards the fog colour by `skyboxFog` (0 to 1): a flat background lerps exactly,
 * a skybox texture dims by that fraction and becomes the plain fog colour at 1.
 */
export function applyFog(scene: Scene, fog: Fog | null, clear: ThreeColor): void {
  if (!fog) {
    if (scene.fog) scene.fog = null;
    return;
  }
  const exp = fog.mode === "exponential";
  if (exp ? !(scene.fog instanceof FogExp2) : !(scene.fog instanceof ThreeFog)) {
    scene.fog = exp ? new FogExp2(0xffffff, 0) : new ThreeFog(0xffffff, 0, 1);
  }
  const f = scene.fog!;
  setColor(f.color, fog.color);
  if (f instanceof FogExp2) {
    f.density = Math.max(0, fog.density);
  } else if (f instanceof ThreeFog) {
    f.near = Math.max(0, fog.near);
    f.far = Math.max(f.near + 1e-3, fog.far);
  }

  if (!fog.affectsSkybox) return;
  const amount = Math.min(1, Math.max(0, fog.skyboxFog));
  setColor(tmp, fog.color);
  const bg = scene.background;
  if (bg instanceof Texture) {
    if (amount >= 1) scene.background = tmp.clone();
    else scene.backgroundIntensity *= 1 - amount;
  } else {
    tmp2.copy(bg instanceof ThreeColor ? bg : clear);
    scene.background = tmp2.lerp(tmp, amount).clone();
  }
}
