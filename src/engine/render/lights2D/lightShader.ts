/**
 * The 2D light maths in KSL (ADR 0250, 0399): written once, compiled to WGSL and GLSL for the light pass and the lit
 * layered-quad material, and to JavaScript so tests check it against `lightShapes.ts` (what `Light2D.sampleAt` reads).
 * Renderer-neutral: Babylon's injection glue and entry points are in `render/babylon/lights2D*.ts`.
 *
 * - `myco2DPointAtten(local, shape, fexp)`: a point light's brightness at `local` (its node's XY), `shape` = inner and
 *   outer radius, half inner and half outer cone angle in degrees (half outer ≥ 180: all round), `fexp` the falloff
 *   exponent (`falloffExponent`).
 * - `myco2DLightDir(lightPos, height, world)`: the unit direction from a fragment toward a light raised `height` above
 *   the sprites' plane (z toward the viewer), for normal maps.
 * - `myco2DMask(mask, channel)`: a mask map channel by index (-1: none, 1).
 * - `myco2DDirectional(color, dirSum, n)`: the light a normal `n` takes from a batch's directional textures (their
 *   colour and intensity-weighted direction sum).
 * - `myco2DCompose(base, mul, add)`: a lit fragment's colour, `base·mul + add` (blend styles summed by the caller).
 */
import { shaderSource } from "../shaderSource/shaderSource";

export const LIGHT2D_SHADER = shaderSource(/* KSL */ `
FN(KF, myco2DPointAtten, KV2 local, KV4 shape, KF fexp) {
  VAR(KF, outer) = max(shape.y, 0.000001);
  VAR(KF, inner) = min(max(shape.x, 0.0), outer);
  VAR(KF, d) = length(local);
  if (d >= outer) {
    return 0.0;
  }
  VAR(KF, radial) = 1.0;
  if (d > inner) {
    radial = pow(clamp(1.0 - (d - inner) / max(outer - inner, 0.000001), 0.0, 1.0), fexp);
  }
  if (shape.w >= 180.0) {
    return radial;
  }
  VAR(KF, c) = 1.0;
  if (d > 0.000000001) {
    c = clamp(local.y / d, -1.0, 1.0);
  }
  VAR(KF, a) = acos(c) * 57.29577951308232;
  if (a >= shape.w) {
    return 0.0;
  }
  VAR(KF, cone) = 1.0;
  if (a > shape.z) {
    VAR(KF, t) = 1.0 - (a - shape.z) / max(shape.w - shape.z, 0.000001);
    cone = t * t * (3.0 - 2.0 * t);
  }
  return radial * cone;
}

FN(KV3, myco2DLightDir, KV2 lightPos, KF height, KV2 world) {
  return normalize(KV3(lightPos.x - world.x, lightPos.y - world.y, max(height, 0.0001)));
}

FN(KF, myco2DMask, KV4 mask, KF channel) {
  if (channel < -0.5) {
    return 1.0;
  }
  if (channel < 0.5) {
    return mask.x;
  }
  if (channel < 1.5) {
    return mask.y;
  }
  if (channel < 2.5) {
    return mask.z;
  }
  return mask.w;
}

FN(KV3, myco2DDirectional, KV3 color, KV3 dirSum, KV3 n) {
  VAR(KF, l) = length(dirSum);
  if (l < 0.00001) {
    return KV3(0.0, 0.0, 0.0);
  }
  return color * max(dot(n, dirSum * (1.0 / l)), 0.0);
}

FN(KV3, myco2DCompose, KV3 base, KV3 mul, KV3 add) {
  return base * mul + add;
}
`);
