/**
 * The sky asset format (ADR 0112): `*.sky.json` files describing a procedural sky in layers — a
 * physically based atmosphere or a simple gradient, sun and moon discs, cloud layers, stars, a
 * horizon blend towards the World's fog, exposure, and how the sky lights the scene.
 *
 * Plain data only (no Babylon types; ADR 0010). Colours are `#rrggbb` sRGB strings, angles are
 * degrees, times are hours. Parsing is lenient like the other JSON assets: a bad or missing value
 * reads as its default and is reported, never thrown.
 */

export const SKY_FORMAT = "myco.sky@1";

/** The most cloud layers a sky draws. */
export const MAX_CLOUD_LAYERS = 2;

export type SkyMode = "atmosphere" | "gradient";
export type SunPlacement = "timeOfDay" | "manual";

export interface SkySun {
  /** `timeOfDay` places the sun from the clock, latitude and date; `manual` from elevation and azimuth. */
  placement: SunPlacement;
  /** Local solar time in hours, 0–24 (12 = noon). */
  timeOfDay: number;
  /** Degrees north (positive) or south of the equator, -90–90. */
  latitude: number;
  /** Day of the year, 1–365 (172 ≈ the June solstice). Sets the sun's height through the year and the moon's phase. */
  dayOfYear: number;
  /** Rotates the compass: degrees from the World's -Z axis to north, clockwise seen from above. */
  northOffset: number;
  /** `manual` placement: degrees above the horizon, -90–90. */
  elevation: number;
  /** `manual` placement: degrees clockwise from north, seen from above. */
  azimuth: number;
}

export interface SkyAtmosphere {
  /** Air (Rayleigh) scattering, relative to Earth's (1): more is bluer by day and redder at sunset. */
  rayleigh: number;
  /** Haze (Mie) scattering, relative to a clear day's (1): more is whiter and hazier around the sun. */
  mie: number;
  /** How forward the haze scatters, 0–0.99 (0.76 = typical). */
  mieAnisotropy: number;
  /** The ground below the horizon. */
  groundColor: string;
}

export interface SkyGradient {
  zenith: string;
  horizon: string;
  ground: string;
  /** How tight the horizon band is: 1 = a smooth fade, higher = a sharper horizon. */
  sharpness: number;
}

export interface SkySunDisc {
  enabled: boolean;
  /** Angular diameter in degrees (the real sun is about 0.53). */
  size: number;
  /** Strength of the halo around the disc, 0–1. */
  glow: number;
  color: string;
  /** Brightness of the disc relative to the sky. */
  intensity: number;
}

export interface SkyMoon {
  enabled: boolean;
  /** Angular diameter in degrees. */
  size: number;
  glow: number;
  color: string;
  intensity: number;
  /** Phase from the day of the year (a 29.5-day cycle) rather than `phase`. */
  autoPhase: boolean;
  /** 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter. */
  phase: number;
  /** An optional image wrapped on the disc (asset path); empty for a plain disc. */
  texture: string;
}

export interface SkyCloudLayer {
  enabled: boolean;
  /** How much of the sky is covered, 0–1. */
  coverage: number;
  /** How thick and opaque the clouds are, 0–1. */
  density: number;
  /** Size of the cloud shapes (larger = bigger clouds). */
  scale: number;
  /** Drift speed (cloud widths per minute, roughly). */
  speed: number;
  /** Degrees clockwise from north the wind blows towards. */
  direction: number;
  /** Height of the layer in km: lower layers curve down to the horizon faster. */
  altitude: number;
  color: string;
}

export interface SkyStars {
  enabled: boolean;
  /** How many stars, 0–1. */
  density: number;
  brightness: number;
  /** How much the stars flicker, 0–1. */
  twinkle: number;
  /** An optional equirectangular Milky Way image (asset path). */
  milkyWay: string;
  milkyWayIntensity: number;
}

export interface SkyHorizon {
  /** How much the horizon fades to the World's Fog colour (or `color` without a Fog), 0–1. */
  fogBlend: number;
  /** Degrees above the horizon the blend reaches. */
  height: number;
  /** The blend colour when the World has no Fog. */
  color: string;
}

export interface SkyLighting {
  /** Point the World's main directional light along the sun (the moon at night), with its colour. */
  driveSunLight: boolean;
  /** The driven light's intensity at noon on a clear day. */
  sunIntensity: number;
  /** The driven light's intensity under a full moon. */
  moonIntensity: number;
  /** Bake the sky to a cubemap for image-based lighting and reflections. */
  bake: boolean;
  /** Pixels per side of each cube face of the bake: 32–512. */
  bakeSize: number;
  /** Rebake when the time of day has moved this many hours since the last bake. */
  rebakeHours: number;
  /** At most one rebake per this many seconds while settings change. */
  rebakeInterval: number;
}

export interface SkySettings {
  mode: SkyMode;
  sun: SkySun;
  atmosphere: SkyAtmosphere;
  gradient: SkyGradient;
  sunDisc: SkySunDisc;
  moon: SkyMoon;
  clouds: SkyCloudLayer[];
  stars: SkyStars;
  horizon: SkyHorizon;
  /** Exposure in stops (0 = unchanged, +1 = twice as bright). */
  exposure: number;
  lighting: SkyLighting;
}

export function defaultCloudLayer(): SkyCloudLayer {
  return { enabled: true, coverage: 0.4, density: 0.6, scale: 1, speed: 1, direction: 60, altitude: 2, color: "#ffffff" };
}

/** A clear midsummer morning at mid latitudes. */
export function defaultSky(): SkySettings {
  return {
    mode: "atmosphere",
    sun: { placement: "timeOfDay", timeOfDay: 10, latitude: 45, dayOfYear: 172, northOffset: 0, elevation: 45, azimuth: 135 },
    atmosphere: { rayleigh: 1, mie: 1, mieAnisotropy: 0.76, groundColor: "#59564f" },
    gradient: { zenith: "#2f6fc4", horizon: "#bcd6ee", ground: "#4d4a44", sharpness: 2 },
    sunDisc: { enabled: true, size: 0.8, glow: 0.4, color: "#fff6e6", intensity: 1 },
    moon: { enabled: true, size: 1.6, glow: 0.3, color: "#e6ecff", intensity: 1, autoPhase: false, phase: 0.5, texture: "" },
    clouds: [defaultCloudLayer()],
    stars: { enabled: true, density: 0.5, brightness: 1, twinkle: 0.5, milkyWay: "", milkyWayIntensity: 0.5 },
    horizon: { fogBlend: 0, height: 10, color: "#c8d2dc" },
    exposure: 0,
    lighting: { driveSunLight: true, sunIntensity: 3, moonIntensity: 0.15, bake: true, bakeSize: 128, rebakeHours: 0.25, rebakeInterval: 0.5 },
  };
}

export interface SkyProblem {
  severity: "warning" | "error";
  message: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

/**
 * Read a sky asset. Unknown keys are ignored; bad values read as defaults with a warning. Throws
 * nothing: a file that isn't a sky at all reads as the default sky with an error problem.
 */
export function parseSky(raw: unknown, path = "sky"): { settings: SkySettings; problems: SkyProblem[] } {
  const settings = defaultSky();
  const problems: SkyProblem[] = [];
  const warn = (key: string, why: string) => problems.push({ severity: "warning", message: `${path}: ${key} ${why}; using the default.` });
  if (!isObj(raw)) {
    problems.push({ severity: "error", message: `${path} isn't a sky asset (expected a JSON object).` });
    return { settings, problems };
  }
  if (raw.format !== undefined && raw.format !== SKY_FORMAT) problems.push({ severity: "warning", message: `${path}: unknown format "${String(raw.format)}"; reading it as ${SKY_FORMAT}.` });

  // Copies the keys of `src` that match the type of the default's, clamping numbers.
  const group = <T extends object>(key: string, target: T, ranges: Partial<Record<keyof T, [number, number]>>, choices: Partial<Record<keyof T, readonly string[]>> = {}) => {
    const src = raw[key];
    if (src === undefined) return;
    if (!isObj(src)) return warn(key, "isn't an object");
    readInto(`${key}.`, src, target, ranges, choices, warn);
  };

  if (raw.mode !== undefined) {
    if (raw.mode === "atmosphere" || raw.mode === "gradient") settings.mode = raw.mode;
    else warn("mode", 'isn\'t "atmosphere" or "gradient"');
  }
  group("sun", settings.sun, { timeOfDay: [0, 24], latitude: [-90, 90], dayOfYear: [1, 365], northOffset: [-360, 360], elevation: [-90, 90], azimuth: [-360, 360] }, { placement: ["timeOfDay", "manual"] });
  group("atmosphere", settings.atmosphere, { rayleigh: [0, 10], mie: [0, 50], mieAnisotropy: [0, 0.99] });
  group("gradient", settings.gradient, { sharpness: [0.1, 32] });
  group("sunDisc", settings.sunDisc, { size: [0, 20], glow: [0, 1], intensity: [0, 100] });
  group("moon", settings.moon, { size: [0, 20], glow: [0, 1], intensity: [0, 100], phase: [0, 1] });
  group("stars", settings.stars, { density: [0, 1], brightness: [0, 100], twinkle: [0, 1], milkyWayIntensity: [0, 100] });
  group("horizon", settings.horizon, { fogBlend: [0, 1], height: [0, 90] });
  group("lighting", settings.lighting, { sunIntensity: [0, 100], moonIntensity: [0, 100], bakeSize: [32, 512], rebakeHours: [0, 24], rebakeInterval: [0, 60] });
  settings.lighting.bakeSize = bakeSizeOf(settings.lighting.bakeSize);
  if (raw.exposure !== undefined) {
    if (typeof raw.exposure === "number" && Number.isFinite(raw.exposure)) settings.exposure = clamp(raw.exposure, -16, 16);
    else warn("exposure", "isn't a number");
  }
  if (raw.clouds !== undefined) {
    if (!Array.isArray(raw.clouds)) warn("clouds", "isn't a list");
    else {
      if (raw.clouds.length > MAX_CLOUD_LAYERS) problems.push({ severity: "warning", message: `${path}: only the first ${MAX_CLOUD_LAYERS} cloud layers are drawn.` });
      settings.clouds = raw.clouds.slice(0, MAX_CLOUD_LAYERS).map((c, i) => {
        const layer = defaultCloudLayer();
        if (!isObj(c)) warn(`clouds[${i}]`, "isn't an object");
        else readInto(`clouds[${i}].`, c, layer, { coverage: [0, 1], density: [0, 1], scale: [0.05, 20], speed: [-100, 100], direction: [-360, 360], altitude: [0.1, 20] }, {}, warn);
        return layer;
      });
    }
  }
  return { settings, problems };
}

function readInto<T extends object>(
  prefix: string,
  src: Record<string, unknown>,
  target: T,
  ranges: Partial<Record<keyof T, [number, number]>>,
  choices: Partial<Record<keyof T, readonly string[]>>,
  warn: (key: string, why: string) => void,
): void {
  const t = target as Record<string, unknown>;
  for (const k of Object.keys(t)) {
    if (!(k in src)) continue;
    const v = src[k];
    const def = t[k];
    const range = ranges[k as keyof T];
    const choice = choices[k as keyof T];
    if (typeof def === "number") {
      if (typeof v === "number" && Number.isFinite(v)) t[k] = range ? clamp(v, range[0], range[1]) : v;
      else warn(prefix + k, "isn't a number");
    } else if (typeof def === "boolean") {
      if (typeof v === "boolean") t[k] = v;
      else warn(prefix + k, "isn't true or false");
    } else if (typeof def === "string") {
      if (typeof v !== "string") warn(prefix + k, "isn't text");
      else if (choice && !choice.includes(v)) warn(prefix + k, `isn't one of ${choice.join(", ")}`);
      else if (def.startsWith("#") && !HEX.test(v)) warn(prefix + k, "isn't a #rrggbb colour");
      else t[k] = v;
    }
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The power of two nearest `size` within 32–512 (cube faces must be square powers of two to mip). */
export function bakeSizeOf(size: number): number {
  const p = Math.round(Math.log2(clamp(size || 128, 32, 512)));
  return 2 ** p;
}

/** The file text for a sky asset: stable key order, two-space indent, trailing newline. */
export function formatSky(settings: SkySettings): string {
  return `${JSON.stringify({ format: SKY_FORMAT, ...settings }, null, 2)}\n`;
}

/** A deep copy of a sky's settings. */
export const cloneSky = (s: SkySettings): SkySettings => structuredClone(s);

/** True for a sky asset path. */
export const isSkyPath = (path: string): boolean => /\.sky\.json$/i.test(path.split(/[?#]/)[0]!);

/** `#rrggbb` (sRGB) to linear RGB 0–1; bad text reads as black. */
export function hexToLinear(hex: string): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  if (!HEX.test(hex)) return out;
  for (let i = 0; i < 3; i++) {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    out[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return out;
}

/** Linear RGB 0–1 to `#rrggbb` (sRGB), clamped. */
export function linearToHex(rgb: readonly number[]): string {
  let s = "#";
  for (let i = 0; i < 3; i++) {
    const c = clamp(rgb[i] ?? 0, 0, 1);
    const e = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
    s += Math.round(e * 255)
      .toString(16)
      .padStart(2, "0");
  }
  return s;
}
