/**
 * Spawned decals (ADR 0395): bullet holes, splats, scorch marks and footprints that gameplay makes by the hundred and
 * never saves. `Decals.project` places a 3D decal and `Decals.stamp` a 2D one, without a node; each World keeps its own
 * pool, at most `render.maxDecals` of each kind (spawning past it fades out the oldest quickly).
 *
 * Pooled decals are cosmetic: not in scene files, not replicated (clients spawn their own from replicated events). A
 * World without a renderer (a dedicated server, a headless test World) keeps the bookkeeping, so `count`, `alive` and
 * lifetimes behave the same, and draws nothing. The `decals.Pool` system ages them in every World.
 */
import { Color, Mat4, Quaternion, Vector2, Vector3, type QuatLike, type Vec2Input, type Vec3Input } from "../../../engine/core/math";
import type { BuiltinSystem } from "../../../engine/core/systems";
import { World } from "../../../engine/core/World";
import type { GameObject } from "../../../engine/scene/GameObject";
import type { DecalBlend } from "../../../engine/render/decals";

/** A spawned decal. */
export interface DecalHandle {
  /** False once it has gone: faded out, removed, its parent destroyed, or pushed out by newer decals. */
  readonly alive: boolean;
  /** 0 to 1: how strongly it shows; set it to fade a decal by hand. */
  opacity: number;
  /** Fade it out over `fadeOut` seconds (default: its own `fadeOut`), then remove it; 0 removes it now. */
  remove(fadeOut?: number): void;
}

/** A 3D decal to place (`Decals.project`). */
export interface DecalProjectOptions {
  /** Where the box's centre is, in world space (or in `parent`'s space when it has one). */
  readonly position: Vec3Input;
  /** How it's turned: it projects along its rotated +Z. Default: none (projecting along world +Z). */
  readonly rotation?: Quaternion | QuatLike;
  /** The box: width, height and projection depth. Default 1, 1, 1. */
  readonly size?: Vec3Input;
  /** A material asset or shader graph; default the built-in decal material showing `texture`. */
  readonly material?: string;
  readonly texture?: string;
  readonly color?: Color;
  readonly opacity?: number;
  readonly blend?: DecalBlend;
  /** Among overlapping decals, higher draws on top. Default 0. */
  readonly order?: number;
  readonly uvScale?: Vec2Input;
  readonly uvOffset?: Vec2Input;
  /** Radians: full strength below x, gone past y. Default π/3, π/2. */
  readonly angleFade?: Vec2Input;
  /** Seconds of World time it lives before fading out. Default: until removed. */
  readonly lifetime?: number;
  /** Seconds its fade-out takes. Default 0.5. */
  readonly fadeOut?: number;
  /** A node it follows (a bullet hole in a swinging door): `position` and `rotation` are then in its space. Destroying the node removes the decal. */
  readonly parent?: GameObject | null;
}

/** A 2D decal to stamp (`Decals.stamp`). */
export interface DecalStampOptions {
  /** Where its pivot is, in world space (z 0 for a Vector2). */
  readonly position: Vec2Input | Vec3Input;
  /** Radians about Z. Default 0. */
  readonly rotation?: number;
  /** Its size; default the sprite's pixel size over pixels per unit. */
  readonly size?: Vec2Input;
  /** The image (or a slice of it). */
  readonly sprite: string;
  readonly color?: Color;
  readonly opacity?: number;
  readonly sortingLayer?: string;
  readonly orderInLayer?: number;
  /** A node whose sprite clips the stamp (drawn only where it is opaque). Default: none. */
  readonly clip?: GameObject | null;
  readonly lifetime?: number;
  readonly fadeOut?: number;
}

/** @internal A pooled decal: its options resolved, its age and its fade. */
export class PooledDecal implements DecalHandle {
  /** The box (3D) or quad pivot frame (2D) matrix, column-major: in the parent's space when it has one, else world. */
  readonly matrix = new Float64Array(16);
  age = 0;
  opacity: number;
  /** While fading out: seconds left and the fade's length. */
  private fading: { left: number; total: number } | null = null;
  private dead = false;

  constructor(
    readonly kind: "3d" | "2d",
    readonly look: {
      readonly material: string;
      readonly texture: string;
      readonly blend: DecalBlend;
      readonly order: number;
      readonly sprite: string;
      readonly sortingLayer: string;
      readonly orderInLayer: number;
    },
    readonly color: Color,
    opacity: number,
    readonly uv: readonly [number, number, number, number],
    readonly angles: readonly [number, number],
    /** 2D: an explicit size, or null for the sprite's. */
    readonly size2D: readonly [number, number] | null,
    readonly parent: GameObject | null,
    readonly clip: GameObject | null,
    readonly lifetime: number,
    readonly fadeOut: number,
  ) {
    this.opacity = opacity;
  }

  get alive(): boolean {
    return !this.dead;
  }

  remove(fadeOut = this.fadeOut): void {
    if (this.dead) return;
    if (!(fadeOut > 0)) {
      this.dead = true;
      return;
    }
    if (!this.fading || this.fading.left > fadeOut) this.fading = { left: fadeOut, total: fadeOut };
  }

  /** @internal How much of it shows now from its fade-out (0..1). */
  fade(): number {
    return this.fading ? Math.max(0, this.fading.left / this.fading.total) : 1;
  }

  /** @internal Age it by `dt`; false once it's gone. */
  step(dt: number): boolean {
    if (this.dead) return false;
    if (this.parent && !this.parent.isValid) {
      this.dead = true;
      return false;
    }
    this.age += dt;
    let fadeDt = dt;
    if (!this.fading && this.age >= this.lifetime) {
      this.remove();
      fadeDt = this.age - this.lifetime; // the fade starts when the lifetime ends, not at the frame's start
    }
    if (this.fading) {
      this.fading.left -= fadeDt;
      if (this.fading.left <= 0) this.dead = true;
    }
    return !this.dead;
  }
}

/** @internal A World's pool: its live decals of each kind, oldest first. */
export class DecalPool {
  readonly decals3D: PooledDecal[] = [];
  readonly decals2D: PooledDecal[] = [];
  /** Goes up whenever the set of decals changes, so a renderer can skip unchanged frames. */
  version = 0;

  constructor(private readonly world: World) {}

  add(d: PooledDecal): void {
    const list = d.kind === "3d" ? this.decals3D : this.decals2D;
    list.push(d);
    // Past the cap: the oldest still showing fade out quickly (the list only shrinks as they finish).
    const cap = Math.max(1, this.world.settings.render.maxDecals);
    let over = list.filter((x) => x.alive && x.fade() === 1).length - cap;
    for (let i = 0; i < list.length && over > 0; i++) {
      if (list[i]!.alive && list[i]!.fade() === 1) {
        list[i]!.remove(0.25);
        over--;
      }
    }
    this.version++;
  }

  step(dt: number): void {
    for (const list of [this.decals3D, this.decals2D]) {
      let w = 0;
      for (let i = 0; i < list.length; i++) {
        const d = list[i]!;
        if (d.step(dt)) list[w++] = d;
      }
      if (w !== list.length) {
        list.length = w;
        this.version++;
      }
    }
  }

  clear(): void {
    for (const d of [...this.decals3D, ...this.decals2D]) d.remove(0);
    this.decals3D.length = 0;
    this.decals2D.length = 0;
    this.version++;
  }

  get count(): number {
    return this.decals3D.length + this.decals2D.length;
  }
}

const pools = new WeakMap<World, DecalPool>();

/** @internal `world`'s pool, made on first use (or null without making one when `make` is false). */
export function decalPoolOf(world: World, make = true): DecalPool | null {
  let pool = pools.get(world);
  if (!pool && make) pools.set(world, (pool = new DecalPool(world)));
  return pool ?? null;
}

const toVec2 = (v: Vec2Input | undefined, fallback: [number, number]): [number, number] => {
  if (v === undefined) return fallback;
  const p = Vector2.from(v);
  return [p.x, p.y];
};

/** Spawned decals in the current World (see the file comment). */
export class Decals {
  private constructor() {}

  /** Place a 3D decal: a box projecting along its +Z onto the opaque surfaces inside it. */
  static project(options: DecalProjectOptions): DecalHandle {
    const world = World.require();
    const p = Vector3.from(options.position);
    const q = options.rotation ? Quaternion.from(options.rotation) : new Quaternion();
    const s = Vector3.from(options.size ?? [1, 1, 1]);
    const [sx, sy] = toVec2(options.uvScale, [1, 1]);
    const [ox, oy] = toVec2(options.uvOffset, [0, 0]);
    const [a0, a1] = toVec2(options.angleFade, [Math.PI / 3, Math.PI / 2]);
    const d = new PooledDecal(
      "3d",
      { material: options.material ?? "", texture: options.texture ?? "", blend: options.blend ?? "alpha", order: options.order ?? 0, sprite: "", sortingLayer: "", orderInLayer: 0 },
      (options.color ?? Color.white).clone(),
      clamp01(options.opacity ?? 1),
      [sx, sy, ox, oy],
      [Math.cos(a0), Math.cos(a1)],
      null,
      options.parent ?? null,
      null,
      options.lifetime ?? Infinity,
      options.fadeOut ?? 0.5,
    );
    Mat4.compose(d.matrix, 0, [p.x, p.y, p.z], 0, [q.x, q.y, q.z, q.w], 0, [s.x, s.y, s.z], 0);
    decalPoolOf(world)!.add(d);
    return d;
  }

  /** Stamp a 2D decal: a sprite on a sorting layer, optionally clipped to another node's sprite. */
  static stamp(options: DecalStampOptions): DecalHandle {
    const world = World.require();
    const pos = options.position as { z?: number } & Vec2Input;
    const v = Vector2.from(pos);
    const z = Array.isArray(pos) ? (pos[2] ?? 0) : ((pos as { z?: number }).z ?? 0);
    const angle = options.rotation ?? 0;
    const size = options.size !== undefined ? toVec2(options.size, [1, 1]) : null;
    const d = new PooledDecal(
      "2d",
      { material: "", texture: "", blend: "alpha", order: 0, sprite: options.sprite, sortingLayer: options.sortingLayer ?? "Default", orderInLayer: options.orderInLayer ?? 0 },
      (options.color ?? Color.white).clone(),
      clamp01(options.opacity ?? 1),
      [1, 1, 0, 0],
      [1, 0],
      size,
      null,
      options.clip ?? null,
      options.lifetime ?? Infinity,
      options.fadeOut ?? 0.5,
    );
    const half = angle / 2;
    Mat4.compose(d.matrix, 0, [v.x, v.y, z], 0, [0, 0, Math.sin(half), Math.cos(half)], 0, [1, 1, 1], 0);
    decalPoolOf(world)!.add(d);
    return d;
  }

  /** Remove every spawned decal in the current World at once. */
  static clear(): void {
    decalPoolOf(World.require(), false)?.clear();
  }

  /** How many spawned decals the current World has (fading ones included). */
  static get count(): number {
    return decalPoolOf(World.require(), false)?.count ?? 0;
  }
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** The `decals.Pool` engine system: ages every World's spawned decals in `lateUpdate`. */
export const DECAL_POOL_SYSTEM: BuiltinSystem = {
  name: "decals.Pool",
  phase: "lateUpdate",
  after: ["engine.LateUpdateScripts"],
  run(world: World, dt: number): void {
    decalPoolOf(world, false)?.step(dt);
  },
};
