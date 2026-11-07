/**
 * The Gerstner wave sum (ADR 0072), in one place for both the GPU and the CPU.
 *
 * - `packWaves` turns a surface's wave list, `waveScale` and the water clock into a flat array
 *   of per-wave constants: direction, wave number, amplitude and phase. Time is folded into the
 *   phase here (wrapped to one period, in doubles), so the shader never multiplies a large time
 *   by a frequency in 32-bit floats.
 * - `GERSTNER_BODY` is the wave sum written once, in the subset of syntax WGSL, GLSL and
 *   JavaScript share: Babylon's water plugin (`render/babylon/water.ts`) fills in its type words for
 *   each shader language; `gerstnerBodyJS()` gives the same text as JavaScript (tests compile it to
 *   prove the sampler below computes what the shader computes).
 * - `gerstner` is that sum in TypeScript for the CPU, and `sampleWaves` inverts the horizontal
 *   displacement so a height can be asked for at a world XZ position.
 *
 * Everything is in the water's local XZ plane (y up). No three.js here: servers sample waves too.
 */

/** One wave of a water surface. */
export interface WaterWave {
  /** Direction of travel in degrees around the up axis: 0 is +X, 90 is +Z. */
  direction: number;
  /** Crest-to-crest distance in world units. */
  wavelength: number;
  /** 0 (flat) to 1 (sharp crests that just fold). The amplitude is `steepness × wavelength / 2π`. */
  steepness: number;
  /** Units per second; 0 uses the deep-water speed √(g·L/2π). */
  speed: number;
}

/** Most waves a surface draws; further entries are ignored. */
export const MAX_WAVES = 8;
/** Floats per packed wave: direction x, direction z, wave number k, amplitude, phase. */
export const WAVE_STRIDE = 5;
/** Gravity for the deep-water speed, m/s². */
export const WATER_GRAVITY = 9.81;

const TAU = Math.PI * 2;

/** The deep-water speed of a wave of `wavelength`: √(g·L/2π). */
export function deepWaterSpeed(wavelength: number): number {
  return Math.sqrt((WATER_GRAVITY * Math.max(wavelength, 1e-4)) / TAU);
}

/** A wave list with every field a finite number (scene data may leave some out). */
export function cleanWaves(waves: readonly Partial<WaterWave>[] | null | undefined): WaterWave[] {
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return (waves ?? []).slice(0, MAX_WAVES).map((w) => ({
    direction: num(w?.direction, 0),
    wavelength: Math.max(num(w?.wavelength, 10), 1e-3),
    steepness: Math.min(Math.max(num(w?.steepness, 0.2), 0), 1),
    speed: Math.max(num(w?.speed, 0), 0),
  }));
}

/**
 * The packed wave constants at `time`: `WAVE_STRIDE` floats per wave, `MAX_WAVES` waves (unused
 * ones zero). `count` is how many are in use. The shader's uniform array and the CPU sampler both
 * read this array, so they see the same waves.
 */
export interface PackedWaves {
  readonly data: Float64Array;
  count: number;
}

export function createPackedWaves(): PackedWaves {
  return { data: new Float64Array(MAX_WAVES * WAVE_STRIDE), count: 0 };
}

/** Pack `waves` scaled by `waveScale` at water time `time` (seconds) into `out`. */
export function packWaves(waves: readonly WaterWave[], waveScale: number, time: number, out: PackedWaves = createPackedWaves()): PackedWaves {
  const d = out.data;
  d.fill(0);
  const n = Math.min(waves.length, MAX_WAVES);
  const scale = Number.isFinite(waveScale) ? Math.max(waveScale, 0) : 1;
  for (let i = 0; i < n; i++) {
    const w = waves[i];
    const k = TAU / Math.max(w.wavelength, 1e-3);
    const speed = w.speed > 0 ? w.speed : deepWaterSpeed(w.wavelength);
    const a = (scale * Math.min(Math.max(w.steepness, 0), 1)) / k;
    const rad = (w.direction * Math.PI) / 180;
    // Phase = k·c·t, wrapped to [0, 2π) in doubles.
    let phase = (k * speed * time) % TAU;
    if (phase < 0) phase += TAU;
    const o = i * WAVE_STRIDE;
    d[o] = Math.cos(rad);
    d[o + 1] = Math.sin(rad);
    d[o + 2] = k;
    d[o + 3] = a;
    d[o + 4] = phase;
  }
  out.count = n;
  return out;
}

/** The largest height the waves can reach above (or below) the rest plane: the sum of amplitudes. */
export function maxAmplitude(packed: PackedWaves): number {
  let a = 0;
  for (let i = 0; i < packed.count; i++) a += packed.data[i * WAVE_STRIDE + 3];
  return a;
}

/**
 * The wave sum, in syntax GLSL and JavaScript share (`$float`/`$int` become `float`/`int` or
 * `let`; `sin`/`cos` become `Math.sin`/`Math.cos` in JavaScript). Inputs: `px`, `pz` (a rest
 * position), `mycoWaves` (the packed array) and `mycoWaveCount`. Outputs: the displacement
 * (`gx`, `gy`, `gz`), and the surface's tangent (`tx`, `ty`, `tz`, ∂P/∂x) and binormal (`bx`,
 * `by`, `bz`, ∂P/∂z); the normal is binormal × tangent and the Jacobian `tx·bz − tz·bx`.
 */
export const GERSTNER_BODY = `
$float gx = 0.0; $float gy = 0.0; $float gz = 0.0;
$float tx = 1.0; $float ty = 0.0; $float tz = 0.0;
$float bx = 0.0; $float by = 0.0; $float bz = 1.0;
for ($int i = 0; i < ${MAX_WAVES}; i++) {
  if (i >= mycoWaveCount) break;
  $float wdx = mycoWaves[i * ${WAVE_STRIDE}];
  $float wdz = mycoWaves[i * ${WAVE_STRIDE} + 1];
  $float wk = mycoWaves[i * ${WAVE_STRIDE} + 2];
  $float wa = mycoWaves[i * ${WAVE_STRIDE} + 3];
  $float wph = mycoWaves[i * ${WAVE_STRIDE} + 4];
  $float wf = wk * (wdx * px + wdz * pz) - wph;
  $float wc = cos(wf);
  $float ws = sin(wf);
  $float wst = wk * wa;
  gx += wdx * wa * wc;
  gy += wa * ws;
  gz += wdz * wa * wc;
  tx -= wdx * wdx * wst * ws;
  ty += wdx * wst * wc;
  tz -= wdx * wdz * wst * ws;
  bx -= wdx * wdz * wst * ws;
  by += wdz * wst * wc;
  bz -= wdz * wdz * wst * ws;
}
`;

/** `GERSTNER_BODY` as JavaScript statements (the same text the shaders are made from). */
export function gerstnerBodyJS(): string {
  return GERSTNER_BODY.replace(/\$float|\$int/g, "let").replace(/\b(sin|cos)\(/g, "Math.$1(");
}

/** One evaluation of the wave sum at a rest position. */
export interface GerstnerResult {
  /** Displacement from the rest position. */
  dx: number;
  dy: number;
  dz: number;
  /** ∂P/∂x. */
  tx: number;
  ty: number;
  tz: number;
  /** ∂P/∂z. */
  bx: number;
  by: number;
  bz: number;
}

export function createGerstnerResult(): GerstnerResult {
  return { dx: 0, dy: 0, dz: 0, tx: 1, ty: 0, tz: 0, bx: 0, by: 0, bz: 1 };
}

/** The wave sum at rest position (px, pz): the CPU twin of `GERSTNER_BODY`. */
export function gerstner(packed: PackedWaves, px: number, pz: number, out: GerstnerResult = createGerstnerResult()): GerstnerResult {
  const d = packed.data;
  let gx = 0, gy = 0, gz = 0, tx = 1, ty = 0, tz = 0, bx = 0, by = 0, bz = 1;
  for (let i = 0; i < packed.count; i++) {
    const o = i * WAVE_STRIDE;
    const wdx = d[o], wdz = d[o + 1], wk = d[o + 2], wa = d[o + 3], wph = d[o + 4];
    const wf = wk * (wdx * px + wdz * pz) - wph;
    const wc = Math.cos(wf), ws = Math.sin(wf), wst = wk * wa;
    gx += wdx * wa * wc;
    gy += wa * ws;
    gz += wdz * wa * wc;
    tx -= wdx * wdx * wst * ws;
    ty += wdx * wst * wc;
    tz -= wdx * wdz * wst * ws;
    bx -= wdx * wdz * wst * ws;
    by += wdz * wst * wc;
    bz -= wdz * wdz * wst * ws;
  }
  out.dx = gx; out.dy = gy; out.dz = gz;
  out.tx = tx; out.ty = ty; out.tz = tz;
  out.bx = bx; out.by = by; out.bz = bz;
  return out;
}

/** A surface sample in the water's local space. */
export interface LocalWaterSample {
  /** Height above the rest plane. */
  height: number;
  /** Unit normal. */
  nx: number;
  ny: number;
  nz: number;
  /** The rest position whose displaced vertex lands at the sampled XZ. */
  px: number;
  pz: number;
}

const tmp = createGerstnerResult();

/**
 * The surface at local (x, z): finds the rest position P whose displaced point lands on (x, z)
 * (Gerstner waves move points sideways too), then reads its height and normal. Iterates
 * P ← P − J⁻¹·(P + D(P) − target) from P = target (Newton's method on the horizontal map, with
 * the analytic Jacobian from the same evaluation), falling back to the plain fixed-point step
 * P ← target − D(P) where the surface folds.
 */
export function sampleWaves(packed: PackedWaves, x: number, z: number, iterations = 6): LocalWaterSample {
  let px = x, pz = z;
  for (let i = 0; i < iterations; i++) {
    gerstner(packed, px, pz, tmp);
    const rx = px + tmp.dx - x, rz = pz + tmp.dz - z;
    if (Math.abs(rx) < 1e-7 && Math.abs(rz) < 1e-7) break;
    // ∂(P + D)/∂px = (tx, tz), ∂(P + D)/∂pz = (bx, bz).
    const det = tmp.tx * tmp.bz - tmp.bx * tmp.tz;
    if (det > 0.05) {
      px -= (tmp.bz * rx - tmp.bx * rz) / det;
      pz -= (-tmp.tz * rx + tmp.tx * rz) / det;
    } else {
      px = x - tmp.dx;
      pz = z - tmp.dz;
    }
  }
  gerstner(packed, px, pz, tmp);
  // normal = binormal × tangent
  let nx = tmp.by * tmp.tz - tmp.bz * tmp.ty;
  let ny = tmp.bz * tmp.tx - tmp.bx * tmp.tz;
  let nz = tmp.bx * tmp.ty - tmp.by * tmp.tx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  return { height: tmp.dy, nx, ny, nz, px, pz };
}

/** The four-wave preset the editor's Create > Water uses (and a new WaterSurface starts with). */
export const WATER_PRESET: readonly WaterWave[] = [
  { direction: 0, wavelength: 24, steepness: 0.18, speed: 0 },
  { direction: 30, wavelength: 14, steepness: 0.16, speed: 0 },
  { direction: -25, wavelength: 8, steepness: 0.14, speed: 0 },
  { direction: 70, wavelength: 4.5, steepness: 0.1, speed: 0 },
];
