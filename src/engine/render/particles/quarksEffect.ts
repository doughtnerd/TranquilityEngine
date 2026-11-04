// Internal (ADR 0057, 0060): translates effect settings (compiled from particle graphs by
// `compileParticleGraph`) into three.quarks particle systems.
// three.js and quarks types are allowed here and never reach the public API (ADR 0010).
import { Color, Euler, type BufferGeometry, type Material, Matrix4, SRGBColorSpace } from "three";
import {
  ApplyForce,
  Bezier,
  CircleEmitter,
  ColorBySpeed,
  ColorOverLife,
  ColorRange,
  ConeEmitter,
  ConstantColor,
  ConstantValue,
  DonutEmitter,
  EmitSubParticleSystem,
  EmitterMode,
  ForceOverLife,
  FrameOverLife,
  Gradient,
  GravityForce,
  GridEmitter,
  HemisphereEmitter,
  IntervalValue,
  LimitSpeedOverLife,
  Noise,
  OrbitOverLife,
  ParticleSystem,
  PiecewiseBezier,
  PointEmitter,
  RandomColorBetweenGradient,
  RectangleEmitter,
  RenderMode,
  RotationOverLife,
  SizeBySpeed,
  SizeOverLife,
  SpeedOverLife,
  SphereEmitter,
  SubParticleEmitMode,
  TurbulenceField,
  Vector3 as QVector3,
  Vector4 as QVector4,
  WidthOverLength,
  type Behavior,
  type EmitterShape,
  type FunctionColorGenerator,
  type FunctionValueGenerator,
  type GeneratorMemory,
  type IParticleSystem,
  type Particle,
  type ValueGenerator,
  type ColorGenerator,
} from "three.quarks";
import {
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
  type ParticleShape,
} from "../../scene/particles";

const DEG = Math.PI / 180;
const GRAVITY = 9.81;

type NumberGen = ValueGenerator | FunctionValueGenerator;

/** What building an effect needs from the render backend. */
export interface EffectContext {
  /** The material an emitter draws with, or null while it (or its texture) is loading. */
  material(renderer: ParticleRenderer): Material | null;
  /** Mesh mode: the geometry of a built-in mesh or model asset, or null while loading. */
  geometry(mesh: string): BufferGeometry | null;
  /** Multiplies emission and max particles (quality tier × the component's emission scale); read every frame. */
  readonly scale: { value: number };
  /** Multiplies start colours (linear RGB and alpha); read as each particle is born, so it can change live. */
  readonly tint: { value: [number, number, number, number] };
  /**
   * A live value for an emitter's settings field (`startSpeed`, `behaviors.2.size`…; ADR 0060's
   * bindings), or undefined to build it from the settings. Numbers are read as is; colours as
   * linear RGBA. The caller writes the box each frame.
   */
  live?(emitter: number, path: string): LiveBox | undefined;
}

/** A value the caller updates in place: a number, or linear RGBA for colours. */
export interface LiveBox {
  value: number | number[];
}

/** One emitter of a built effect. */
export interface BuiltEmitter {
  name: string;
  system: ParticleSystem;
  /** The shape's offset and rotation from the node (applied after the node's world matrix). */
  shapeMatrix: Matrix4;
  startDelay: number;
  looping: boolean;
  duration: number;
  /** Emits only when another emitter triggers it. */
  subEmitter: boolean;
}

/** Build every enabled emitter of `effect`, or null if something it needs is still loading. */
export function buildEffect(effect: ParticleEffect, ctx: EffectContext): BuiltEmitter[] | null {
  // Everything loaded first, so a slow texture doesn't build and throw away the other emitters each frame.
  for (const e of effect.emitters) {
    if (!e.enabled) continue;
    if (!ctx.material(e.renderer)) return null;
    if (e.renderer.mode === "mesh" && !ctx.geometry(e.renderer.mesh)) return null;
  }
  const subs = subEmitterNames(effect);
  const built = new Map<string, BuiltEmitter>();
  const out: BuiltEmitter[] = [];
  for (const [index, e] of effect.emitters.entries()) {
    if (!e.enabled || built.has(e.name)) continue;
    const b = buildEmitter(e, index, ctx, subs.has(e.name));
    if (!b) {
      for (const x of out) x.system.dispose();
      return null;
    }
    built.set(e.name, b);
    out.push(b);
  }
  // Sub-emitters, once every system exists.
  for (const e of effect.emitters) {
    const parent = built.get(e.name);
    if (!parent) continue;
    for (const s of e.subEmitters) {
      const child = built.get(s.emitter);
      if (!child || child === parent) continue;
      const mode = s.trigger === "birth" ? SubParticleEmitMode.Birth : s.trigger === "frame" ? SubParticleEmitMode.Frame : SubParticleEmitMode.Death;
      parent.system.addBehavior(new EmitSubParticleSystem(parent.system, s.inheritVelocity, child.system.emitter, mode, s.probability));
    }
  }
  return out;
}

function buildEmitter(e: ParticleEmitterSettings, index: number, ctx: EffectContext, subEmitter: boolean): BuiltEmitter | null {
  const r = e.renderer;
  const material = ctx.material(r);
  if (!material) return null;
  const geometry = r.mode === "mesh" ? ctx.geometry(r.mesh) : null;
  if (r.mode === "mesh" && !geometry) return null;

  const max = { value: e.maxParticles };
  let system: ParticleSystem | null = null;
  const count = () => system?.particleNum ?? 0;
  const room = () => Math.max(0, Math.floor(max.value * ctx.scale.value) - count());
  const capped = (g: NumberGen) => new Capped(g, ctx.scale, room, false);
  const cappedBurst = (g: NumberGen) => new Capped(g, ctx.scale, room, true);
  const gens: Gens = {
    num: (path, v, scale = 1) => {
      const box = ctx.live?.(index, path);
      return box ? new LiveValue(box, scale) : numberGen(v, scale);
    },
    color: (path, v, overLife) => {
      const box = ctx.live?.(index, path);
      return box ? new LiveColor(box) : overLife ? colorOverLifeGen(v) : colorGen(v);
    },
  };

  system = new ParticleSystem({
    duration: e.duration,
    looping: e.looping,
    prewarm: e.prewarm,
    autoDestroy: false,
    worldSpace: e.space === "world",
    startLife: gens.num("startLife", e.startLife),
    startSpeed: gens.num("startSpeed", e.startSpeed),
    startSize: gens.num("startSize", e.startSize),
    startRotation: gens.num("startRotation", e.startRotation, DEG),
    startColor: new Tinted(gens.color("startColor", e.startColor, false), ctx.tint),
    emissionOverTime: capped(gens.num("emission.rateOverTime", e.emission.rateOverTime)),
    emissionOverDistance: capped(gens.num("emission.rateOverDistance", e.emission.rateOverDistance)),
    emissionBursts: e.emission.bursts.map((b, i) => ({ time: b.time, count: cappedBurst(gens.num(`emission.bursts.${i}.count`, b.count)), cycle: b.cycles, interval: b.interval, probability: b.probability })),
    onlyUsedByOther: subEmitter,
    shape: shapeOf(e.shape),
    material,
    renderMode: RENDER_MODES[r.mode],
    rendererEmitterSettings:
      r.mode === "stretched"
        ? { speedFactor: r.speedScale, lengthFactor: r.lengthScale }
        : r.mode === "trail"
          ? { startLength: numberGen(r.trailLength), followLocalOrigin: false }
          : r.mode === "mesh"
            ? { startRotationX: new ConstantValue(0), startRotationY: new ConstantValue(0), startRotationZ: new ConstantValue(0) }
            : {},
    instancingGeometry: geometry ?? undefined,
    uTileCount: r.tiles[0],
    vTileCount: r.tiles[1],
    startTileIndex: numberGen(r.startTile) as ValueGenerator,
    blendTiles: r.blendTiles,
    renderOrder: r.renderOrder,
  });
  // First, so particles from bursts and sub-emitters beyond the limit go before anything else runs.
  const sys = system;
  sys.addBehavior(new CapParticles(sys, () => Math.max(1, Math.floor(max.value * ctx.scale.value))));
  const liveGravity = ctx.live?.(index, "gravity");
  if (e.gravity !== 0 || liveGravity) system.addBehavior(new ApplyForce(new QVector3(0, -1, 0), liveGravity ? new LiveValue(liveGravity, GRAVITY) : new ConstantValue(GRAVITY * e.gravity)));
  for (const [i, b] of e.behaviors.entries()) {
    if (b.enabled === false) continue;
    const behavior = behaviorOf(b, scoped(gens, `behaviors.${i}.`));
    if (behavior) system.addBehavior(behavior);
  }
  const s = e.shape;
  // quarks' shapes emit along +Z; ours along +Y (a cone opens upwards), like Unity's default particle system.
  const shapeMatrix = new Matrix4()
    .makeRotationFromEuler(new Euler(s.rotation[0] * DEG, s.rotation[1] * DEG, s.rotation[2] * DEG))
    .setPosition(s.position[0], s.position[1], s.position[2])
    .multiply(new Matrix4().makeRotationX(-Math.PI / 2));
  return { name: e.name, system, shapeMatrix, startDelay: e.startDelay, looping: e.looping, duration: e.duration, subEmitter };
}

const RENDER_MODES: Record<ParticleRenderer["mode"], RenderMode> = {
  billboard: RenderMode.BillBoard,
  stretched: RenderMode.StretchedBillBoard,
  horizontal: RenderMode.HorizontalBillBoard,
  vertical: RenderMode.VerticalBillBoard,
  mesh: RenderMode.Mesh,
  trail: RenderMode.Trail,
};

// --- values ---------------------------------------------------------------------------------------

/** A curve as quarks' piecewise Bézier: one straight segment between each pair of keys, flat beyond the ends. */
export function curveGen(keys: readonly CurveKey[], scale = 1): PiecewiseBezier {
  const k = keys.length ? keys.map(([t, v]) => [t, v * scale] as CurveKey) : [[0, 0] as CurveKey];
  const pts: CurveKey[] = [...k];
  if (pts[0][0] > 0) pts.unshift([0, pts[0][1]]);
  if (pts[pts.length - 1][0] < 1) pts.push([1, pts[pts.length - 1][1]]);
  const segments: [Bezier, number][] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [t0, v0] = pts[i];
    const [t1, v1] = pts[i + 1];
    if (t1 <= t0) continue;
    const d = v1 - v0;
    segments.push([new Bezier(v0, v0 + d / 3, v0 + (2 * d) / 3, v1), t0]);
  }
  if (!segments.length) segments.push([new Bezier(pts[0][1], pts[0][1], pts[0][1], pts[0][1]), 0]);
  return new PiecewiseBezier(segments);
}

/** A number value as a quarks generator, times `scale` (degrees to radians, say). */
export function numberGen(v: ParticleNumber, scale = 1): NumberGen {
  if (typeof v === "number") return new ConstantValue(v * scale);
  if ("random" in v) return new IntervalValue(v.random[0] * scale, v.random[1] * scale);
  if ("curve" in v) return curveGen(v.curve, scale);
  return new RandomBetweenCurves(curveGen(v.randomCurves[0], scale), curveGen(v.randomCurves[1], scale));
}

const tmpColor = new Color();

/** sRGB components (0–1) as linear RGB, through three's colour management. */
export function linearRGB(r: number, g: number, b: number): [number, number, number] {
  tmpColor.setRGB(r, g, b, SRGBColorSpace);
  return [tmpColor.r, tmpColor.g, tmpColor.b];
}

/** sRGB `#rrggbb[aa]` as quarks' linear RGBA. */
export function linearColor(hex: string): QVector4 {
  const [r, g, b, a] = parseHexColor(hex);
  const [lr, lg, lb] = linearRGB(r, g, b);
  return new QVector4(lr, lg, lb, a);
}

function gradientGen(g: ParticleGradient): Gradient {
  const colors = g.colors.length ? g.colors : [[0, "#ffffff"] as [number, string]];
  return new Gradient(
    colors.map(([t, c]) => {
      const l = linearColor(c);
      return [new QVector3(l.x, l.y, l.z), t] as [QVector3, number];
    }),
    (g.alphas.length ? g.alphas : [[0, 1] as [number, number]]).map(([t, a]) => [a, t] as [number, number]),
  );
}

/** A colour value as a quarks colour generator (start colours). */
export function colorGen(v: ParticleColor): ColorGenerator | FunctionColorGenerator {
  if (typeof v === "string") return new ConstantColor(linearColor(v));
  if ("random" in v) return new ColorRange(linearColor(v.random[0]), linearColor(v.random[1]));
  if ("gradient" in v) return gradientGen(v.gradient);
  return new RandomColorBetweenGradient(gradientGen(v.randomGradients[0]), gradientGen(v.randomGradients[1]));
}

/** A start colour times the component's tint, read as each particle is born (so a script can change it live). */
class Tinted implements ColorGenerator {
  readonly type = "value" as const;
  constructor(
    private readonly inner: ColorGenerator | FunctionColorGenerator,
    private readonly tint: { value: readonly number[] },
  ) {}
  startGen(memory: GeneratorMemory): void {
    this.inner.startGen(memory);
  }
  genColor(memory: GeneratorMemory, color: QVector4, t = 0): QVector4 {
    (this.inner as FunctionColorGenerator).genColor(memory, color, t);
    const k = this.tint.value;
    return color.set(color.x * k[0], color.y * k[1], color.z * k[2], color.w * k[3]);
  }
  toJSON(): never {
    throw new Error("Tinted isn't serialized.");
  }
  clone(): ColorGenerator {
    return new Tinted(this.inner.clone() as ColorGenerator, this.tint);
  }
}

/** A colour value as a function of life (over-life behaviours): constants and ranges become flat gradients. */
function colorOverLifeGen(v: ParticleColor): FunctionColorGenerator {
  if (typeof v === "string") return gradientGen(flatGradient(v));
  if ("random" in v) return new RandomColorBetweenGradient(gradientGen(flatGradient(v.random[0])), gradientGen(flatGradient(v.random[1])));
  if ("gradient" in v) return gradientGen(v.gradient);
  return new RandomColorBetweenGradient(gradientGen(v.randomGradients[0]), gradientGen(v.randomGradients[1]));
}

function flatGradient(hex: string): ParticleGradient {
  const [, , , a] = parseHexColor(hex);
  return { colors: [[0, hex.slice(0, 7)], [1, hex.slice(0, 7)]], alphas: [[0, a], [1, a]] };
}

/** A random value between two curves, picked once per particle (quarks has none built in). */
class RandomBetweenCurves implements FunctionValueGenerator {
  readonly type = "function" as const;
  private index = -1;
  constructor(
    private readonly a: FunctionValueGenerator,
    private readonly b: FunctionValueGenerator,
  ) {}
  startGen(memory: GeneratorMemory): void {
    this.index = memory.length;
    memory.push(Math.random());
  }
  genValue(memory: GeneratorMemory, t: number): number {
    if (this.index === -1) this.startGen(memory);
    const u = memory[this.index] as number;
    return this.a.genValue(memory, t) * (1 - u) + this.b.genValue(memory, t) * u;
  }
  toJSON(): never {
    throw new Error("RandomBetweenCurves isn't serialized.");
  }
  clone(): FunctionValueGenerator {
    return new RandomBetweenCurves(this.a.clone(), this.b.clone());
  }
}

/**
 * An emission count scaled by the quality tier and the component, limited by the room left under
 * the emitter's particle limit (quarks has no limit of its own): a rate is zero while there's no
 * room, a burst is clamped to it.
 */
class Capped implements ValueGenerator, FunctionValueGenerator {
  readonly type = "value" as unknown as "function" & "value";
  constructor(
    private readonly inner: NumberGen,
    private readonly scale: { value: number },
    private readonly room: () => number,
    private readonly burst: boolean,
  ) {}
  startGen(memory: GeneratorMemory): void {
    this.inner.startGen(memory);
  }
  genValue(memory: GeneratorMemory, t = 0): number {
    const room = this.room();
    if (room <= 0) return 0;
    const n = (this.inner as FunctionValueGenerator).genValue(memory, t) * this.scale.value;
    return this.burst ? Math.min(n, room) : n;
  }
  toJSON(): never {
    throw new Error("Capped isn't serialized.");
  }
  clone(): Capped {
    return new Capped(this.inner.clone() as NumberGen, this.scale, this.room, this.burst);
  }
}

/** A number the caller updates every frame (a graph binding, ADR 0060), times `scale`. */
class LiveValue implements ValueGenerator, FunctionValueGenerator {
  readonly type = "value" as unknown as "function" & "value";
  constructor(
    private readonly box: LiveBox,
    private readonly scale = 1,
  ) {}
  startGen(): void {}
  genValue(): number {
    const v = this.box.value;
    return (typeof v === "number" ? v : (v[0] ?? 0)) * this.scale;
  }
  toJSON(): never {
    throw new Error("LiveValue isn't serialized.");
  }
  clone(): LiveValue {
    return new LiveValue(this.box, this.scale);
  }
}

/** A colour (linear RGBA) the caller updates every frame, the same at every point of a particle's life. */
class LiveColor implements ColorGenerator, FunctionColorGenerator {
  readonly type = "value" as unknown as "function" & "value";
  constructor(private readonly box: LiveBox) {}
  startGen(): void {}
  genColor(_memory: GeneratorMemory, color: QVector4): QVector4 {
    const v = this.box.value;
    return Array.isArray(v) ? color.set(v[0] ?? 1, v[1] ?? 1, v[2] ?? 1, v[3] ?? 1) : color.set(v, v, v, 1);
  }
  toJSON(): never {
    throw new Error("LiveColor isn't serialized.");
  }
  clone(): LiveColor {
    return new LiveColor(this.box);
  }
}

/** Drops particles beyond the limit (sub-emitters spawn into a system without asking it). */
class CapParticles implements Behavior {
  readonly type = "CapParticles";
  constructor(
    private readonly system: { particleNum: number },
    private readonly max: () => number,
  ) {}
  initialize(): void {}
  update(): void {}
  frameUpdate(): void {
    const max = this.max();
    if (this.system.particleNum > max) this.system.particleNum = max;
  }
  toJSON(): never {
    throw new Error("CapParticles isn't serialized.");
  }
  clone(): Behavior {
    return new CapParticles(this.system, this.max);
  }
  reset(): void {}
}

// --- shapes and behaviours ------------------------------------------------------------------------

const MODES = { random: EmitterMode.Random, loop: EmitterMode.Loop, pingpong: EmitterMode.PingPong, burst: EmitterMode.Burst };

function shapeOf(s: ParticleShape): EmitterShape {
  const common = { arc: s.arc * DEG, thickness: s.thickness, mode: MODES[s.mode], spread: s.spread };
  switch (s.type) {
    case "point":
      return new PointEmitter();
    case "sphere":
      return new SphereEmitter({ ...common, radius: s.radius });
    case "hemisphere":
      return new HemisphereEmitter({ ...common, radius: s.radius });
    case "cone":
      return new ConeEmitter({ ...common, radius: s.radius, angle: s.angle * DEG });
    case "circle":
      return new CircleEmitter({ ...common, radius: s.radius });
    case "donut":
      return new DonutEmitter({ ...common, radius: s.radius, donutRadius: s.donutRadius });
    case "rectangle":
      return new RectangleEmitter({ width: s.width, height: s.height, thickness: s.thickness, mode: MODES[s.mode], spread: s.spread });
    case "grid":
      return new GridEmitter({ width: s.width, height: s.height, column: s.columns, row: s.rows });
  }
}

const v3 = (v: readonly number[]) => new QVector3(v[0], v[1], v[2]);

/** Builds a settings field's generator: live when the caller binds it (ADR 0060), else from its value. */
interface Gens {
  num(path: string, v: ParticleNumber, scale?: number): NumberGen;
  color(path: string, v: ParticleColor, overLife: boolean): ColorGenerator | FunctionColorGenerator;
}

/** `gens` with `prefix` before every path (a behaviour's fields). */
const scoped = (gens: Gens, prefix: string): Gens => ({
  num: (path, v, scale) => gens.num(prefix + path, v, scale),
  color: (path, v, overLife) => gens.color(prefix + path, v, overLife),
});

function behaviorOf(b: ParticleBehavior, gens: Gens): Behavior | null {
  const num = gens.num;
  const fn = (path: string, v: ParticleNumber) => gens.num(path, v) as FunctionValueGenerator;
  const overLife = (path: string, v: ParticleColor) => gens.color(path, v, true) as FunctionColorGenerator;
  switch (b.type) {
    case "colorOverLife":
      return new ColorOverLife(overLife("color", b.color));
    case "sizeOverLife":
      return new SizeOverLife(fn("size", b.size));
    case "rotationOverLife":
      return new RotationOverLife(num("speed", b.speed, DEG));
    case "speedOverLife":
      return new SpeedOverLife(fn("speed", b.speed));
    case "forceOverLife":
      return new ForceOverLife(num("x", b.x), num("y", b.y), num("z", b.z));
    case "gravityPoint":
      return new GravityForce(v3(b.center), b.strength);
    case "noise":
      return new Noise(num("frequency", b.frequency), num("power", b.power), num("positionAmount", b.positionAmount), num("rotationAmount", b.rotationAmount));
    case "turbulence":
      return new TurbulenceField(v3(b.scale), Math.max(1, Math.round(b.octaves)), v3(b.velocity), v3(b.timeScale));
    case "orbit":
      return new OrbitOverLife(num("speed", b.speed, DEG), v3(b.axis));
    case "frameOverLife":
      return new FrameOverLife(fn("frame", b.frame));
    case "limitSpeed":
      return new LimitSpeedOverLife(fn("speed", b.speed), b.dampen);
    case "colorBySpeed":
      return new ColorBySpeed(overLife("color", b.color), new IntervalValue(b.min, b.max));
    case "sizeBySpeed":
      return new SizeBySpeed(fn("size", b.size), new IntervalValue(b.min, b.max));
    case "widthOverLength":
      return new WidthOverLength(fn("width", b.width));
    case "collision":
      return new PlaneCollision(b.height, b.bounce, b.kill);
  }
}

/** Bounces particles off (or kills them at) a horizontal plane, in the simulation space. */
export class PlaneCollision implements Behavior {
  readonly type = "PlaneCollision";
  constructor(
    readonly height: number,
    readonly bounce: number,
    readonly kill: boolean,
  ) {}
  initialize(): void {}
  update(p: Particle): void {
    if (p.position.y >= this.height) return;
    if (this.kill) {
      p.age = p.life;
      return;
    }
    p.position.y = this.height;
    if (p.velocity.y < 0) p.velocity.y = -p.velocity.y * this.bounce;
  }
  frameUpdate(): void {}
  toJSON(): never {
    throw new Error("PlaneCollision isn't serialized.");
  }
  clone(): Behavior {
    return new PlaneCollision(this.height, this.bounce, this.kill);
  }
  reset(): void {}
}

export type { IParticleSystem };
