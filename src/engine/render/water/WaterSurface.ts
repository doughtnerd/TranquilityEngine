/**
 * Water surfaces (ADR 0072): a grid displaced by a Gerstner wave sum, drawn by the render backend
 * (`WaterRenderer`) and sampled on the CPU from the same maths (`gerstner.ts`), so objects float
 * on the waves you see. Engine-native: no three.js here, so servers sample water headless.
 */
import { Component } from "../../core/Component";
import { Color, Vector3 } from "../../core/math";
import { PlainObject, component, field } from "../../core/registry";
import { World } from "../../core/World";
import { MAX_WAVES, WATER_PRESET, cleanWaves, createPackedWaves, packWaves, sampleWaves, type PackedWaves, type WaterWave } from "./gerstner";

/** The water surface at a point, in world space. */
export interface WaterSample {
  /** World-space height of the surface above (x, z). */
  height: number;
  /** World-space unit normal of the surface there. */
  normal: Vector3;
}

/**
 * The water clock (ADR 0072): the World's scaled time, or in a networked World the server tick
 * (`Time.network.serverTick / tickRate`, plus the progress to the next fixed step), so a server and
 * its clients see the same waves.
 */
export function waterTime(world: World): number {
  const net = world.time.network;
  if (net && net.tickRate > 0) return (net.serverTick + world.time.fixedAlpha) / net.tickRate;
  return world.time.time;
}

/**
 * A moving water surface: a square grid of `size` world units centred on its node, in the node's
 * XZ plane, displaced by up to 8 Gerstner waves. `sample(x, z)` (and `Water.sample`) returns the
 * height and normal of the drawn surface, for buoyancy and gameplay.
 *
 * Keep the node level (turn it about Y only): sampling assumes the water's up is the world's.
 */
@component("engine.WaterSurface")
export class WaterSurface extends Component {
  /** Side of the square grid, in the node's local units. */
  @field(Number) size = 100;
  /** Vertices per side (2–1024). Quality tiers with the "low" shader level use half. */
  @field(Number) resolution = 128;
  /** Up to 8 waves: `direction` (degrees, 0 = +X), `wavelength`, `steepness` 0–1, `speed` (0: deep-water speed). */
  @field([PlainObject]) waves: WaterWave[] = WATER_PRESET.map((w) => ({ ...w }));
  /** Multiplies every wave's amplitude; raise it at runtime for a storm. */
  @field(Number) waveScale = 1;
  /** Colour looking straight down into the water and in troughs. */
  @field(Color) deepColor = Color.from("#0b3a5a");
  /** Colour at grazing angles and on crests. */
  @field(Color) shallowColor = Color.from("#2a8c9a");
  @field(Color) foamColor = Color.from("#f2f6f7");
  /** 0 (none) to 1: how readily foam forms where crests fold. */
  @field(Number) foamAmount = 0.5;
  /** Strength of the scrolling ripple normals on top of the waves (0 = none). */
  @field(Number) normalDetail = 0.5;
  @field(Number) roughness = 0.08;
  /** Below 1 the surface is drawn transparent. */
  @field(Number) opacity = 1;
  /** Strength of the Fresnel reflection of the environment (0–1). */
  @field(Number) reflectivity = 0.5;

  private readonly packed: PackedWaves = createPackedWaves();
  /** What `packed` was made from: time, waveScale, wave count, then 4 numbers per wave. */
  private readonly packedFrom = new Float64Array(3 + MAX_WAVES * 4).fill(NaN);

  /** @internal The waves packed at `time` (shared with the renderer so both draw from the same numbers). */
  _pack(time: number): PackedWaves {
    const raw = Array.isArray(this.waves) ? this.waves : [];
    const n = Math.min(raw.length, MAX_WAVES);
    const from = this.packedFrom;
    let same = from[0] === time && from[1] === this.waveScale && from[2] === n;
    for (let i = 0; same && i < n; i++) {
      const w = raw[i] as Partial<WaterWave> | null;
      same = from[3 + i * 4] === w?.direction && from[4 + i * 4] === w?.wavelength && from[5 + i * 4] === w?.steepness && from[6 + i * 4] === w?.speed;
    }
    if (!same) {
      packWaves(cleanWaves(raw), this.waveScale, time, this.packed);
      from.fill(NaN);
      from[0] = time;
      from[1] = this.waveScale;
      from[2] = n;
      for (let i = 0; i < n; i++) {
        const w = raw[i] as Partial<WaterWave> | null;
        from[3 + i * 4] = w?.direction ?? NaN;
        from[4 + i * 4] = w?.wavelength ?? NaN;
        from[5 + i * 4] = w?.steepness ?? NaN;
        from[6 + i * 4] = w?.speed ?? NaN;
      }
    }
    return this.packed;
  }

  /**
   * The surface's height and normal at world (x, z), at the water clock's current time: the same
   * waves, `waveScale` and time the renderer draws, with the waves' sideways motion undone. The
   * waves continue past the edge of the drawn grid.
   */
  sample(x: number, z: number): WaterSample {
    return sampleSurface(this, x, z, waterTime(this.world));
  }

  override _onDetach(): void {
    this.world.render?.release(this);
  }
}

/** @internal `surface.sample` at an explicit water time. */
export function sampleSurface(surface: WaterSurface, x: number, z: number, time: number): WaterSample {
  const packed = surface._pack(time);
  const node = surface.node;
  if (!node.transform) {
    const s = sampleWaves(packed, x, z);
    return { height: s.height, normal: new Vector3(s.nx, s.ny, s.nz) };
  }
  const e = node.entity;
  const m = surface.world.worldMatrix(e);
  const o = e * 16;
  // World XZ to local XZ through the matrix's horizontal part (the node is level).
  const a = m[o], b = m[o + 8], c = m[o + 2], d = m[o + 10];
  const det = a * d - b * c;
  const rx = x - m[o + 12], rz = z - m[o + 14];
  const lx = det ? (d * rx - b * rz) / det : rx;
  const lz = det ? (-c * rx + a * rz) / det : rz;
  const s = sampleWaves(packed, lx, lz);
  const height = m[o + 1] * lx + m[o + 5] * s.height + m[o + 9] * lz + m[o + 13];
  // Normals transform by the cofactor matrix (the inverse transpose up to scale).
  const c0x = m[o + 5] * m[o + 10] - m[o + 6] * m[o + 9], c0y = m[o + 6] * m[o + 8] - m[o + 4] * m[o + 10], c0z = m[o + 4] * m[o + 9] - m[o + 5] * m[o + 8];
  const c1x = m[o + 9] * m[o + 2] - m[o + 10] * m[o + 1], c1y = m[o + 10] * m[o] - m[o + 8] * m[o + 2], c1z = m[o + 8] * m[o + 1] - m[o + 9] * m[o];
  const c2x = m[o + 1] * m[o + 6] - m[o + 2] * m[o + 5], c2y = m[o + 2] * m[o + 4] - m[o] * m[o + 6], c2z = m[o] * m[o + 5] - m[o + 1] * m[o + 4];
  let nx = c0x * s.nx + c1x * s.ny + c2x * s.nz;
  let ny = c0y * s.nx + c1y * s.ny + c2y * s.nz;
  let nz = c0z * s.nx + c1z * s.ny + c2z * s.nz;
  const len = Math.hypot(nx, ny, nz) || 1;
  const sign = ny < 0 ? -1 : 1; // a mirrored node still faces up
  nx = (nx / len) * sign; ny = (ny / len) * sign; nz = (nz / len) * sign;
  return { height, normal: new Vector3(nx, ny, nz) };
}

/** Water queries for the current World (ADR 0072). */
export class Water {
  /** The World's first enabled WaterSurface, or null. */
  static get surface(): WaterSurface | null {
    return firstSurface(World.require());
  }

  /** The water clock of the current World, in seconds: what the waves are drawn and sampled at. */
  static get time(): number {
    return waterTime(World.require());
  }

  /** The height and normal of the World's first enabled WaterSurface at world (x, z); null without one. */
  static sample(x: number, z: number): WaterSample | null {
    return Water.surface?.sample(x, z) ?? null;
  }
}

/** @internal The World's first enabled WaterSurface. */
export function firstSurface(world: World): WaterSurface | null {
  for (const s of world._componentsOfType(WaterSurface)) if (s.isActiveAndEnabled) return s;
  return null;
}
