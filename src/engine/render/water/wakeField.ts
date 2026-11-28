/**
 * The simulated wake height field (ADR 0451, the "field" wake mode): a square grid of water heights
 * around the camera, stepped by the damped 2D wave equation, that moving hulls press into. The waves
 * they make spread, interfere and fade on their own, so a fast hull leaves a V (its half-angle is
 * asin(wave speed / hull speed)), a turning hull a curved one, and two hulls' wakes cross. A foam
 * channel is laid under the hulls and where the water moves fast, spreads a little and fades.
 *
 * Plain maths on the CPU, no World or renderer: `wakes.ts` drives it, the water's renderer uploads
 * `pack`'s texels, and its tests drive it directly. Cell (i, j) covers world x in
 * [originX + i·cell, originX + (i + 1)·cell) and likewise z with j; index `j · resolution + i`.
 */

/** A hull pressing into the field this step. */
export interface WakeFieldSource {
  /** Its node's position on the water (m). */
  x: number;
  z: number;
  /** Its heading on the water, a unit vector. */
  hx: number;
  hz: number;
  /** How far ahead of (x, z) along the heading the stem is, and the stern (usually negative), in metres. */
  bow: number;
  stern: number;
  /** Half its beam (m). */
  beam: number;
  /** How hard it presses, 0..1 (its speed's wake strength × the wake's own strength). */
  strength: number;
  /** How much foam it lays, 0..1. */
  foam: number;
}

/** Wave speed on the field (m/s): about the speed of 6 m deep-water waves. */
export const WAKE_FIELD_WAVE_SPEED = 3;
/** The field's simulation step (s): a frame's time is stepped in these, at most `MAX_STEPS` a frame. */
export const WAKE_FIELD_STEP = 1 / 60;
const MAX_STEPS = 4;
/** How quickly waves lose their motion (per second; e^-t·DAMPING), and how quickly raised or lowered water settles back to level. */
const DAMPING = 0.2;
const SETTLE = 0.25;
/**
 * The wave equation here doesn't disperse, so a steady hull would only make a smooth V front; its
 * pressing pulses `PULSE` of its depth at `PULSE_HZ`, sending out trains of ripples that the hull's motion
 * lays out in a V, as a real hull's pitching and its bow wave's breaking do.
 */
const PULSE = 0.6;
const PULSE_HZ = 1.6;
/** How deep a hull at full strength presses the water at its middle (m). */
const DEPTH = 0.6;
/** How strongly a step pulls the water under a hull toward its pressed shape (0..1). */
const PRESS = 0.6;
/** Foam: seconds to fade to 1/e; how much it spreads to neighbours per step; vertical speed (m/s) above which the water whitens. */
const FOAM_LIFE = 1.3;
const FOAM_SPREAD = 0.06;
const FOAM_CHURN = 0.35;
/** Cells along each edge where waves are absorbed, so they don't reflect back off the border. */
const SPONGE = 12;

export class WakeField {
  readonly cell: number;
  originX = 0;
  originZ = 0;
  private h: Float32Array;
  private prev: Float32Array;
  private foam: Float32Array;
  private scratch: Float32Array;
  private placed = false;
  private carry = 0;
  private clock = 0;

  constructor(
    readonly resolution: number,
    readonly size: number,
  ) {
    const n = resolution * resolution;
    this.cell = size / resolution;
    this.h = new Float32Array(n);
    this.prev = new Float32Array(n);
    this.foam = new Float32Array(n);
    this.scratch = new Float32Array(n);
  }

  /**
   * Keep (x, z) near the middle of the field: once it is more than a sixteenth of the field from the
   * middle (or the first time), the grid moves by whole cells, keeping the water it still covers.
   */
  recenter(x: number, z: number): void {
    const n = this.resolution;
    const ox = Math.floor((x - this.size / 2) / this.cell) * this.cell;
    const oz = Math.floor((z - this.size / 2) / this.cell) * this.cell;
    if (!this.placed) {
      this.originX = ox;
      this.originZ = oz;
      this.placed = true;
      return;
    }
    const di = Math.round((ox - this.originX) / this.cell);
    const dj = Math.round((oz - this.originZ) / this.cell);
    if (Math.max(Math.abs(di), Math.abs(dj)) < n / 16) return;
    for (const name of ["h", "prev", "foam"] as const) this[name] = this.shifted(this[name], di, dj);
    this.originX += di * this.cell;
    this.originZ += dj * this.cell;
  }

  /** Advance the water `dt` seconds with `sources` pressing into it (whole steps; the remainder carries to the next call). */
  step(dt: number, sources: readonly WakeFieldSource[]): void {
    if (!(dt > 0)) return;
    this.carry = Math.min(this.carry + dt, MAX_STEPS * WAKE_FIELD_STEP);
    while (this.carry >= WAKE_FIELD_STEP) {
      this.carry -= WAKE_FIELD_STEP;
      this.substep(WAKE_FIELD_STEP, sources);
    }
  }

  /** Still water and no foam. */
  clear(): void {
    this.h.fill(0);
    this.prev.fill(0);
    this.foam.fill(0);
    this.carry = 0;
    this.clock = 0;
  }

  /** The water's height (m) at world (x, z), bilinear between cell centres; 0 off the field. */
  heightAt(x: number, z: number): number {
    return this.bilinear(this.h, x, z);
  }

  /** The foam amount (0..1) at world (x, z); 0 off the field. */
  foamAt(x: number, z: number): number {
    return this.bilinear(this.foam, x, z);
  }

  /** Writes four floats per cell into `out`: height, ∂h/∂x, ∂h/∂z (world units) and foam (0..1). */
  pack(out: Float32Array): void {
    const n = this.resolution, h = this.h, foam = this.foam, inv = 1 / (2 * this.cell);
    for (let j = 0; j < n; j++) {
      const up = j < n - 1 ? n : 0, down = j > 0 ? -n : 0;
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const r = i < n - 1 ? 1 : 0, l = i > 0 ? -1 : 0;
        const o = k * 4;
        out[o] = h[k]!;
        out[o + 1] = (h[k + r]! - h[k + l]!) * inv * (r - l === 2 ? 1 : 2);
        out[o + 2] = (h[k + up]! - h[k + down]!) * inv * (up - down === 2 * n ? 1 : 2);
        out[o + 3] = Math.min(1, foam[k]!);
      }
    }
  }

  private substep(dt: number, sources: readonly WakeFieldSource[]): void {
    const n = this.resolution;
    const h = this.h, prev = this.prev, foam = this.foam, next = this.scratch;
    const c2 = (WAKE_FIELD_WAVE_SPEED * dt / this.cell) ** 2;
    const keep = Math.exp(-DAMPING * dt);
    const settle = Math.exp(-SETTLE * dt);
    this.clock += dt;
    const fade = Math.exp(-dt / FOAM_LIFE);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const hk = h[k]!;
        const lap = (i > 0 ? h[k - 1]! : 0) + (i < n - 1 ? h[k + 1]! : 0) + (j > 0 ? h[k - n]! : 0) + (j < n - 1 ? h[k + n]! : 0) - 4 * hk;
        let v = (hk + (hk - prev[k]!) * keep + c2 * lap) * settle;
        const edge = Math.min(i, j, n - 1 - i, n - 1 - j);
        if (edge < SPONGE) {
          const s = (SPONGE - edge) / SPONGE;
          v *= 1 - 0.2 * s * s;
        }
        next[k] = v;
        // Foam where the water moves fast (crests breaking at the bow and the sides).
        const churn = Math.abs(v - hk) / dt - FOAM_CHURN;
        if (churn > 0) foam[k] = foam[k]! + churn * 0.6 * dt;
      }
    }
    // next becomes the current water, the current the previous.
    this.prev = h;
    this.h = next;
    this.scratch = prev;
    for (const s of sources) this.press(s);
    // Foam spreads a little to its neighbours and fades.
    const f2 = this.scratch;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const fk = foam[k]!;
        const avg = ((i > 0 ? foam[k - 1]! : 0) + (i < n - 1 ? foam[k + 1]! : 0) + (j > 0 ? foam[k - n]! : 0) + (j < n - 1 ? foam[k + n]! : 0)) * 0.25;
        f2[k] = Math.min(1.5, (fk + (avg - fk) * FOAM_SPREAD) * fade);
      }
    }
    this.foam = f2;
    this.scratch = foam;
  }

  /** Pull the water under a hull toward its pressed shape, and lay foam there. */
  private press(s: WakeFieldSource): void {
    if (!(s.strength > 0)) return;
    const n = this.resolution, cell = this.cell, h = this.h, foam = this.foam;
    const half = Math.max(0.1, (s.bow - s.stern) / 2);
    const mid = (s.bow + s.stern) / 2;
    const beam = Math.max(0.1, s.beam);
    const cx = s.x + s.hx * mid, cz = s.z + s.hz * mid;
    const reach = half + beam;
    const depth = DEPTH * s.strength * (1 + PULSE * Math.sin(this.clock * PULSE_HZ * Math.PI * 2));
    const i0 = Math.max(0, Math.floor((cx - reach - this.originX) / cell));
    const i1 = Math.min(n - 1, Math.ceil((cx + reach - this.originX) / cell));
    const j0 = Math.max(0, Math.floor((cz - reach - this.originZ) / cell));
    const j1 = Math.min(n - 1, Math.ceil((cz + reach - this.originZ) / cell));
    for (let j = j0; j <= j1; j++) {
      const z = this.originZ + (j + 0.5) * cell - cz;
      for (let i = i0; i <= i1; i++) {
        const x = this.originX + (i + 0.5) * cell - cx;
        const along = (x * s.hx + z * s.hz) / half;
        const across = (x * -s.hz + z * s.hx) / beam;
        const r2 = along * along + across * across;
        if (r2 >= 1) continue;
        const w = (1 - r2) * (1 - r2);
        const k = j * n + i;
        h[k] = h[k]! + (-depth * w - h[k]!) * PRESS;
        // Foam churned under the aft half of the hull.
        const aft = Math.min(1, Math.max(0, 0.6 - along));
        foam[k] = Math.max(foam[k]!, s.foam * s.strength * Math.min(1, 2 * w) * aft);
      }
    }
  }

  private shifted(a: Float32Array, di: number, dj: number): Float32Array {
    const n = this.resolution, out = this.scratch === a ? new Float32Array(a.length) : this.scratch;
    out.fill(0);
    for (let j = 0; j < n; j++) {
      const sj = j + dj;
      if (sj < 0 || sj >= n) continue;
      const i0 = Math.max(0, -di), i1 = Math.min(n, n - di);
      if (i1 > i0) out.set(a.subarray(sj * n + i0 + di, sj * n + i1 + di), j * n + i0);
    }
    this.scratch = a;
    return out;
  }

  private bilinear(a: Float32Array, x: number, z: number): number {
    const n = this.resolution;
    const fx = (x - this.originX) / this.cell - 0.5, fz = (z - this.originZ) / this.cell - 0.5;
    if (!this.placed || fx < 0 || fz < 0 || fx > n - 1 || fz > n - 1) return 0;
    const i = Math.min(n - 2, Math.floor(fx)), j = Math.min(n - 2, Math.floor(fz));
    const tx = fx - i, tz = fz - j, k = j * n + i;
    const top = a[k]! + (a[k + 1]! - a[k]!) * tx;
    const bottom = a[k + n]! + (a[k + n + 1]! - a[k + n]!) * tx;
    return top + (bottom - top) * tz;
  }
}
