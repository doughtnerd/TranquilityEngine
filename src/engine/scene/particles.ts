/**
 * Particle effect assets (ADR 0057): `*.particles.json` files a ParticleSystem plays. An effect has
 * one or more emitters, each built from Unity-like modules. The format is ours: the render backend
 * translates it into three.quarks systems, which never appear in the file or the public API.
 *
 * ```jsonc
 * {
 *   "format": "myco.particles@1",
 *   "emitters": [{
 *     "name": "Sparks",
 *     "duration": 2, "looping": true, "prewarm": false, "startDelay": 0,
 *     "startLife": { "random": [0.5, 1] },        // a number value (see below), seconds
 *     "startSpeed": 4, "startSize": 0.1, "startRotation": 0,   // metres/s, metres, degrees
 *     "startColor": "#ffcc66ff",                  // a colour value (see below)
 *     "gravity": 1,                               // multiplier of 9.81 m/s² downwards
 *     "space": "world",                           // "local" | "world"
 *     "maxParticles": 500,
 *     "emission": { "rateOverTime": 40, "rateOverDistance": 0, "bursts": [{ "time": 0, "count": 30, "cycles": 1, "interval": 0.1, "probability": 1 }] },
 *     "shape": { "type": "cone", "radius": 0.2, "angle": 25, … },
 *     "behaviors": [{ "type": "sizeOverLife", "size": { "curve": [[0, 1], [1, 0]] } }],
 *     "subEmitters": [{ "emitter": "Embers", "trigger": "death", "probability": 1 }],
 *     "renderer": { "mode": "billboard", "material": "", "texture": "", "blending": "additive", … }
 *   }]
 * }
 * ```
 *
 * A number value is a constant, `{ "random": [a, b] }`, `{ "curve": [[t, v], …] }` (linear between
 * keys; `t` is 0–1 over the particle's life, or over the emitter's duration for start values), or
 * `{ "randomCurves": [curveA, curveB] }`. A colour value is `"#rrggbb[aa]"`, `{ "random": [a, b] }`,
 * `{ "gradient": { "colors": [[t, "#rrggbb"], …], "alphas": [[t, a], …] } }` or
 * `{ "randomGradients": [g1, g2] }`.
 */

export const PARTICLES_FORMAT = "myco.particles@1";
export const PARTICLES_SUFFIX = ".particles.json";

/** True for a particle effect asset path. */
export const isParticleEffectPath = (path: string): boolean => path.toLowerCase().endsWith(PARTICLES_SUFFIX);

/** A curve key: `[t, value]`, `t` from 0 to 1. */
export type CurveKey = [number, number];

/** A number that can vary: a constant, a random range, a curve, or a random value between two curves. */
export type ParticleNumber = number | { random: [number, number] } | { curve: CurveKey[] } | { randomCurves: [CurveKey[], CurveKey[]] };

/** A gradient: colour keys (`#rrggbb`) and alpha keys, each at `t` from 0 to 1. */
export interface ParticleGradient {
  colors: [number, string][];
  alphas: [number, number][];
}

/** A colour that can vary: `#rrggbb[aa]`, a random range, a gradient, or a random colour between two gradients. */
export type ParticleColor = string | { random: [string, string] } | { gradient: ParticleGradient } | { randomGradients: [ParticleGradient, ParticleGradient] };

export type ParticleNumberKind = "constant" | "random" | "curve" | "randomCurves";
export type ParticleColorKind = "constant" | "random" | "gradient" | "randomGradients";

export const numberKind = (v: ParticleNumber): ParticleNumberKind => (typeof v === "number" ? "constant" : "random" in v ? "random" : "curve" in v ? "curve" : "randomCurves");
export const colorKind = (v: ParticleColor): ParticleColorKind => (typeof v === "string" ? "constant" : "random" in v ? "random" : "gradient" in v ? "gradient" : "randomGradients");

export type ShapeType = "point" | "sphere" | "hemisphere" | "cone" | "circle" | "donut" | "rectangle" | "grid";
export const SHAPE_TYPES: readonly ShapeType[] = ["point", "sphere", "hemisphere", "cone", "circle", "donut", "rectangle", "grid"];
export type ShapeMode = "random" | "loop" | "pingpong" | "burst";

/** Where particles start, and which way they go. Emits along the shape's +Y axis (a cone opens up +Y). */
export interface ParticleShape {
  type: ShapeType;
  /** Sphere, hemisphere, cone, circle, donut: radius in metres. */
  radius: number;
  /** Cone: the cone's half angle in degrees. */
  angle: number;
  /** Sphere, hemisphere, cone, circle, donut: the part of the circle used, in degrees (360 = all). */
  arc: number;
  /** How deep into the shape particles start: 0 the surface only, 1 the whole volume. */
  thickness: number;
  /** Rectangle, grid: size in metres. */
  width: number;
  height: number;
  /** Donut: the tube's radius in metres. */
  donutRadius: number;
  /** Grid: columns and rows. */
  columns: number;
  rows: number;
  /** How positions around the arc are picked. */
  mode: ShapeMode;
  /** Loop and ping-pong: the step between positions, as a fraction of the arc (0 = continuous). */
  spread: number;
  /** The shape's offset and rotation (degrees) from the node. */
  position: [number, number, number];
  rotation: [number, number, number];
}

export interface ParticleBurst {
  /** Seconds into the emitter's cycle. */
  time: number;
  count: ParticleNumber;
  /** How many times it repeats, `interval` seconds apart. */
  cycles: number;
  interval: number;
  /** Chance it happens, 0–1. */
  probability: number;
}

export interface ParticleEmission {
  /** Particles per second. */
  rateOverTime: ParticleNumber;
  /** Particles per metre the emitter moves. */
  rateOverDistance: ParticleNumber;
  bursts: ParticleBurst[];
}

/** One step applied to every particle each frame, in list order. */
export type ParticleBehavior = { enabled?: boolean } & (
  | { type: "colorOverLife"; color: ParticleColor }
  | { type: "sizeOverLife"; size: ParticleNumber }
  /** Degrees per second. */
  | { type: "rotationOverLife"; speed: ParticleNumber }
  /** Multiplies the particle's speed. */
  | { type: "speedOverLife"; speed: ParticleNumber }
  /** Metres per second², in the simulation space. */
  | { type: "forceOverLife"; x: ParticleNumber; y: ParticleNumber; z: ParticleNumber }
  /** Pulls particles towards a point (in the simulation space). */
  | { type: "gravityPoint"; center: [number, number, number]; strength: number }
  | { type: "noise"; frequency: ParticleNumber; power: ParticleNumber; positionAmount: ParticleNumber; rotationAmount: ParticleNumber }
  | { type: "turbulence"; scale: [number, number, number]; octaves: number; velocity: [number, number, number]; timeScale: [number, number, number] }
  /** Degrees per second around `axis`. */
  | { type: "orbit"; speed: ParticleNumber; axis: [number, number, number] }
  /** Flipbook tile index over life. */
  | { type: "frameOverLife"; frame: ParticleNumber }
  | { type: "limitSpeed"; speed: ParticleNumber; dampen: number }
  | { type: "colorBySpeed"; color: ParticleColor; min: number; max: number }
  | { type: "sizeBySpeed"; size: ParticleNumber; min: number; max: number }
  /** Trails: width along the trail. */
  | { type: "widthOverLength"; width: ParticleNumber }
  /** Bounces off (or dies at) a horizontal plane `height` metres up, in the simulation space. */
  | { type: "collision"; height: number; bounce: number; kill: boolean }
);
export type ParticleBehaviorType = ParticleBehavior["type"];

export interface ParticleSubEmitter {
  /** The name of another emitter in the same effect. It then emits only when triggered. */
  emitter: string;
  trigger: "birth" | "death" | "frame";
  probability: number;
  /** Start the sub-emitter's particles moving with the parent particle. */
  inheritVelocity: boolean;
}

export type ParticleRenderMode = "billboard" | "stretched" | "horizontal" | "vertical" | "mesh" | "trail";
export type ParticleBlending = "additive" | "alpha" | "premultiplied";

export interface ParticleRenderer {
  mode: ParticleRenderMode;
  /** A material asset. Empty: an unlit material with `texture` and `blending`. */
  material: string;
  /** The particle texture (when no material is set). Empty: a soft round dot. */
  texture: string;
  blending: ParticleBlending;
  /** Flipbook: columns and rows of tiles in the texture. */
  tiles: [number, number];
  startTile: ParticleNumber;
  blendTiles: boolean;
  /** Mesh mode: a built-in mesh (`builtin:cube`…) or a model asset. */
  mesh: string;
  /** Stretched: stretch by speed, and by size. */
  speedScale: number;
  lengthScale: number;
  /** Trail: length in points. */
  trailLength: ParticleNumber;
  /** Higher draws later (on top of other transparent things). */
  renderOrder: number;
}

export interface ParticleEmitterSettings {
  name: string;
  enabled: boolean;
  /** Seconds per cycle. */
  duration: number;
  looping: boolean;
  /** Start as if a full cycle had already run (looping emitters). */
  prewarm: boolean;
  /** Seconds before emitting starts. */
  startDelay: number;
  startLife: ParticleNumber;
  startSpeed: ParticleNumber;
  startSize: ParticleNumber;
  /** Degrees. */
  startRotation: ParticleNumber;
  startColor: ParticleColor;
  /** Multiplier of 9.81 m/s² pulling down (world −Y). */
  gravity: number;
  /** World: particles stay where they were born as the node moves. Local: they move with it. */
  space: "local" | "world";
  maxParticles: number;
  emission: ParticleEmission;
  shape: ParticleShape;
  behaviors: ParticleBehavior[];
  subEmitters: ParticleSubEmitter[];
  renderer: ParticleRenderer;
}

export interface ParticleEffect {
  emitters: ParticleEmitterSettings[];
  /** Editor-only data (graph layout, ADR 0058); kept as it is and ignored by the engine. */
  editor?: Record<string, unknown>;
}

// --- defaults -------------------------------------------------------------------------------------

export const defaultShape = (): ParticleShape => ({
  type: "cone",
  radius: 0.2,
  angle: 20,
  arc: 360,
  thickness: 1,
  width: 1,
  height: 1,
  donutRadius: 0.1,
  columns: 5,
  rows: 5,
  mode: "random",
  spread: 0,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
});

export const defaultRenderer = (): ParticleRenderer => ({
  mode: "billboard",
  material: "",
  texture: "",
  blending: "additive",
  tiles: [1, 1],
  startTile: 0,
  blendTiles: false,
  mesh: "builtin:cube",
  speedScale: 0,
  lengthScale: 1,
  trailLength: 20,
  renderOrder: 0,
});

/** A new emitter: a gentle fountain of fading dots. */
export const defaultEmitter = (name = "Emitter"): ParticleEmitterSettings => ({
  name,
  enabled: true,
  duration: 5,
  looping: true,
  prewarm: false,
  startDelay: 0,
  startLife: { random: [1, 2] },
  startSpeed: { random: [1, 2] },
  startSize: { random: [0.1, 0.2] },
  startRotation: 0,
  startColor: "#ffffffff",
  gravity: 0,
  space: "world",
  maxParticles: 1000,
  emission: { rateOverTime: 20, rateOverDistance: 0, bursts: [] },
  shape: defaultShape(),
  behaviors: [{ type: "colorOverLife", color: { gradient: { colors: [[0, "#ffffff"], [1, "#ffffff"]], alphas: [[0, 1], [1, 0]] } } }],
  subEmitters: [],
  renderer: defaultRenderer(),
});

export const defaultParticleEffect = (): ParticleEffect => ({ emitters: [defaultEmitter()] });

/** A behaviour of `type` with sensible starting values. */
export function defaultBehavior(type: ParticleBehaviorType): ParticleBehavior {
  switch (type) {
    case "colorOverLife":
      return { type, color: { gradient: { colors: [[0, "#ffffff"], [1, "#ffffff"]], alphas: [[0, 1], [1, 0]] } } };
    case "sizeOverLife":
      return { type, size: { curve: [[0, 1], [1, 0]] } };
    case "rotationOverLife":
      return { type, speed: 90 };
    case "speedOverLife":
      return { type, speed: { curve: [[0, 1], [1, 0.2]] } };
    case "forceOverLife":
      return { type, x: 0, y: 1, z: 0 };
    case "gravityPoint":
      return { type, center: [0, 0, 0], strength: 2 };
    case "noise":
      return { type, frequency: 1, power: 1, positionAmount: 1, rotationAmount: 0 };
    case "turbulence":
      return { type, scale: [1, 1, 1], octaves: 2, velocity: [1, 1, 1], timeScale: [0.5, 0.5, 0.5] };
    case "orbit":
      return { type, speed: 90, axis: [0, 1, 0] };
    case "frameOverLife":
      return { type, frame: { curve: [[0, 0], [1, 3]] } };
    case "limitSpeed":
      return { type, speed: 1, dampen: 0.5 };
    case "colorBySpeed":
      return { type, color: { gradient: { colors: [[0, "#ffffff"], [1, "#ff8800"]], alphas: [[0, 1], [1, 1]] } }, min: 0, max: 5 };
    case "sizeBySpeed":
      return { type, size: { curve: [[0, 1], [1, 2]] }, min: 0, max: 5 };
    case "widthOverLength":
      return { type, width: { curve: [[0, 1], [1, 0]] } };
    case "collision":
      return { type, height: 0, bounce: 0.5, kill: false };
  }
}

export const BEHAVIOR_TYPES: readonly ParticleBehaviorType[] = [
  "colorOverLife",
  "sizeOverLife",
  "rotationOverLife",
  "speedOverLife",
  "forceOverLife",
  "gravityPoint",
  "noise",
  "turbulence",
  "orbit",
  "frameOverLife",
  "limitSpeed",
  "colorBySpeed",
  "sizeBySpeed",
  "widthOverLength",
  "collision",
];

/** A behaviour's name for menus and headings. */
export const BEHAVIOR_LABELS: Record<ParticleBehaviorType, string> = {
  colorOverLife: "Color over Lifetime",
  sizeOverLife: "Size over Lifetime",
  rotationOverLife: "Rotation over Lifetime",
  speedOverLife: "Speed over Lifetime",
  forceOverLife: "Force over Lifetime",
  gravityPoint: "Point Gravity",
  noise: "Noise",
  turbulence: "Turbulence",
  orbit: "Orbit",
  frameOverLife: "Flipbook over Lifetime",
  limitSpeed: "Limit Speed",
  colorBySpeed: "Color by Speed",
  sizeBySpeed: "Size by Speed",
  widthOverLength: "Trail Width",
  collision: "Plane Collision",
};

// --- evaluation (editor previews, tests) --------------------------------------------------------

/** A curve's value at `t` (linear between keys, flat beyond the ends). */
export function evalCurve(keys: readonly CurveKey[], t: number): number {
  if (!keys.length) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
    }
  }
  return keys[keys.length - 1][1];
}

/** `#rrggbb[aa]` as 0–1 sRGB components and alpha; bad input reads as opaque white. */
export function parseHexColor(hex: string): [number, number, number, number] {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return [1, 1, 1, 1];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, m[2] ? parseInt(m[2], 16) / 255 : 1];
}

/** 0–1 sRGB components (and alpha, written when below 1) as `#rrggbb[aa]`. */
export function hexColor(r: number, g: number, b: number, a = 1): string {
  const h = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}${a < 1 ? h(a) : ""}`;
}

/** A gradient's colour and alpha at `t`, as 0–1 sRGB components. */
export function evalGradient(g: ParticleGradient, t: number): [number, number, number, number] {
  const channel = (i: number) => evalCurve(g.colors.map(([k, c]) => [k, parseHexColor(c)[i]] as CurveKey), t);
  return [channel(0), channel(1), channel(2), g.alphas.length ? evalCurve(g.alphas, t) : 1];
}

// --- parsing ---------------------------------------------------------------------------------------

type Problems = string[];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function num(o: Record<string, unknown>, key: string, fallback: number, where: string, problems: Problems, min = -Infinity, max = Infinity): number {
  const v = o[key];
  if (v === undefined) return fallback;
  if (!finite(v)) {
    problems.push(`${where}: "${key}" should be a number.`);
    return fallback;
  }
  return Math.min(max, Math.max(min, v));
}

function bool(o: Record<string, unknown>, key: string, fallback: boolean, where: string, problems: Problems): boolean {
  const v = o[key];
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") {
    problems.push(`${where}: "${key}" should be true or false.`);
    return fallback;
  }
  return v;
}

function str(o: Record<string, unknown>, key: string, fallback: string, where: string, problems: Problems): string {
  const v = o[key];
  if (v === undefined) return fallback;
  if (typeof v !== "string") {
    problems.push(`${where}: "${key}" should be text.`);
    return fallback;
  }
  return v;
}

function choice<T extends string>(o: Record<string, unknown>, key: string, choices: readonly T[], fallback: T, where: string, problems: Problems): T {
  const v = o[key];
  if (v === undefined) return fallback;
  if (!choices.includes(v as T)) {
    problems.push(`${where}: "${key}" should be one of ${choices.join(", ")}.`);
    return fallback;
  }
  return v as T;
}

function vec3(o: Record<string, unknown>, key: string, fallback: [number, number, number], where: string, problems: Problems): [number, number, number] {
  const v = o[key];
  if (v === undefined) return fallback;
  if (!Array.isArray(v) || v.length !== 3 || !v.every(finite)) {
    problems.push(`${where}: "${key}" should be [x, y, z].`);
    return fallback;
  }
  return [v[0], v[1], v[2]];
}

function curve(v: unknown): CurveKey[] | null {
  if (!Array.isArray(v) || !v.length) return null;
  const keys: CurveKey[] = [];
  for (const k of v) {
    if (!Array.isArray(k) || k.length !== 2 || !finite(k[0]) || !finite(k[1])) return null;
    keys.push([Math.min(1, Math.max(0, k[0])), k[1]]);
  }
  return keys.sort((a, b) => a[0] - b[0]);
}

/** A number value, or `fallback` (with a problem) if it isn't one. */
export function parseParticleNumber(v: unknown, fallback: ParticleNumber, where: string, problems: Problems): ParticleNumber {
  if (v === undefined) return fallback;
  if (finite(v)) return v;
  if (isObj(v)) {
    if (Array.isArray(v.random) && v.random.length === 2 && v.random.every(finite)) return { random: [v.random[0], v.random[1]] };
    const c = curve(v.curve);
    if (c) return { curve: c };
    if (Array.isArray(v.randomCurves) && v.randomCurves.length === 2) {
      const a = curve(v.randomCurves[0]);
      const b = curve(v.randomCurves[1]);
      if (a && b) return { randomCurves: [a, b] };
    }
  }
  problems.push(`${where} should be a number, { "random": [a, b] }, { "curve": [[t, v], …] } or { "randomCurves": [curve, curve] }.`);
  return fallback;
}

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

function gradient(v: unknown): ParticleGradient | null {
  if (!isObj(v) || !Array.isArray(v.colors)) return null;
  const colors: [number, string][] = [];
  for (const k of v.colors) {
    if (!Array.isArray(k) || k.length !== 2 || !finite(k[0]) || typeof k[1] !== "string" || !HEX.test(k[1])) return null;
    colors.push([Math.min(1, Math.max(0, k[0])), k[1].slice(0, 7).toLowerCase()]);
  }
  const alphas: [number, number][] = [];
  for (const k of Array.isArray(v.alphas) ? v.alphas : []) {
    if (!Array.isArray(k) || k.length !== 2 || !finite(k[0]) || !finite(k[1])) return null;
    alphas.push([Math.min(1, Math.max(0, k[0])), Math.min(1, Math.max(0, k[1]))]);
  }
  if (!colors.length) return null;
  return { colors: colors.sort((a, b) => a[0] - b[0]), alphas: alphas.sort((a, b) => a[0] - b[0]) };
}

/** A colour value, or `fallback` (with a problem) if it isn't one. */
export function parseParticleColor(v: unknown, fallback: ParticleColor, where: string, problems: Problems): ParticleColor {
  if (v === undefined) return fallback;
  if (typeof v === "string" && HEX.test(v)) return v.toLowerCase();
  if (isObj(v)) {
    if (Array.isArray(v.random) && v.random.length === 2 && v.random.every((c) => typeof c === "string" && HEX.test(c))) return { random: [(v.random[0] as string).toLowerCase(), (v.random[1] as string).toLowerCase()] };
    const g = gradient(v.gradient);
    if (g) return { gradient: g };
    if (Array.isArray(v.randomGradients) && v.randomGradients.length === 2) {
      const a = gradient(v.randomGradients[0]);
      const b = gradient(v.randomGradients[1]);
      if (a && b) return { randomGradients: [a, b] };
    }
  }
  problems.push(`${where} should be "#rrggbb[aa]", { "random": [a, b] }, { "gradient": {…} } or { "randomGradients": [g, g] }.`);
  return fallback;
}

function parseShape(raw: unknown, where: string, problems: Problems): ParticleShape {
  const d = defaultShape();
  if (raw === undefined) return d;
  if (!isObj(raw)) {
    problems.push(`${where} should be an object.`);
    return d;
  }
  return {
    type: choice(raw, "type", SHAPE_TYPES, d.type, where, problems),
    radius: num(raw, "radius", d.radius, where, problems, 0),
    angle: num(raw, "angle", d.angle, where, problems, 0, 90),
    arc: num(raw, "arc", d.arc, where, problems, 0, 360),
    thickness: num(raw, "thickness", d.thickness, where, problems, 0, 1),
    width: num(raw, "width", d.width, where, problems, 0),
    height: num(raw, "height", d.height, where, problems, 0),
    donutRadius: num(raw, "donutRadius", d.donutRadius, where, problems, 0),
    columns: Math.round(num(raw, "columns", d.columns, where, problems, 1)),
    rows: Math.round(num(raw, "rows", d.rows, where, problems, 1)),
    mode: choice(raw, "mode", ["random", "loop", "pingpong", "burst"] as const, d.mode, where, problems),
    spread: num(raw, "spread", d.spread, where, problems, 0, 1),
    position: vec3(raw, "position", d.position, where, problems),
    rotation: vec3(raw, "rotation", d.rotation, where, problems),
  };
}

function parseBehavior(raw: unknown, where: string, problems: Problems): ParticleBehavior | null {
  if (!isObj(raw) || typeof raw.type !== "string" || !BEHAVIOR_TYPES.includes(raw.type as ParticleBehaviorType)) {
    problems.push(`${where}: unknown behaviour${isObj(raw) && typeof raw.type === "string" ? ` "${raw.type}"` : ""}; it's left out.`);
    return null;
  }
  const d = defaultBehavior(raw.type as ParticleBehaviorType) as Record<string, unknown>;
  const out: Record<string, unknown> = { type: raw.type };
  if (raw.enabled === false) out.enabled = false;
  for (const [key, def] of Object.entries(d)) {
    if (key === "type") continue;
    const at = `${where} ${key}`;
    if (key === "color") out[key] = parseParticleColor(raw[key], def as ParticleColor, at, problems);
    else if (key === "kill") out[key] = bool(raw, key, def as boolean, where, problems);
    else if (Array.isArray(def)) out[key] = vec3(raw, key, def as [number, number, number], where, problems);
    else if (key === "strength" || key === "dampen" || key === "min" || key === "max" || key === "height" || key === "bounce" || key === "octaves") out[key] = num(raw, key, def as number, where, problems);
    else out[key] = parseParticleNumber(raw[key], def as ParticleNumber, at, problems);
  }
  return out as ParticleBehavior;
}

function parseRenderer(raw: unknown, where: string, problems: Problems): ParticleRenderer {
  const d = defaultRenderer();
  if (raw === undefined) return d;
  if (!isObj(raw)) {
    problems.push(`${where} should be an object.`);
    return d;
  }
  const tiles = raw.tiles;
  const tilesOk = Array.isArray(tiles) && tiles.length === 2 && tiles.every((n) => finite(n) && n >= 1);
  if (tiles !== undefined && !tilesOk) problems.push(`${where}: "tiles" should be [columns, rows], each at least 1.`);
  return {
    mode: choice(raw, "mode", ["billboard", "stretched", "horizontal", "vertical", "mesh", "trail"] as const, d.mode, where, problems),
    material: str(raw, "material", d.material, where, problems),
    texture: str(raw, "texture", d.texture, where, problems),
    blending: choice(raw, "blending", ["additive", "alpha", "premultiplied"] as const, d.blending, where, problems),
    tiles: tilesOk ? [Math.round(tiles[0] as number), Math.round(tiles[1] as number)] : d.tiles,
    startTile: parseParticleNumber(raw.startTile, d.startTile, `${where} startTile`, problems),
    blendTiles: bool(raw, "blendTiles", d.blendTiles, where, problems),
    mesh: str(raw, "mesh", d.mesh, where, problems),
    speedScale: num(raw, "speedScale", d.speedScale, where, problems),
    lengthScale: num(raw, "lengthScale", d.lengthScale, where, problems),
    trailLength: parseParticleNumber(raw.trailLength, d.trailLength, `${where} trailLength`, problems),
    renderOrder: num(raw, "renderOrder", d.renderOrder, where, problems),
  };
}

function parseEmitter(raw: unknown, index: number, problems: Problems): ParticleEmitterSettings | null {
  if (!isObj(raw)) {
    problems.push(`emitter ${index + 1} should be an object; it's left out.`);
    return null;
  }
  const d = defaultEmitter(`Emitter ${index + 1}`);
  const name = str(raw, "name", d.name, `emitter ${index + 1}`, problems) || d.name;
  const where = `emitter "${name}"`;
  const em = isObj(raw.emission) ? raw.emission : {};
  if (raw.emission !== undefined && !isObj(raw.emission)) problems.push(`${where}: "emission" should be an object.`);
  const bursts: ParticleBurst[] = [];
  for (const b of Array.isArray(em.bursts) ? em.bursts : []) {
    if (!isObj(b)) {
      problems.push(`${where}: a burst should be an object; it's left out.`);
      continue;
    }
    bursts.push({
      time: num(b, "time", 0, `${where} burst`, problems, 0),
      count: parseParticleNumber(b.count, 10, `${where} burst count`, problems),
      cycles: Math.round(num(b, "cycles", 1, `${where} burst`, problems, 1)),
      interval: num(b, "interval", 0.1, `${where} burst`, problems, 0),
      probability: num(b, "probability", 1, `${where} burst`, problems, 0, 1),
    });
  }
  const behaviors: ParticleBehavior[] = [];
  if (raw.behaviors !== undefined && !Array.isArray(raw.behaviors)) problems.push(`${where}: "behaviors" should be a list.`);
  for (const b of Array.isArray(raw.behaviors) ? raw.behaviors : []) {
    const parsed = parseBehavior(b, where, problems);
    if (parsed) behaviors.push(parsed);
  }
  const subEmitters: ParticleSubEmitter[] = [];
  for (const s of Array.isArray(raw.subEmitters) ? raw.subEmitters : []) {
    if (!isObj(s) || typeof s.emitter !== "string") {
      problems.push(`${where}: a sub-emitter needs an "emitter" name; it's left out.`);
      continue;
    }
    subEmitters.push({
      emitter: s.emitter,
      trigger: choice(s, "trigger", ["birth", "death", "frame"] as const, "death", `${where} sub-emitter`, problems),
      probability: num(s, "probability", 1, `${where} sub-emitter`, problems, 0, 1),
      inheritVelocity: bool(s, "inheritVelocity", false, `${where} sub-emitter`, problems),
    });
  }
  return {
    name,
    enabled: bool(raw, "enabled", true, where, problems),
    duration: num(raw, "duration", d.duration, where, problems, 0.01),
    looping: bool(raw, "looping", d.looping, where, problems),
    prewarm: bool(raw, "prewarm", d.prewarm, where, problems),
    startDelay: num(raw, "startDelay", d.startDelay, where, problems, 0),
    startLife: parseParticleNumber(raw.startLife, d.startLife, `${where} startLife`, problems),
    startSpeed: parseParticleNumber(raw.startSpeed, d.startSpeed, `${where} startSpeed`, problems),
    startSize: parseParticleNumber(raw.startSize, d.startSize, `${where} startSize`, problems),
    startRotation: parseParticleNumber(raw.startRotation, d.startRotation, `${where} startRotation`, problems),
    startColor: parseParticleColor(raw.startColor, d.startColor, `${where} startColor`, problems),
    gravity: num(raw, "gravity", d.gravity, where, problems),
    space: choice(raw, "space", ["local", "world"] as const, d.space, where, problems),
    maxParticles: Math.round(num(raw, "maxParticles", d.maxParticles, where, problems, 1)),
    emission: {
      rateOverTime: parseParticleNumber(em.rateOverTime, d.emission.rateOverTime, `${where} rateOverTime`, problems),
      rateOverDistance: parseParticleNumber(em.rateOverDistance, d.emission.rateOverDistance, `${where} rateOverDistance`, problems),
      bursts,
    },
    shape: parseShape(raw.shape, `${where} shape`, problems),
    behaviors,
    subEmitters,
    renderer: parseRenderer(raw.renderer, `${where} renderer`, problems),
  };
}

/**
 * Read a particle effect. Bad values read as their defaults and are listed in `problems`; a file
 * that isn't a particle effect at all throws.
 */
export function parseParticleEffect(raw: unknown, where = "particle effect"): { effect: ParticleEffect; problems: string[] } {
  if (!isObj(raw)) throw new Error(`${where} isn't a particle effect (expected a JSON object).`);
  if (raw.format !== undefined && raw.format !== PARTICLES_FORMAT) throw new Error(`${where} has format "${String(raw.format)}"; expected "${PARTICLES_FORMAT}".`);
  const problems: string[] = [];
  const emitters: ParticleEmitterSettings[] = [];
  if (!Array.isArray(raw.emitters)) problems.push(`${where}: "emitters" should be a list.`);
  (Array.isArray(raw.emitters) ? raw.emitters : []).forEach((e, i) => {
    const parsed = parseEmitter(e, i, problems);
    if (parsed) emitters.push(parsed);
  });
  const names = new Set<string>();
  for (const e of emitters) {
    if (names.has(e.name)) problems.push(`${where}: two emitters are named "${e.name}"; sub-emitters use the first.`);
    names.add(e.name);
  }
  for (const e of emitters) for (const s of e.subEmitters) if (!names.has(s.emitter)) problems.push(`${where}: emitter "${e.name}" has a sub-emitter "${s.emitter}" that isn't in the effect.`);
  const effect: ParticleEffect = { emitters };
  if (isObj(raw.editor)) effect.editor = raw.editor;
  return { effect, problems };
}

/** The effect as JSON (the file's object, with the format tag). */
export function particleEffectJSON(effect: ParticleEffect): Record<string, unknown> {
  const out: Record<string, unknown> = { format: PARTICLES_FORMAT, emitters: effect.emitters };
  if (effect.editor) out.editor = effect.editor;
  return out;
}

/** The effect as file text. */
export function formatParticleEffect(effect: ParticleEffect): string {
  return `${JSON.stringify(particleEffectJSON(effect), null, 2)}\n`;
}

/** The emitters that only emit when another triggers them (named as some emitter's sub-emitter). */
export function subEmitterNames(effect: ParticleEffect): Set<string> {
  const names = new Set<string>();
  for (const e of effect.emitters) for (const s of e.subEmitters) if (s.emitter !== e.name) names.add(s.emitter);
  return names;
}
