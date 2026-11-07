/**
 * Packs a sky's settings, time and the World's fog into the sky shader's vec4 uniforms (ADR 0112;
 * `SKY_UNIFORMS` in `skyShader.ts` lists each one). No Babylon types, so it's tested headless.
 */
import { hexToLinear, type SkySettings } from "../../../sky/skyFormat";
import { bodyDirections, moonPhase, skyLight, starRotation, transmittance } from "../../../sky/skyMath";
import { SKY_UNIFORMS, type SkyUniform } from "./skyShader";

/** Sunlight's radiance in the atmosphere integral: a clear noon zenith comes out near 0.4 (linear). */
export const SUN_RADIANCE = 30;

export interface SkyFrame {
  settings: SkySettings;
  /** Time of day in hours. */
  time: number;
  /** Seconds of animation (clouds drift, stars twinkle). */
  seconds: number;
  /** Degrees added to the sky's north offset (the Environment's `rotation`). */
  rotation: number;
  /** Multiplies the drawn sky (the Environment's `skyboxIntensity`); 1 when baking. */
  intensity: number;
  /** The World's fog: its linear colour and how much it covers the whole sky (ADR 0071); null without one. */
  fog: { color: readonly number[]; amount: number } | null;
  /** Baking a cube face: no discs or stars, and Z mirrored for Babylon's left-handed cube lookups. */
  baking: boolean;
  moonTexture: boolean;
  milkyWayTexture: boolean;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The uniforms in `SKY_UNIFORMS` order, four floats each. Reuses `out` when given. */
export function packSkyUniforms(f: SkyFrame, out = new Float32Array(SKY_UNIFORMS.length * 4)): Float32Array {
  const s = f.settings;
  // The Environment's rotation turns the whole sky, sun and moon included.
  const sky: SkySettings = f.rotation ? { ...s, sun: { ...s.sun, northOffset: s.sun.northOffset + f.rotation } } : s;
  const { sun, moon } = bodyDirections(sky, f.time);
  const sunEl = (Math.asin(Math.max(-1, Math.min(1, sun[1]))) * 180) / Math.PI;
  const light = skyLight(sky, f.time);
  const day = smoothstep(-6, 10, sunEl);
  const set = (name: SkyUniform, x: number, y = 0, z = 0, w = 0) => {
    const o = SKY_UNIFORMS.indexOf(name) * 4;
    out[o] = x;
    out[o + 1] = y;
    out[o + 2] = z;
    out[o + 3] = w;
  };
  const set3 = (name: SkyUniform, c: readonly number[], w = 0) => set(name, c[0], c[1], c[2], w);
  const atmosphere = s.mode === "atmosphere";

  set("sunDir", sun[0], sun[1], sun[2], atmosphere ? 0 : 1);
  set("moonDir", moon[0], moon[1], moon[2], f.baking ? 1 : 0);

  const disc = hexToLinear(s.sunDisc.color);
  let tint: number[] = disc;
  if (atmosphere) {
    const t = transmittance(sunEl, s.atmosphere.rayleigh, s.atmosphere.mie);
    const t0 = transmittance(90, s.atmosphere.rayleigh, s.atmosphere.mie);
    tint = disc.map((c, i) => c * (t[i] / t0[i]));
  } else {
    const warm = 1 - smoothstep(0, 20, sunEl);
    tint = [disc[0], disc[1] * (1 - 0.3 * warm), disc[2] * (1 - 0.6 * warm)];
  }
  const rad = (deg: number) => Math.cos((Math.max(deg, 0.01) * Math.PI) / 360);
  set("sunDisc", rad(s.sunDisc.size), s.sunDisc.glow, s.sunDisc.enabled ? s.sunDisc.intensity : 0);
  set3("sunTint", tint, SUN_RADIANCE);
  set("moonDisc", rad(s.moon.size), s.moon.glow, s.moon.enabled ? s.moon.intensity : 0, f.moonTexture ? 1 : 0);
  set3("moonTint", hexToLinear(s.moon.color), 0.03);
  set("atmos", s.atmosphere.rayleigh, s.atmosphere.mie, s.atmosphere.mieAnisotropy, 1000);

  const ground = hexToLinear(s.atmosphere.groundColor);
  const groundLight = day * (0.15 + 0.6 * Math.max(sun[1], 0)) + 0.01;
  set3("groundCol", ground.map((c) => c * groundLight));
  set3("zenithCol", hexToLinear(s.gradient.zenith), s.gradient.sharpness);
  set3("horizonCol", hexToLinear(s.gradient.horizon));
  set3("groundGrad", hexToLinear(s.gradient.ground));

  // Clouds: the light on them follows the sky's light; at night they take a faint blue ambient.
  const sunScale = s.lighting.sunIntensity > 0 ? light.intensity / s.lighting.sunIntensity : day;
  const lit = light.body === "sun" ? light.color.map((c) => c * 0.9 * Math.min(1.5, sunScale)) : light.color.map((c) => c * 0.05);
  set3("cloudLit", lit);
  const amb = [0.02 + 0.33 * day, 0.025 + 0.39 * day, 0.035 + 0.47 * day];
  set3("cloudAmb", amb);
  const layers: [SkyUniform, SkyUniform, SkyUniform][] = [
    ["cloudA", "cloudADrift", "cloudACol"],
    ["cloudB", "cloudBDrift", "cloudBCol"],
  ];
  for (let i = 0; i < layers.length; i++) {
    const [shape, drift, col] = layers[i];
    const c = s.clouds[i];
    if (!c || !c.enabled) {
      set(shape, 0);
      set(drift, 0, 0, 0);
      set(col, 0);
      continue;
    }
    const wind = ((c.direction + sky.sun.northOffset) * Math.PI) / 180;
    const travel = (c.speed * f.seconds) / 60;
    set(shape, c.coverage, c.density, 1.2 / Math.max(c.scale, 0.05), 0.08 + 0.04 * c.altitude);
    set(drift, -Math.sin(wind) * travel + i * 37.3, Math.cos(wind) * travel + i * 11.7, 1);
    set3(col, hexToLinear(c.color));
  }

  const st = s.stars;
  set("stars", 1 - 0.06 * st.density, st.enabled ? st.brightness : 0, st.twinkle, f.seconds % 10000);
  set("milky", st.milkyWayIntensity, st.enabled && f.milkyWayTexture ? 1 : 0);
  const r = starRotation(sky, f.time);
  set("starRot0", r[0], r[1], r[2]);
  set("starRot1", r[3], r[4], r[5]);
  set("starRot2", r[6], r[7], r[8]);

  // The World's Fog colour is as authored; the asset's own horizon colour dims with daylight.
  const fogColor = f.fog ? f.fog.color : hexToLinear(s.horizon.color).map((c) => c * Math.max(day, 0.03));
  set3("fogCol", fogColor, s.horizon.fogBlend);
  set("fogShape", Math.sin((Math.max(0.5, s.horizon.height) * Math.PI) / 180), f.fog ? Math.min(1, Math.max(0, f.fog.amount)) : 0);

  const moonLit = s.moon.enabled ? 0.5 * (1 - Math.cos(2 * Math.PI * moonPhase(s))) : 0;
  const night = (1 - day) * (1 + 2 * moonLit);
  set("nightCol", 0.004 * night, 0.006 * night, 0.012 * night);
  set("skyOut", 2 ** s.exposure * (f.baking ? 1 : f.intensity), f.baking ? -1 : 1);
  return out;
}
