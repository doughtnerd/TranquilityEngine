/**
 * Sky maths shared by the renderer, the editor and tests (ADR 0112): where the sun and moon are for a
 * time of day, latitude and date; the light they cast through the atmosphere; the star field's
 * rotation; and when a baked sky is stale. Pure functions, no renderer types.
 *
 * World axes: Y up, -Z north (before `northOffset`), +X east, so a camera looking down -Z faces north.
 */
import { hexToLinear, type SkySettings } from "./skyFormat";

export type Vec3 = [number, number, number];

const RAD = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** A unit vector towards a point `elevation` degrees up and `azimuth` degrees clockwise from north. */
export function directionFromAngles(elevation: number, azimuth: number, northOffset = 0): Vec3 {
  const el = elevation * RAD;
  const az = (azimuth + northOffset) * RAD;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}

/** The sun's declination in degrees on a day of the year. */
export function solarDeclination(dayOfYear: number): number {
  return -23.44 * Math.cos((2 * Math.PI * (dayOfYear + 10)) / 365);
}

/**
 * Elevation and azimuth (degrees) of a body at `declination`, seen from `latitude`, `hourAngle`
 * degrees past its highest point (negative before it).
 */
export function horizontalAngles(latitude: number, declination: number, hourAngle: number): { elevation: number; azimuth: number } {
  const phi = latitude * RAD;
  const dec = declination * RAD;
  const h = hourAngle * RAD;
  const sinEl = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h);
  const elevation = Math.asin(clamp(sinEl, -1, 1)) / RAD;
  // Azimuth from south, then from north (clockwise seen from above).
  const fromSouth = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)) / RAD;
  const azimuth = (((fromSouth + 180) % 360) + 360) % 360;
  return { elevation, azimuth };
}

/** The sun's elevation and azimuth for a sky's settings at `timeOfDay` (hours). */
export function sunAngles(sky: SkySettings, timeOfDay = sky.sun.timeOfDay): { elevation: number; azimuth: number } {
  const s = sky.sun;
  if (s.placement === "manual") return { elevation: s.elevation, azimuth: s.azimuth };
  return horizontalAngles(s.latitude, solarDeclination(s.dayOfYear), 15 * (timeOfDay - 12));
}

/** The length of a lunar month in days. */
export const SYNODIC_MONTH = 29.530588;

/** The moon's phase, 0–1 (0 new, 0.5 full). */
export function moonPhase(sky: SkySettings): number {
  if (!sky.moon.autoPhase) return sky.moon.phase;
  const p = (sky.sun.dayOfYear + 8) / SYNODIC_MONTH;
  return p - Math.floor(p);
}

/**
 * The moon's elevation and azimuth: it trails the sun by `phase` of a day (opposite it when full),
 * with its declination mirrored from the sun's as it goes round. In manual placement it sits opposite
 * the sun's azimuth, rotated by the phase.
 */
export function moonAngles(sky: SkySettings, timeOfDay = sky.sun.timeOfDay): { elevation: number; azimuth: number } {
  const p = moonPhase(sky);
  const s = sky.sun;
  if (s.placement === "manual") {
    const sun = sunAngles(sky, timeOfDay);
    return { elevation: -sun.elevation * Math.cos(2 * Math.PI * (p - 0.5)) + 0.0001, azimuth: sun.azimuth + 360 * p };
  }
  const dec = solarDeclination(s.dayOfYear) * Math.cos(2 * Math.PI * p);
  return horizontalAngles(s.latitude, dec, 15 * (timeOfDay - 12) - 360 * p);
}

/** Unit vectors towards the sun and the moon. */
export function bodyDirections(sky: SkySettings, timeOfDay = sky.sun.timeOfDay): { sun: Vec3; moon: Vec3 } {
  const sun = sunAngles(sky, timeOfDay);
  const moon = moonAngles(sky, timeOfDay);
  return { sun: directionFromAngles(sun.elevation, sun.azimuth, sky.sun.northOffset), moon: directionFromAngles(moon.elevation, moon.azimuth, sky.sun.northOffset) };
}

// --- Atmosphere --------------------------------------------------------------------------------------

/** Atmosphere constants shared with the sky shader (metres, per metre). */
export const ATMOSPHERE = {
  earthRadius: 6371e3,
  atmosphereRadius: 6471e3,
  viewerHeight: 1000,
  rayleigh: [5.5e-6, 13.0e-6, 22.4e-6] as Vec3,
  rayleighHeight: 8e3,
  mie: 21e-6,
  mieHeight: 1.2e3,
} as const;

/**
 * How much sunlight gets through the atmosphere along a ray `elevation` degrees up from the viewer,
 * per channel (1 = all). Below the horizon the ray is held just above it (the light fades out
 * separately, see `skyLight`).
 */
export function transmittance(elevation: number, rayleighScale = 1, mieScale = 1): Vec3 {
  const A = ATMOSPHERE;
  const el = Math.max(elevation, 0.5) * RAD;
  const dy = Math.sin(el);
  const dz = Math.cos(el);
  const oy = A.earthRadius + A.viewerHeight;
  // Distance to the top of the atmosphere from (0, oy) along (dz, dy).
  const b = oy * dy;
  const c = oy * oy - A.atmosphereRadius * A.atmosphereRadius;
  const t = -b + Math.sqrt(b * b - c);
  const steps = 32;
  const ds = t / steps;
  let odR = 0;
  let odM = 0;
  for (let i = 0; i < steps; i++) {
    const s = (i + 0.5) * ds;
    const y = oy + dy * s;
    const z = dz * s;
    const h = Math.hypot(y, z) - A.earthRadius;
    odR += Math.exp(-h / A.rayleighHeight) * ds;
    odM += Math.exp(-h / A.mieHeight) * ds;
  }
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) out[i] = Math.exp(-(A.rayleigh[i] * rayleighScale * odR + A.mie * 1.1 * mieScale * odM));
  return out;
}

export interface SkyLight {
  /** Unit vector towards the light (the sun, or the moon at night). */
  direction: Vec3;
  /** Linear colour, brightest channel 1. */
  color: Vec3;
  intensity: number;
  /** Which body it is. */
  body: "sun" | "moon";
}

/**
 * The light the sky casts on the scene: the sun through the atmosphere, dimmed by cloud cover and
 * fading out at the horizon; the moon when it's brighter (at night). Gradient skies take the sun disc's
 * colour with a warm tint near the horizon.
 */
export function skyLight(sky: SkySettings, timeOfDay = sky.sun.timeOfDay): SkyLight {
  const { sun, moon } = bodyDirections(sky, timeOfDay);
  const sunEl = Math.asin(clamp(sun[1], -1, 1)) / RAD;
  const moonEl = Math.asin(clamp(moon[1], -1, 1)) / RAD;
  const cover = sky.clouds.reduce((m, c) => (c.enabled ? Math.max(m, c.coverage * (0.4 + 0.6 * c.density)) : m), 0);
  const cloudDim = 1 - 0.75 * cover;
  const disc = hexToLinear(sky.sunDisc.color);
  let sunColor: Vec3;
  let sunScale: number;
  if (sky.mode === "atmosphere") {
    const t = transmittance(sunEl, sky.atmosphere.rayleigh, sky.atmosphere.mie);
    const t0 = transmittance(90, sky.atmosphere.rayleigh, sky.atmosphere.mie);
    sunColor = [t[0] / t0[0], t[1] / t0[1], t[2] / t0[2]];
    sunScale = (t[0] + t[1] + t[2]) / (t0[0] + t0[1] + t0[2]);
  } else {
    const warm = 1 - smoothstep(0, 20, sunEl);
    sunColor = [1, 1 - 0.3 * warm, 1 - 0.6 * warm];
    sunScale = 0.4 + 0.6 * smoothstep(0, 30, sunEl);
  }
  const m = Math.max(sunColor[0], sunColor[1], sunColor[2], 1e-6);
  sunColor = [(sunColor[0] / m) * (0.5 + 0.5 * disc[0]), (sunColor[1] / m) * (0.5 + 0.5 * disc[1]), (sunColor[2] / m) * (0.5 + 0.5 * disc[2])];
  const sunIntensity = sky.lighting.sunIntensity * sunScale * smoothstep(-2, 3, sunEl) * cloudDim;

  const p = moonPhase(sky);
  const lit = 0.5 * (1 - Math.cos(2 * Math.PI * p));
  const moonIntensity = sky.moon.enabled ? sky.lighting.moonIntensity * lit * smoothstep(-2, 5, moonEl) * cloudDim * (1 - smoothstep(-8, 0, sunEl)) : 0;
  if (moonIntensity > sunIntensity) {
    const mc = hexToLinear(sky.moon.color);
    const mm = Math.max(mc[0], mc[1], mc[2], 1e-6);
    return { direction: moon, color: [mc[0] / mm, mc[1] / mm, mc[2] / mm], intensity: moonIntensity, body: "moon" };
  }
  return { direction: sun, color: sunColor, intensity: sunIntensity, body: "sun" };
}

/**
 * The star field's rotation as a column-major 3×3 matrix taking a world direction into star-sphere
 * coordinates: the sky turns about the celestial pole (`latitude` degrees up, due north) once a
 * sidereal day, drifting about a degree a day through the year.
 */
export function starRotation(sky: SkySettings, timeOfDay = sky.sun.timeOfDay): number[] {
  const pole = directionFromAngles(sky.sun.placement === "manual" ? 50 : sky.sun.latitude, 0, sky.sun.northOffset);
  const angle = (-(timeOfDay * 15 + sky.sun.dayOfYear * 0.9856) * RAD) % (2 * Math.PI);
  // Rodrigues' rotation about `pole`.
  const [x, y, z] = pole;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [t * x * x + c, t * x * y + s * z, t * x * z - s * y, t * x * y - s * z, t * y * y + c, t * y * z + s * x, t * x * z + s * y, t * y * z - s * x, t * z * z + c];
}

/** The settings that change a bake, as text: everything but the time of day (and the rebake policy). */
export function bakeSignature(sky: SkySettings): string {
  const { sun, lighting, ...rest } = sky;
  return JSON.stringify([rest, { ...sun, timeOfDay: 0 }, lighting.bakeSize]);
}

/** Hours between two times of day, the short way round the clock. */
export function hoursApart(a: number, b: number): number {
  const d = Math.abs((((a - b) % 24) + 24) % 24);
  return Math.min(d, 24 - d);
}

/**
 * When to rebake a sky (ADR 0112): at once the first time, then after its settings change or its time
 * of day moves `rebakeHours` from the last bake, no more often than once per `rebakeInterval` seconds.
 */
export class SkyBakeScheduler {
  private signature: string | null = null;
  private bakedTime = 0;
  private lastBake = -Infinity;
  private dirty = true;

  /** Forget the last bake: the next `update` bakes. */
  invalidate(): void {
    this.dirty = true;
    this.lastBake = -Infinity;
  }

  /** Whether to bake now (`now` in seconds); counts the bake as done when it says yes. */
  update(now: number, sky: SkySettings, timeOfDay: number): boolean {
    const signature = bakeSignature(sky);
    if (signature !== this.signature) this.dirty = true;
    const hours = sky.lighting.rebakeHours;
    const moved = sky.sun.placement === "timeOfDay" && hours > 0 && hoursApart(timeOfDay, this.bakedTime) >= hours;
    if (!this.dirty && !moved) return false;
    if (now - this.lastBake < sky.lighting.rebakeInterval) return false;
    this.signature = signature;
    this.bakedTime = timeOfDay;
    this.lastBake = now;
    this.dirty = false;
    return true;
  }
}
