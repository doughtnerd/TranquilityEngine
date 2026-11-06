// Internal (ADR 0057, 0075): a CPU simulation of one particle effect instance, independent of any
// renderer (no three.js, no Babylon). It reads the effect format (`scene/particles.ts`) and keeps,
// per emitter, a pooled list of particles with world-space output a backend draws.
//
// It follows the behaviour of the three.quarks translation (`quarksEffect.ts`): the same modules,
// the same live-value paths (ADR 0060), the same quality-scale and tint rules.
import {
  evalCurve,
  parseHexColor,
  subEmitterNames,
  type CurveKey,
  type ParticleBehavior,
  type ParticleColor,
  type ParticleEffect,
  type ParticleEmitterSettings,
  type ParticleGradient,
  type ParticleNumber,
  type ParticleRenderer,
} from "../../scene/particles";

const DEG = Math.PI / 180;
const GRAVITY = 9.81;
const TAU = Math.PI * 2;
/** Prewarm steps per second. */
const PREWARM_STEP = 1 / 30;

/** A value the caller updates in place: a number, or linear RGBA for colours. */
export interface LiveBox {
  value: number | number[];
}

/** A live value for an emitter's settings field (`startSpeed`, `behaviors.2.size`…), or undefined. */
export type LiveLookup = (emitter: number, path: string) => LiveBox | undefined;

/** Linear RGBA that multiplies start colours. */
export type Tint = readonly [number, number, number, number];

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** sRGB components (0-1) as linear RGB. */
export function linearRGB(r: number, g: number, b: number): [number, number, number] {
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

export interface SimulationOptions {
  /** Uniform random in [0, 1); default `Math.random`. Inject a seeded one for deterministic runs. */
  random?: () => number;
  live?: LiveLookup;
}

// --- compiled values --------------------------------------------------------------------------------

interface Num {
  kind: 0 | 1 | 2 | 3;
  a: number;
  b: number;
  ka: CurveKey[];
  kb: CurveKey[];
  slot: number;
  box: LiveBox | null;
  scale: number;
}

const scaleKeys = (k: readonly CurveKey[], s: number): CurveKey[] => k.map(([t, v]) => [t, v * s] as CurveKey);

function compileNum(v: ParticleNumber, scale: number, slot: number, box: LiveBox | undefined): Num {
  const n: Num = { kind: 0, a: 0, b: 0, ka: [], kb: [], slot, box: box ?? null, scale };
  if (typeof v === "number") n.a = v * scale;
  else if ("random" in v) {
    n.kind = 1;
    n.a = v.random[0] * scale;
    n.b = v.random[1] * scale;
  } else if ("curve" in v) {
    n.kind = 2;
    n.ka = scaleKeys(v.curve, scale);
  } else {
    n.kind = 3;
    n.ka = scaleKeys(v.randomCurves[0], scale);
    n.kb = scaleKeys(v.randomCurves[1], scale);
  }
  return n;
}

/** A number at `t` (life fraction, or cycle fraction for start values); `u` is the 0-1 random for ranges. */
function evalNum(n: Num, t: number, u: number): number {
  if (n.box) {
    const v = n.box.value;
    return (typeof v === "number" ? v : (v[0] ?? 0)) * n.scale;
  }
  switch (n.kind) {
    case 0:
      return n.a;
    case 1:
      return n.a + (n.b - n.a) * u;
    case 2:
      return evalCurve(n.ka, t);
    default: {
      const a = evalCurve(n.ka, t);
      return a + (evalCurve(n.kb, t) - a) * u;
    }
  }
}

interface LinGradient {
  r: CurveKey[];
  g: CurveKey[];
  b: CurveKey[];
  a: CurveKey[];
}

function compileGradient(g: ParticleGradient): LinGradient {
  const colors = g.colors.length ? g.colors : ([[0, "#ffffff"]] as [number, string][]);
  const out: LinGradient = { r: [], g: [], b: [], a: g.alphas.length ? g.alphas.map(([t, a]) => [t, a] as CurveKey) : [[0, 1]] };
  for (const [t, hex] of colors) {
    const [r, gg, b] = parseHexColor(hex);
    const [lr, lg, lb] = linearRGB(r, gg, b);
    out.r.push([t, lr]);
    out.g.push([t, lg]);
    out.b.push([t, lb]);
  }
  return out;
}

interface Col {
  kind: 0 | 1 | 2 | 3;
  c0: number[];
  c1: number[];
  g0: LinGradient | null;
  g1: LinGradient | null;
  box: LiveBox | null;
}

function linearHex(hex: string): number[] {
  const [r, g, b, a] = parseHexColor(hex);
  return [...linearRGB(r, g, b), a];
}

function compileCol(v: ParticleColor, box: LiveBox | undefined): Col {
  const c: Col = { kind: 0, c0: [1, 1, 1, 1], c1: [1, 1, 1, 1], g0: null, g1: null, box: box ?? null };
  if (typeof v === "string") c.c0 = linearHex(v);
  else if ("random" in v) {
    c.kind = 1;
    c.c0 = linearHex(v.random[0]);
    c.c1 = linearHex(v.random[1]);
  } else if ("gradient" in v) {
    c.kind = 2;
    c.g0 = compileGradient(v.gradient);
  } else {
    c.kind = 3;
    c.g0 = compileGradient(v.randomGradients[0]);
    c.g1 = compileGradient(v.randomGradients[1]);
  }
  return c;
}

const gradAt = (g: LinGradient, t: number, o: number[]): void => {
  o[0] = evalCurve(g.r, t);
  o[1] = evalCurve(g.g, t);
  o[2] = evalCurve(g.b, t);
  o[3] = evalCurve(g.a, t);
};

const tmpCol = [0, 0, 0, 0];

/** A colour (linear RGBA) at `t`; `u` is the 0-1 random for ranges. */
function evalCol(c: Col, t: number, u: number, out: number[]): void {
  if (c.box) {
    const v = c.box.value;
    if (Array.isArray(v)) {
      out[0] = v[0] ?? 1;
      out[1] = v[1] ?? 1;
      out[2] = v[2] ?? 1;
      out[3] = v[3] ?? 1;
    } else out[0] = out[1] = out[2] = v, (out[3] = 1);
    return;
  }
  switch (c.kind) {
    case 0:
      for (let i = 0; i < 4; i++) out[i] = c.c0[i];
      return;
    case 1:
      for (let i = 0; i < 4; i++) out[i] = c.c0[i] + (c.c1[i] - c.c0[i]) * u;
      return;
    case 2:
      gradAt(c.g0!, t, out);
      return;
    default:
      gradAt(c.g0!, t, out);
      gradAt(c.g1!, t, tmpCol);
      for (let i = 0; i < 4; i++) out[i] += (tmpCol[i] - out[i]) * u;
  }
}

// --- compiled behaviours ----------------------------------------------------------------------------

type Phase = 0 | 1 | 2 | 3 | 4;
/** 0 velocity, 1 position (after integration), 2 collision, 3 appearance. */
type Behave =
  | { k: "color"; c: Col; slot: number }
  | { k: "size"; n: Num }
  | { k: "rotation"; n: Num }
  | { k: "speed"; n: Num }
  | { k: "force"; x: Num; y: Num; z: Num }
  | { k: "gpoint"; c: [number, number, number]; s: number }
  | { k: "noise"; f: Num; p: Num; pa: Num; ra: Num; idx: number; slot: number }
  | { k: "turb"; scale: [number, number, number]; oct: number; vel: [number, number, number]; ts: [number, number, number]; off: [number, number, number] }
  | { k: "orbit"; n: Num; axis: [number, number, number] }
  | { k: "frame"; n: Num }
  | { k: "limit"; n: Num; dampen: number }
  | { k: "cspeed"; c: Col; min: number; max: number }
  | { k: "sspeed"; n: Num; min: number; max: number }
  | { k: "collision"; h: number; bounce: number; kill: boolean };

const PHASE: Record<Behave["k"], Phase> = {
  color: 3,
  size: 3,
  rotation: 3,
  speed: 3,
  force: 0,
  gpoint: 0,
  noise: 1,
  turb: 0,
  orbit: 1,
  frame: 3,
  limit: 0,
  cspeed: 3,
  sspeed: 3,
  collision: 2,
};

// --- noise ---------------------------------------------------------------------------------------------

function hashInt(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

/** A stable 0-1 random for `slot` of a particle with `seed`. */
function stable(seed: number, slot: number): number {
  return hashInt(Math.imul((seed * 4294967296) | 0, 0x9e3779b1) ^ Math.imul(slot + 1, 0x85ebca77)) / 4294967296;
}

const lattice = (x: number, y: number, z: number): number => (hashInt(Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) / 4294967296) * 2 - 1;
const fade = (t: number): number => t * t * (3 - 2 * t);

/** Smooth value noise in [-1, 1]. */
function noise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = fade(x - ix);
  const fy = fade(y - iy);
  const fz = fade(z - iz);
  const l = (dx: number, dy: number, dz: number) => lattice(ix + dx, iy + dy, iz + dz);
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  return mix(
    mix(mix(l(0, 0, 0), l(1, 0, 0), fx), mix(l(0, 1, 0), l(1, 1, 0), fx), fy),
    mix(mix(l(0, 0, 1), l(1, 0, 1), fx), mix(l(0, 1, 1), l(1, 1, 1), fx), fy),
    fz,
  );
}

// --- particles and emitters ---------------------------------------------------------------------------

/** One live particle. Positions and velocities marked "sim" are in the emitter's space (world or the node's local). */
export class SimParticle {
  alive = false;
  /** Changes every time the pooled object is reused, so references can tell. */
  serial = 0;
  seed = 0;
  age = 0;
  life = 1;
  /** Sim-space position and velocity (before the speed-over-life multiplier). */
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  speedMod = 1;
  startSize = 1;
  startTile = 0;
  startR = 1;
  startG = 1;
  startB = 1;
  startA = 1;
  // --- output, refreshed each step -----------------------------------------------------------
  /** World-space position and velocity (velocity includes the speed multiplier). */
  wx = 0;
  wy = 0;
  wz = 0;
  wvx = 0;
  wvy = 0;
  wvz = 0;
  /** Size in metres; `length` is the stretched length (stretched mode). */
  size = 1;
  length = 1;
  /** Radians. */
  rotation = 0;
  /** Linear RGBA. */
  r = 1;
  g = 1;
  b = 1;
  a = 1;
  tile = 0;
  /** How far the flipbook has moved from `tile` towards the next tile, 0-1 (`blendTiles` cross-fades by it). */
  tileBlend = 0;
  /** Life fraction, 0 (born) to 1 (dying). */
  t = 0;
  /** Trail history (world positions, a ring of `trailCap` points); empty unless the emitter draws trails. */
  trail: Float32Array = new Float32Array(0);
  trailCap = 0;
  trailCount = 0;
  /** Index the next point is written at. */
  trailHead = 0;
  noise: Float64Array = new Float64Array(0);
}

/** The `k`th newest trail point of `p` (0 = the head) into `out`. */
export function trailPoint(p: SimParticle, k: number, out: { x: number; y: number; z: number }): void {
  const i = (((p.trailHead - 1 - k) % p.trailCap) + p.trailCap) % p.trailCap;
  out.x = p.trail[i * 3];
  out.y = p.trail[i * 3 + 1];
  out.z = p.trail[i * 3 + 2];
}

class EmissionState {
  time = 0;
  accum = 0;
  distAccum = 0;
  hasLast = false;
  lx = 0;
  ly = 0;
  lz = 0;
  cursor = 0;
  done = false;
  burstNext: Int32Array;
  constructor(bursts: number) {
    this.burstNext = new Int32Array(bursts);
  }
  reset(): void {
    this.time = 0;
    this.accum = 0;
    this.distAccum = 0;
    this.hasLast = false;
    this.cursor = 0;
    this.done = false;
    this.burstNext.fill(0);
  }
}

/** An emission a parent particle triggered in a sub-emitter. */
class SubState extends EmissionState {
  parent: SimParticle | null = null;
  parentEmitter: SimEmitter | null = null;
  serial = 0;
  /** World origin (follows the parent while it lives), and the parent's world velocity. */
  ox = 0;
  oy = 0;
  oz = 0;
  pvx = 0;
  pvy = 0;
  pvz = 0;
  inherit = false;
  /** Frame trigger: lives as long as the parent, cycling. */
  frame = false;
  /** Seconds of this step still to simulate when it was created. */
  pending = 0;
}

interface SubLink {
  target: SimEmitter;
  trigger: "birth" | "death" | "frame";
  probability: number;
  inherit: boolean;
}

/** One emitter of a running effect. */
export class SimEmitter {
  readonly name: string;
  readonly index: number;
  readonly settings: ParticleEmitterSettings;
  readonly renderer: ParticleRenderer;
  /** Emits only when another emitter triggers it. */
  readonly subEmitter: boolean;
  /** Particles `0 .. count - 1` of `pool` are alive. */
  readonly pool: SimParticle[] = [];
  count = 0;
  /** Seconds before emission starts (counts down). */
  delayLeft: number;
  /** No more emission (a finished one-shot cycle, or stopped); live particles still play out. */
  ended = false;
  /** Seconds this emitter has simulated. */
  simTime = 0;
  /** Trail width along the trail (`widthOverLength`), or null. */
  readonly width: Num | null;
  /** Evaluate the trail width at `u` along the trail (0 head, 1 tail). */
  widthAt(u: number): number {
    return this.width ? evalNum(this.width, u, 0.5) : 1;
  }

  /** @internal */ readonly st: EmissionState;
  /** @internal */ readonly subs: SubLink[] = [];
  /** @internal */ readonly states: SubState[] = [];
  /** @internal */ readonly world: boolean;
  /** @internal */ needsPrewarm: boolean;
  /** @internal */ dtEff = 0;
  /** @internal */ readonly tiles: number;
  // compiled
  /** @internal */ readonly lifeN: Num;
  /** @internal */ readonly speedN: Num;
  /** @internal */ readonly sizeN: Num;
  /** @internal */ readonly rotN: Num;
  /** @internal */ readonly colorC: Col;
  /** @internal */ readonly rateN: Num;
  /** @internal */ readonly distN: Num;
  /** @internal */ readonly burstN: Num[];
  /** @internal */ readonly gravityBox: LiveBox | undefined;
  /** @internal */ readonly tileN: Num;
  /** @internal */ readonly trailN: Num;
  /** @internal */ readonly behaviors: Behave[][] = [[], [], [], []];
  /** @internal */ readonly noiseCount: number;
  /** @internal */ readonly shapeR = new Float64Array(9);
  /** @internal */ readonly trailOn: boolean;

  constructor(settings: ParticleEmitterSettings, index: number, subEmitter: boolean, live: LiveLookup | undefined) {
    this.name = settings.name;
    this.index = index;
    this.settings = settings;
    this.renderer = settings.renderer;
    this.subEmitter = subEmitter;
    this.delayLeft = subEmitter ? 0 : settings.startDelay;
    this.needsPrewarm = !subEmitter && settings.looping && settings.prewarm;
    this.world = settings.space === "world";
    this.tiles = Math.max(1, settings.renderer.tiles[0] * settings.renderer.tiles[1]);
    this.trailOn = settings.renderer.mode === "trail";
    this.st = new EmissionState(settings.emission.bursts.length);
    let slot = 0;
    const l = (path: string) => live?.(index, path);
    const num = (path: string, v: ParticleNumber, scale = 1) => compileNum(v, scale, slot++, l(path));
    const col = (path: string, v: ParticleColor) => compileCol(v, l(path));
    this.lifeN = num("startLife", settings.startLife);
    this.speedN = num("startSpeed", settings.startSpeed);
    this.sizeN = num("startSize", settings.startSize);
    this.rotN = num("startRotation", settings.startRotation, DEG);
    this.colorC = col("startColor", settings.startColor);
    this.rateN = num("emission.rateOverTime", settings.emission.rateOverTime);
    this.distN = num("emission.rateOverDistance", settings.emission.rateOverDistance);
    this.burstN = settings.emission.bursts.map((b, i) => num(`emission.bursts.${i}.count`, b.count));
    this.gravityBox = l("gravity");
    this.tileN = num("renderer.startTile", settings.renderer.startTile);
    this.trailN = num("renderer.trailLength", settings.renderer.trailLength);
    let noises = 0;
    let width: Num | null = null;
    for (const [i, b] of settings.behaviors.entries()) {
      if (b.enabled === false) continue;
      const p = `behaviors.${i}.`;
      const made = this.behavior(b, p, num, col, noises);
      if (!made || made === "width") continue;
      if (made.k === "noise") noises++;
      this.behaviors[PHASE[made.k]].push(made);
    }
    for (const [i, b] of settings.behaviors.entries()) if (b.type === "widthOverLength" && b.enabled !== false) width = num(`behaviors.${i}.width`, b.width);
    this.width = width;
    this.noiseCount = noises;
    // The shape's rotation as a matrix (three's Euler "XYZ").
    const [rx, ry, rz] = settings.shape.rotation.map((d) => d * DEG);
    const a = Math.cos(rx);
    const b = Math.sin(rx);
    const c = Math.cos(ry);
    const d = Math.sin(ry);
    const e = Math.cos(rz);
    const f = Math.sin(rz);
    this.shapeR.set([c * e, -c * f, d, a * f + b * e * d, a * e - b * f * d, -b * c, b * f - a * e * d, b * e + a * f * d, a * c]);
  }

  private behavior(
    b: ParticleBehavior,
    p: string,
    num: (path: string, v: ParticleNumber, scale?: number) => Num,
    col: (path: string, v: ParticleColor) => Col,
    noises: number,
  ): Behave | "width" | null {
    switch (b.type) {
      case "colorOverLife":
        return { k: "color", c: col(p + "color", b.color), slot: 0 };
      case "sizeOverLife":
        return { k: "size", n: num(p + "size", b.size) };
      case "rotationOverLife":
        return { k: "rotation", n: num(p + "speed", b.speed, DEG) };
      case "speedOverLife":
        return { k: "speed", n: num(p + "speed", b.speed) };
      case "forceOverLife":
        return { k: "force", x: num(p + "x", b.x), y: num(p + "y", b.y), z: num(p + "z", b.z) };
      case "gravityPoint":
        return { k: "gpoint", c: [...b.center], s: b.strength };
      case "noise":
        return { k: "noise", f: num(p + "frequency", b.frequency), p: num(p + "power", b.power), pa: num(p + "positionAmount", b.positionAmount), ra: num(p + "rotationAmount", b.rotationAmount), idx: noises, slot: 0 };
      case "turbulence":
        return { k: "turb", scale: [...b.scale], oct: Math.max(1, Math.round(b.octaves)), vel: [...b.velocity], ts: [...b.timeScale], off: [0, 0, 0] };
      case "orbit":
        return { k: "orbit", n: num(p + "speed", b.speed, DEG), axis: [...b.axis] };
      case "frameOverLife":
        return { k: "frame", n: num(p + "frame", b.frame) };
      case "limitSpeed":
        return { k: "limit", n: num(p + "speed", b.speed), dampen: b.dampen };
      case "colorBySpeed":
        return { k: "cspeed", c: col(p + "color", b.color), min: b.min, max: b.max };
      case "sizeBySpeed":
        return { k: "sspeed", n: num(p + "size", b.size), min: b.min, max: b.max };
      case "widthOverLength":
        return "width";
      case "collision":
        return { k: "collision", h: b.height, bounce: b.bounce, kill: b.kill };
    }
  }

  /** True while this emitter can still emit (not a sub-emitter, not ended). */
  get emitActive(): boolean {
    return !this.subEmitter && !this.ended;
  }

  /** @internal */
  alloc(): SimParticle {
    let p = this.pool[this.count];
    if (!p) {
      p = new SimParticle();
      if (this.noiseCount) p.noise = new Float64Array(this.noiseCount * 4);
      this.pool.push(p);
    }
    this.count++;
    p.alive = true;
    p.serial++;
    return p;
  }

  /** @internal Remove particle `i` (swap with the last). */
  remove(i: number): void {
    const last = this.count - 1;
    const p = this.pool[i];
    p.alive = false;
    p.serial++;
    if (i !== last) {
      this.pool[i] = this.pool[last];
      this.pool[last] = p;
    }
    this.count = last;
  }
}

// --- the simulation -------------------------------------------------------------------------------------

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const WHITE: Tint = [1, 1, 1, 1];
/** Sub-emissions started in one step, at most (a guard against sub-emitter cycles). */
const SUB_BUDGET = 4096;

/**
 * One effect instance. Call `step` every frame with the node's world matrix; read `emitters[i].pool`
 * (the first `count` particles) to draw. Commands (`restart`, `startEmitter`, `endEmit`, `clear`,
 * `emit`) mirror what the three.quarks backend did with its systems.
 */
export class EffectSimulation {
  readonly emitters: SimEmitter[] = [];
  private readonly rnd: () => number;
  // The node's world matrix (column-major), its linear part, translation and inverses.
  private readonly m = new Float64Array(16);
  private readonly inv = new Float64Array(9);
  private readonly invT = new Float64Array(3);
  private scale = 1;
  private readonly tint = [1, 1, 1, 1];
  private budget = SUB_BUDGET;
  private prewarmPending = false;
  private readonly tmpO = new Float64Array(3);
  private readonly sample = new Float64Array(6);
  private readonly col = [0, 0, 0, 0];
  /** World down in the node's space (for local-space emitters). */
  private localGravity = [0, -1, 0];

  constructor(
    readonly effect: ParticleEffect,
    options: SimulationOptions = {},
  ) {
    this.rnd = options.random ?? Math.random;
    this.m.set(IDENTITY);
    this.computeInverse();
    const subs = subEmitterNames(effect);
    const byName = new Map<string, SimEmitter>();
    for (const [i, e] of effect.emitters.entries()) {
      if (!e.enabled || byName.has(e.name)) continue;
      const em = new SimEmitter(e, i, subs.has(e.name), options.live);
      byName.set(e.name, em);
      this.emitters.push(em);
    }
    for (const em of this.emitters) {
      for (const s of em.settings.subEmitters) {
        const target = byName.get(s.emitter);
        if (target && target !== em) em.subs.push({ target, trigger: s.trigger, probability: s.probability, inherit: s.inheritVelocity });
      }
    }
    this.prewarmPending = this.emitters.some((e) => e.needsPrewarm);
  }

  /** Live particles across every emitter. */
  get count(): number {
    let n = 0;
    for (const e of this.emitters) n += e.count;
    return n;
  }

  /** True while any (non-sub) emitter can still emit. */
  get emitting(): boolean {
    return this.emitters.some((e) => e.emitActive);
  }

  /** Set the frame's inputs: the node's world matrix (column-major), the emission scale and the tint (linear RGBA). */
  configure(world: ArrayLike<number>, scale: number, tint: Tint = WHITE): void {
    for (let i = 0; i < 16; i++) this.m[i] = world[i];
    this.computeInverse();
    this.scale = scale;
    for (let i = 0; i < 4; i++) this.tint[i] = tint[i];
  }

  /** Advance every emitter by `dt` seconds. */
  step(dt: number, world: ArrayLike<number>, scale = 1, tint: Tint = WHITE): void {
    this.configure(world, scale, tint);
    if (this.prewarmPending) this.prewarm();
    this.advanceAll(dt, null);
  }

  // --- commands ---------------------------------------------------------------------------------------

  /** Start every emitter from the beginning, removing their particles. */
  restart(): void {
    for (const e of this.emitters) {
      e.count = 0;
      for (const p of e.pool) p.alive = false;
      e.states.length = 0;
      this.startEmitter(e);
    }
  }

  /** Start one emitter's emission again (particles already out stay). */
  startEmitter(e: SimEmitter): void {
    e.st.reset();
    e.ended = false;
    e.delayLeft = e.subEmitter ? 0 : e.settings.startDelay;
    e.simTime = 0;
    e.needsPrewarm = !e.subEmitter && e.settings.looping && e.settings.prewarm;
    if (e.needsPrewarm) this.prewarmPending = true;
  }

  /** Stop emitting (particles live out their lives). */
  endEmit(e?: SimEmitter): void {
    for (const x of e ? [e] : this.emitters) {
      x.ended = true;
      x.needsPrewarm = false;
    }
  }

  /** Remove every particle (and pending sub-emissions), without stopping. */
  clear(): void {
    for (const e of this.emitters) {
      for (let i = 0; i < e.count; i++) e.pool[i].alive = false;
      e.count = 0;
      e.states.length = 0;
    }
  }

  /** Emit `count` particles at once from every non-sub emitter (not scaled, but limited by the particle limit). */
  emit(count: number): void {
    if (count <= 0) return;
    for (const e of this.emitters) {
      if (e.subEmitter) continue;
      const f = e.st.time / e.settings.duration;
      for (let i = 0; i < count; i++) this.spawn(e, f, this.shapeU(e, e.st, i, count), 0, 0, this.m[12], this.m[13], this.m[14], true, null);
    }
  }

  // --- stepping ---------------------------------------------------------------------------------------

  private prewarm(): void {
    this.prewarmPending = false;
    let longest = 0;
    for (const e of this.emitters)
      if (e.needsPrewarm) {
        longest = Math.max(longest, e.settings.duration);
        e.delayLeft = 0; // a prewarmed emitter has already been running
      }
    const run = (e: SimEmitter) => e.needsPrewarm || e.subEmitter;
    for (let t = 0; t < longest; t += PREWARM_STEP) this.advanceAll(PREWARM_STEP, run);
    for (const e of this.emitters) e.needsPrewarm = false;
  }

  private advanceAll(dt: number, only: ((e: SimEmitter) => boolean) | null): void {
    this.budget = SUB_BUDGET;
    this.localGravity = this.localDown();
    for (const e of this.emitters) {
      const on = !only || only(e);
      e.dtEff = 0;
      if (!on || dt <= 0) continue;
      let eff = dt;
      if (e.delayLeft > 0) {
        const used = Math.min(e.delayLeft, dt);
        e.delayLeft -= used;
        eff -= used;
      }
      e.dtEff = eff;
      e.simTime += dt;
    }
    // Phase A: age and move the particles.
    for (const e of this.emitters) {
      const on = !only || only(e);
      const max = Math.max(1, Math.floor(e.settings.maxParticles * this.scale));
      if (e.count > max) {
        for (let i = max; i < e.count; i++) e.pool[i].alive = false;
        e.count = max;
      }
      if (!on) continue;
      for (let i = e.count - 1; i >= 0; i--) {
        const p = e.pool[i];
        const left = this.update(e, p, dt);
        if (left >= 0) {
          this.died(e, p, left);
          e.remove(i);
        }
      }
    }
    // Phase B: emission, then triggered sub-emissions.
    for (const e of this.emitters) {
      if (e.subEmitter || e.ended || e.dtEff <= 0) continue;
      this.advanceEmission(e, e.st, e.dtEff, e.settings.looping, this.m[12], this.m[13], this.m[14], null, dt);
      if (e.st.done) e.ended = true;
    }
    for (const e of this.emitters) this.advanceSubStates(e, dt);
    // Phase C: world-space output, trails.
    for (const e of this.emitters) for (let i = 0; i < e.count; i++) this.finish(e, e.pool[i], dt > 0 && (!only || only(e)));
  }

  private advanceSubStates(e: SimEmitter, dt: number): void {
    const list = e.states;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      let step = s.pending > 0 ? s.pending : dt;
      s.pending = 0;
      if (s.parent) {
        const p = s.parent;
        if (p.alive && p.serial === s.serial && s.parentEmitter) {
          this.worldPos(s.parentEmitter, p, this.tmpO);
          s.ox = this.tmpO[0];
          s.oy = this.tmpO[1];
          s.oz = this.tmpO[2];
          this.worldVel(s.parentEmitter, p, s);
        } else {
          s.parent = null;
          if (s.frame) s.done = true;
        }
      }
      if (!s.done && step > 0) this.advanceEmission(e, s, step, s.frame, s.ox, s.oy, s.oz, s, dt);
    }
    // Drop finished ones.
    let w = 0;
    for (let i = 0; i < list.length; i++) if (!list[i].done) list[w++] = list[i];
    list.length = w;
  }

  /**
   * Emit for `dt` seconds of an emission state: rate, distance and bursts across the cycle(s) it
   * covers. `origin` is where the emission is in world space now; `sub` carries a sub-emission's
   * parent velocity. `frameDt` is the whole step (spawn times are offsets in it).
   */
  private advanceEmission(e: SimEmitter, st: EmissionState, dt: number, loop: boolean, ox: number, oy: number, oz: number, sub: SubState | null, frameDt: number): void {
    const dur = e.settings.duration;
    const hadLast = st.hasLast;
    const px = hadLast ? st.lx : ox;
    const py = hadLast ? st.ly : oy;
    const pz = hadLast ? st.lz : oz;
    const dist = Math.hypot(ox - px, oy - py, oz - pz);
    st.lx = ox;
    st.ly = oy;
    st.lz = oz;
    st.hasLast = true;
    // Where in the frame this emission starts (a delayed emitter starts later in the step).
    const start = Math.max(0, frameDt - dt);
    let left = dt;
    let s0 = start;
    const rate = (frac: number) => evalNum(e.rateN, frac, this.rnd()) * this.scale;
    const spawnAt = (s: number, frac: number, u: number) => {
      const f = frameDt > 0 ? Math.min(1, Math.max(0, s / frameDt)) : 1;
      this.spawn(e, frac, u, s, frameDt, px + (ox - px) * f, py + (oy - py) * f, pz + (oz - pz) * f, !sub, sub);
    };
    for (let guard = 0; left > 1e-9 && guard < 256; guard++) {
      const t0 = st.time;
      const seg = Math.min(left, Math.max(1e-9, dur - t0));
      const t1 = t0 + seg;
      const frac = t0 / dur;
      const r = rate(frac);
      if (r > 0) {
        st.accum += r * seg;
        const n = Math.floor(st.accum);
        st.accum -= n;
        for (let i = 0; i < n; i++) spawnAt(s0 + (seg * (i + 0.5)) / n, frac, this.shapeU(e, st, -1, 0));
      }
      if (dist > 0) {
        const rod = evalNum(e.distN, frac, this.rnd()) * this.scale;
        if (rod > 0) {
          st.distAccum += rod * dist * (seg / dt);
          const n = Math.floor(st.distAccum);
          st.distAccum -= n;
          for (let i = 0; i < n; i++) spawnAt(s0 + (seg * (i + 0.5)) / n, frac, this.shapeU(e, st, -1, 0));
        }
      }
      for (const [bi, b] of e.settings.emission.bursts.entries()) {
        let k = st.burstNext[bi];
        while (k < b.cycles) {
          const ft = b.time + k * b.interval;
          if (ft >= t1) break;
          k++;
          if (!(b.probability >= 1 || this.rnd() < b.probability)) continue;
          const n = Math.max(0, Math.round(evalNum(e.burstN[bi], ft / dur, this.rnd()) * this.scale));
          const at = s0 + Math.min(seg, Math.max(0, ft - t0));
          for (let j = 0; j < n; j++) spawnAt(at, ft / dur, this.shapeU(e, st, j, n));
        }
        st.burstNext[bi] = k;
      }
      st.time = t1;
      left -= seg;
      s0 += seg;
      if (st.time >= dur - 1e-9) {
        if (loop) {
          st.time = 0;
          st.burstNext.fill(0);
        } else {
          st.done = true;
          break;
        }
      }
    }
  }

  /** 0-1 position around the shape's arc for the next particle (by the shape's mode). */
  private shapeU(e: SimEmitter, st: EmissionState, j: number, n: number): number {
    const s = e.settings.shape;
    switch (s.mode) {
      case "random":
        return this.rnd();
      case "burst":
        return j >= 0 && n > 0 ? j / n : this.rnd();
      case "loop":
      case "pingpong": {
        let x: number;
        if (s.spread > 0) {
          st.cursor += s.spread;
          x = st.cursor;
        } else x = st.time / e.settings.duration;
        if (s.mode === "loop") return x - Math.floor(x);
        const m = x - 2 * Math.floor(x / 2);
        return m < 1 ? m : 2 - m;
      }
    }
  }

  /** Make a particle: its start values, position and velocity, then age it by what's left of the step. */
  private spawn(e: SimEmitter, frac: number, u: number, s: number, frameDt: number, ox: number, oy: number, oz: number, primary: boolean, sub: SubState | null): void {
    const max = Math.max(1, Math.floor(e.settings.maxParticles * this.scale));
    if (e.count >= max) return;
    const rnd = this.rnd;
    const p = e.alloc();
    p.seed = rnd();
    p.age = 0;
    p.life = Math.max(0.001, evalNum(e.lifeN, frac, rnd()));
    const speed = evalNum(e.speedN, frac, rnd());
    p.startSize = Math.max(0, evalNum(e.sizeN, frac, rnd()));
    p.rotation = evalNum(e.rotN, frac, rnd());
    evalCol(e.colorC, frac, rnd(), this.col);
    p.startR = this.col[0] * this.tint[0];
    p.startG = this.col[1] * this.tint[1];
    p.startB = this.col[2] * this.tint[2];
    p.startA = this.col[3] * this.tint[3];
    p.startTile = evalNum(e.tileN, frac, rnd()); // floored when drawn; the fraction blends tiles
    p.speedMod = 1;
    p.noise.fill(0);
    // Position and direction in the node's space.
    const sm = this.sample;
    this.sampleShape(e, u, sm);
    const R = e.shapeR;
    const o = e.settings.shape.position;
    const nx = R[0] * sm[0] + R[1] * sm[1] + R[2] * sm[2] + o[0];
    const ny = R[3] * sm[0] + R[4] * sm[1] + R[5] * sm[2] + o[1];
    const nz = R[6] * sm[0] + R[7] * sm[1] + R[8] * sm[2] + o[2];
    const dx = R[0] * sm[3] + R[1] * sm[4] + R[2] * sm[5];
    const dy = R[3] * sm[3] + R[4] * sm[4] + R[5] * sm[5];
    const dz = R[6] * sm[3] + R[7] * sm[4] + R[8] * sm[5];
    if (!e.world && primary) {
      p.x = nx;
      p.y = ny;
      p.z = nz;
      p.vx = dx * speed;
      p.vy = dy * speed;
      p.vz = dz * speed;
    } else {
      const m = this.m;
      let wx = m[0] * nx + m[4] * ny + m[8] * nz + ox;
      let wy = m[1] * nx + m[5] * ny + m[9] * nz + oy;
      let wz = m[2] * nx + m[6] * ny + m[10] * nz + oz;
      let vx = m[0] * dx + m[4] * dy + m[8] * dz;
      let vy = m[1] * dx + m[5] * dy + m[9] * dz;
      let vz = m[2] * dx + m[6] * dy + m[10] * dz;
      const len = Math.hypot(vx, vy, vz);
      const k = len > 1e-9 ? speed / len : 0;
      vx *= k;
      vy *= k;
      vz *= k;
      if (sub?.inherit) {
        vx += sub.pvx;
        vy += sub.pvy;
        vz += sub.pvz;
      }
      if (e.world) {
        p.x = wx;
        p.y = wy;
        p.z = wz;
        p.vx = vx;
        p.vy = vy;
        p.vz = vz;
      } else {
        const v = this.inv;
        const t = this.invT;
        const lx = v[0] * wx + v[1] * wy + v[2] * wz + t[0];
        const ly = v[3] * wx + v[4] * wy + v[5] * wz + t[1];
        const lz = v[6] * wx + v[7] * wy + v[8] * wz + t[2];
        p.x = lx;
        p.y = ly;
        p.z = lz;
        p.vx = v[0] * vx + v[1] * vy + v[2] * vz;
        p.vy = v[3] * vx + v[4] * vy + v[5] * vz;
        p.vz = v[6] * vx + v[7] * vy + v[8] * vz;
        wx = wy = wz = 0;
      }
    }
    if (e.trailOn) {
      const cap = Math.min(256, Math.max(2, Math.round(evalNum(e.trailN, 0, rnd()))));
      p.trailCap = cap;
      if (p.trail.length < cap * 3) p.trail = new Float32Array(cap * 3);
      p.trailCount = 0;
      p.trailHead = 0;
    }
    this.appearance(e, p, 0);
    // Birth sub-emitters, then catch up with the rest of the frame.
    for (const l of e.subs) if (l.trigger !== "death") this.trigger(e, p, l, Math.max(0, frameDt - s));
    const rem = Math.max(0, frameDt - s);
    if (rem > 0) {
      const left = this.update(e, p, rem);
      if (left >= 0) {
        this.died(e, p, left);
        e.remove(e.count - 1);
      }
    }
  }

  private trigger(e: SimEmitter, p: SimParticle, l: SubLink, pending: number): void {
    if (this.budget <= 0) return;
    if (!(l.probability >= 1 || this.rnd() < l.probability)) return;
    this.budget--;
    const s = new SubState(l.target.settings.emission.bursts.length);
    s.parent = l.trigger === "death" ? null : p;
    s.parentEmitter = e;
    s.serial = p.serial;
    s.inherit = l.inherit;
    s.frame = l.trigger === "frame";
    s.pending = pending;
    this.worldPos(e, p, this.tmpO);
    s.ox = this.tmpO[0];
    s.oy = this.tmpO[1];
    s.oz = this.tmpO[2];
    this.worldVel(e, p, s);
    l.target.states.push(s);
  }

  private died(e: SimEmitter, p: SimParticle, left: number): void {
    for (const l of e.subs) if (l.trigger === "death") this.trigger(e, p, l, left);
  }

  // --- one particle -------------------------------------------------------------------------------------

  /** Age and move `p` by `dt`. Returns -1 while it lives, or the seconds of `dt` left when it died. */
  private update(e: SimEmitter, p: SimParticle, dt: number): number {
    let step = dt;
    let dies = false;
    if (p.age + dt >= p.life) {
      step = Math.max(0, p.life - p.age);
      dies = true;
    }
    p.age += step;
    const t = Math.min(1, p.age / p.life);
    const seed = p.seed;
    if (step > 0) {
      const g = e.gravityBox ? (typeof e.gravityBox.value === "number" ? e.gravityBox.value : (e.gravityBox.value[0] ?? 0)) * GRAVITY : GRAVITY * e.settings.gravity;
      if (g !== 0) {
        if (e.world) p.vy -= g * step;
        else {
          p.vx += this.localGravity[0] * g * step;
          p.vy += this.localGravity[1] * g * step;
          p.vz += this.localGravity[2] * g * step;
        }
      }
      for (const b of e.behaviors[0]) this.velocityBehavior(e, p, b, t, seed, step);
      // speed-over-life scales the motion, not the velocity
      p.speedMod = 1;
      const late = e.behaviors[3];
      for (let i = 0; i < late.length; i++) {
        const b = late[i];
        if (b.k === "speed") p.speedMod *= evalNum(b.n, t, stable(seed, 1000 + i));
      }
      p.x += p.vx * p.speedMod * step;
      p.y += p.vy * p.speedMod * step;
      p.z += p.vz * p.speedMod * step;
      for (const b of e.behaviors[1]) this.positionBehavior(e, p, b, t, seed, step);
      for (const b of e.behaviors[2]) {
        if (b.k !== "collision" || p.y >= b.h) continue;
        if (b.kill) {
          dies = true;
          p.age = p.life;
          break;
        }
        p.y = b.h;
        if (p.vy < 0) p.vy = -p.vy * b.bounce;
      }
    }
    this.appearance(e, p, step);
    if (dies) return Math.max(0, dt - step);
    return -1;
  }

  private velocityBehavior(e: SimEmitter, p: SimParticle, b: Behave, t: number, seed: number, dt: number): void {
    switch (b.k) {
      case "force":
        p.vx += evalNum(b.x, t, stable(seed, 2000)) * dt;
        p.vy += evalNum(b.y, t, stable(seed, 2001)) * dt;
        p.vz += evalNum(b.z, t, stable(seed, 2002)) * dt;
        return;
      case "gpoint": {
        const dx = b.c[0] - p.x;
        const dy = b.c[1] - p.y;
        const dz = b.c[2] - p.z;
        const len = Math.hypot(dx, dy, dz);
        if (len < 1e-6) return;
        const a = (b.s / Math.max(len * len, 0.0625)) * dt;
        p.vx += (dx / len) * a;
        p.vy += (dy / len) * a;
        p.vz += (dz / len) * a;
        return;
      }
      case "turb": {
        let nx = 0;
        let ny = 0;
        let nz = 0;
        let lvl = 1;
        const x = p.x / (b.scale[0] || 1);
        const y = p.y / (b.scale[1] || 1);
        const z = p.z / (b.scale[2] || 1);
        const time = e.simTime;
        for (let i = 0; i < b.oct; i++) {
          nx += noise3(x * lvl + time * b.ts[0] * lvl, y * lvl, z * lvl) / lvl;
          ny += noise3(x * lvl + 31.7, y * lvl + time * b.ts[1] * lvl, z * lvl) / lvl;
          nz += noise3(x * lvl, y * lvl + 17.3, z * lvl + time * b.ts[2] * lvl) / lvl;
          lvl *= 2;
        }
        p.vx += nx * b.vel[0] * dt;
        p.vy += ny * b.vel[1] * dt;
        p.vz += nz * b.vel[2] * dt;
        return;
      }
      case "limit": {
        const limit = evalNum(b.n, t, stable(seed, 2003));
        const speed = Math.hypot(p.vx, p.vy, p.vz);
        if (speed <= limit || speed < 1e-9) return;
        // dampen 1 clamps at once; less eases towards the limit (per 1/60 s, so frame rate doesn't matter)
        const k = 1 - Math.pow(1 - Math.min(1, Math.max(0, b.dampen)), dt * 60);
        const f = 1 + k * (Math.max(0, limit) / speed - 1);
        p.vx *= f;
        p.vy *= f;
        p.vz *= f;
        return;
      }
      default:
    }
  }

  private positionBehavior(e: SimEmitter, p: SimParticle, b: Behave, t: number, seed: number, dt: number): void {
    switch (b.k) {
      case "noise": {
        const f = evalNum(b.f, t, stable(seed, 2100));
        const power = evalNum(b.p, t, stable(seed, 2101));
        const pa = evalNum(b.pa, t, stable(seed, 2102));
        const ra = evalNum(b.ra, t, stable(seed, 2103));
        const o = b.idx * 4;
        const n = p.noise;
        const at = p.age * f;
        const off = (i: number) => stable(seed, 3000 + b.idx * 8 + i) * 100;
        if (pa > 0) {
          p.x -= n[o];
          p.y -= n[o + 1];
          p.z -= n[o + 2];
          n[o] = noise3(off(0) + at, 0.5, 0) * power * pa;
          n[o + 1] = noise3(off(1) + at, 0.5, 0) * power * pa;
          n[o + 2] = noise3(off(2) + at, 0.5, 0) * power * pa;
          p.x += n[o];
          p.y += n[o + 1];
          p.z += n[o + 2];
        }
        if (ra > 0) {
          p.rotation -= n[o + 3];
          n[o + 3] = noise3(off(3) + at, 0.5, 0) * Math.PI * power * ra;
          p.rotation += n[o + 3];
        }
        return;
      }
      case "orbit": {
        let [ax, ay, az] = b.axis;
        let cx = 0;
        let cy = 0;
        let cz = 0;
        if (e.world) {
          // About the node's origin, around the axis as the node orients it.
          const m = this.m;
          const rx = m[0] * ax + m[4] * ay + m[8] * az;
          const ry = m[1] * ax + m[5] * ay + m[9] * az;
          const rz = m[2] * ax + m[6] * ay + m[10] * az;
          ax = rx;
          ay = ry;
          az = rz;
          cx = m[12];
          cy = m[13];
          cz = m[14];
        }
        const len = Math.hypot(ax, ay, az);
        if (len < 1e-9) return;
        ax /= len;
        ay /= len;
        az /= len;
        const angle = evalNum(b.n, t, stable(seed, 2104)) * dt;
        const rx = p.x - cx;
        const ry = p.y - cy;
        const rz = p.z - cz;
        const dot = rx * ax + ry * ay + rz * az;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        // Rodrigues: v cos + (a x v) sin + a (a . v)(1 - cos)
        p.x = cx + rx * c + (ay * rz - az * ry) * s + ax * dot * (1 - c);
        p.y = cy + ry * c + (az * rx - ax * rz) * s + ay * dot * (1 - c);
        p.z = cz + rz * c + (ax * ry - ay * rx) * s + az * dot * (1 - c);
        return;
      }
      default:
    }
  }

  /** Size, rotation, colour and tile at the particle's age. */
  private appearance(e: SimEmitter, p: SimParticle, dt: number): void {
    const t = Math.min(1, p.age / p.life);
    const seed = p.seed;
    p.t = t;
    let size = p.startSize;
    let r = p.startR;
    let g = p.startG;
    let b = p.startB;
    let a = p.startA;
    let tile = p.startTile;
    const speed = Math.hypot(p.vx, p.vy, p.vz) * p.speedMod;
    const col = this.col;
    let i = 0;
    for (const bh of e.behaviors[3]) {
      i++;
      switch (bh.k) {
        case "color":
          evalCol(bh.c, t, stable(seed, 4000 + i), col);
          r *= col[0];
          g *= col[1];
          b *= col[2];
          a *= col[3];
          break;
        case "cspeed": {
          const f = bh.max > bh.min ? Math.min(1, Math.max(0, (speed - bh.min) / (bh.max - bh.min))) : 0;
          evalCol(bh.c, f, stable(seed, 4000 + i), col);
          r *= col[0];
          g *= col[1];
          b *= col[2];
          a *= col[3];
          break;
        }
        case "size":
          size *= evalNum(bh.n, t, stable(seed, 4000 + i));
          break;
        case "sspeed": {
          const f = bh.max > bh.min ? Math.min(1, Math.max(0, (speed - bh.min) / (bh.max - bh.min))) : 0;
          size *= evalNum(bh.n, f, stable(seed, 4000 + i));
          break;
        }
        case "rotation":
          if (dt > 0) p.rotation += evalNum(bh.n, t, stable(seed, 4000 + i)) * dt;
          break;
        case "frame":
          tile = evalNum(bh.n, t, stable(seed, 4000 + i));
          break;
        default:
      }
    }
    p.size = Math.max(0, size);
    p.r = r;
    p.g = g;
    p.b = b;
    p.a = a;
    const whole = Math.floor(tile);
    p.tile = ((whole % e.tiles) + e.tiles) % e.tiles;
    p.tileBlend = tile - whole;
    if (e.renderer.mode === "stretched") p.length = p.size * e.renderer.lengthScale + speed * e.renderer.speedScale;
    else p.length = p.size;
  }

  /** World-space output and trail history. */
  private finish(e: SimEmitter, p: SimParticle, advanced: boolean): void {
    this.worldPos(e, p, this.tmpO);
    p.wx = this.tmpO[0];
    p.wy = this.tmpO[1];
    p.wz = this.tmpO[2];
    const vx = p.vx * p.speedMod;
    const vy = p.vy * p.speedMod;
    const vz = p.vz * p.speedMod;
    if (e.world) {
      p.wvx = vx;
      p.wvy = vy;
      p.wvz = vz;
    } else {
      const m = this.m;
      p.wvx = m[0] * vx + m[4] * vy + m[8] * vz;
      p.wvy = m[1] * vx + m[5] * vy + m[9] * vz;
      p.wvz = m[2] * vx + m[6] * vy + m[10] * vz;
    }
    if (e.trailOn && p.trailCap > 0 && (advanced || p.trailCount === 0)) {
      const i = p.trailHead * 3;
      p.trail[i] = p.wx;
      p.trail[i + 1] = p.wy;
      p.trail[i + 2] = p.wz;
      p.trailHead = (p.trailHead + 1) % p.trailCap;
      if (p.trailCount < p.trailCap) p.trailCount++;
    }
  }

  // --- spaces ---------------------------------------------------------------------------------------------

  private worldPos(e: SimEmitter, p: SimParticle, out: Float64Array): void {
    if (e.world) {
      out[0] = p.x;
      out[1] = p.y;
      out[2] = p.z;
      return;
    }
    const m = this.m;
    out[0] = m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12];
    out[1] = m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13];
    out[2] = m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14];
  }

  private worldVel(e: SimEmitter, p: SimParticle, s: SubState): void {
    const vx = p.vx * p.speedMod;
    const vy = p.vy * p.speedMod;
    const vz = p.vz * p.speedMod;
    if (e.world) {
      s.pvx = vx;
      s.pvy = vy;
      s.pvz = vz;
    } else {
      const m = this.m;
      s.pvx = m[0] * vx + m[4] * vy + m[8] * vz;
      s.pvy = m[1] * vx + m[5] * vy + m[9] * vz;
      s.pvz = m[2] * vx + m[6] * vy + m[10] * vz;
    }
  }

  /** World down (0, -1, 0) in the node's space (for local-space emitters it turns with the node). */
  private localDown(): number[] {
    const v = this.inv;
    return [-v[1], -v[4], -v[7]];
  }

  private computeInverse(): void {
    const m = this.m;
    const a = m[0];
    const b = m[4];
    const c = m[8];
    const d = m[1];
    const e = m[5];
    const f = m[9];
    const g = m[2];
    const h = m[6];
    const i = m[10];
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    const v = this.inv;
    if (Math.abs(det) < 1e-12) {
      v.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
      this.invT.set([-m[12], -m[13], -m[14]]);
      return;
    }
    const k = 1 / det;
    v[0] = (e * i - f * h) * k;
    v[1] = (c * h - b * i) * k;
    v[2] = (b * f - c * e) * k;
    v[3] = (f * g - d * i) * k;
    v[4] = (a * i - c * g) * k;
    v[5] = (c * d - a * f) * k;
    v[6] = (d * h - e * g) * k;
    v[7] = (b * g - a * h) * k;
    v[8] = (a * e - b * d) * k;
    this.invT.set([-(v[0] * m[12] + v[1] * m[13] + v[2] * m[14]), -(v[3] * m[12] + v[4] * m[13] + v[5] * m[14]), -(v[6] * m[12] + v[7] * m[13] + v[8] * m[14])]);
  }

  // --- shapes -----------------------------------------------------------------------------------------------

  /** A position and a unit direction (emitting along +Y) in the shape's own space: `out` = [px, py, pz, dx, dy, dz]. */
  private sampleShape(e: SimEmitter, u: number, out: Float64Array): void {
    const s = e.settings.shape;
    const rnd = this.rnd;
    const theta = u * s.arc * DEG;
    const th = Math.min(1, Math.max(0, s.thickness));
    const inner = 1 - th;
    out[3] = 0;
    out[4] = 1;
    out[5] = 0;
    out[0] = out[1] = out[2] = 0;
    switch (s.type) {
      case "point":
        return;
      case "sphere":
      case "hemisphere": {
        const cosP = s.type === "sphere" ? 2 * rnd() - 1 : rnd();
        const sinP = Math.sqrt(Math.max(0, 1 - cosP * cosP));
        const dx = sinP * Math.cos(theta);
        const dz = sinP * Math.sin(theta);
        const r = s.radius * Math.cbrt(inner * inner * inner + rnd() * (1 - inner * inner * inner));
        out[0] = dx * r;
        out[1] = cosP * r;
        out[2] = dz * r;
        out[3] = dx;
        out[4] = cosP;
        out[5] = dz;
        return;
      }
      case "cone": {
        const rr = Math.sqrt(inner * inner + rnd() * (1 - inner * inner));
        out[0] = Math.cos(theta) * s.radius * rr;
        out[2] = Math.sin(theta) * s.radius * rr;
        const ang = s.angle * DEG * (s.radius > 0 ? rr : Math.sqrt(rnd()));
        out[3] = Math.sin(ang) * Math.cos(theta);
        out[4] = Math.cos(ang);
        out[5] = Math.sin(ang) * Math.sin(theta);
        return;
      }
      case "circle": {
        const rr = Math.sqrt(inner * inner + rnd() * (1 - inner * inner));
        out[0] = Math.cos(theta) * s.radius * rr;
        out[2] = Math.sin(theta) * s.radius * rr;
        if (rr > 0 && s.radius > 0) {
          out[3] = Math.cos(theta);
          out[4] = 0;
          out[5] = Math.sin(theta);
        }
        return;
      }
      case "donut": {
        const cx = Math.cos(theta);
        const cz = Math.sin(theta);
        const psi = rnd() * TAU;
        const tr = s.donutRadius * Math.sqrt(inner * inner + rnd() * (1 - inner * inner));
        const ox = tr * Math.cos(psi) * cx;
        const oy = tr * Math.sin(psi);
        const oz = tr * Math.cos(psi) * cz;
        out[0] = cx * s.radius + ox;
        out[1] = oy;
        out[2] = cz * s.radius + oz;
        const len = Math.hypot(ox, oy, oz);
        if (len > 1e-9) {
          out[3] = ox / len;
          out[4] = oy / len;
          out[5] = oz / len;
        } else {
          out[3] = cx;
          out[4] = 0;
          out[5] = cz;
        }
        return;
      }
      case "rectangle": {
        let x = u - 0.5;
        let z = rnd() - 0.5;
        if (th < 1) {
          // Only a frame of the rectangle: push points inside the inner part out to the nearest edge.
          const ix = 0.5 * inner;
          if (Math.abs(x) < ix && Math.abs(z) < ix) {
            if (0.5 - Math.abs(x) < 0.5 - Math.abs(z)) x = Math.sign(x || 1) * 0.5;
            else z = Math.sign(z || 1) * 0.5;
          }
        }
        out[0] = x * s.width;
        out[2] = z * s.height;
        return;
      }
      case "grid": {
        const cols = Math.max(1, s.columns);
        const rows = Math.max(1, s.rows);
        const idx = s.mode === "random" ? Math.floor(rnd() * cols * rows) : Math.min(cols * rows - 1, Math.floor(u * cols * rows));
        out[0] = (((idx % cols) + 0.5) / cols - 0.5) * s.width;
        out[2] = ((Math.floor(idx / cols) + 0.5) / rows - 0.5) * s.height;
        return;
      }
    }
  }
}
