// Internal (ADR 0057, 0075 stage 5): particle draws made of meshes, for what Babylon's CPU
// `ParticleSystem` can't draw: mesh particles (thin instances of a model), trails (ribbons built on
// the CPU), and any emitter with a material asset (Babylon's particle system only takes a texture).
// Shared, like `particleDraw.ts`, by the World's player and the editor's effect preview. Each frame
// writes into Float32Arrays kept between frames (grown, never shrunk), so nothing is allocated per
// particle.
//
// Draw order (`renderOrder`): Babylon draws a rendering group's particle systems before its
// transparent meshes, so these meshes, which sort with the transparent meshes, always draw over the
// emitters drawn as Babylon particle systems, whatever either's `renderOrder` (three.js sorts them all
// together). Among transparent meshes Babylon sorts by `alphaIndex` (lowest first), then back to front.
// Meshes default to `Number.MAX_VALUE`, so `particleAlphaIndex` leaves renderOrder 0 there (sorted by
// distance with the scene's other transparent meshes, as three.js does when every renderOrder is 0),
// puts negative orders before them in order, and positive orders after them all at +Infinity: two
// different positive orders then sort by distance, not by order.
import "@babylonjs/core/Meshes/thinInstanceMesh.js"; // thin instances (also in register.ts; tests don't load that)
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { Material } from "@babylonjs/core/Materials/material.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { ModelMesh } from "../../scene/models";
import type { ParticleBlending } from "../../scene/particles";
import { trailPoint, type SimEmitter } from "../particles/simulation";
import { meshOf } from "./materials";

/** One emitter's drawing on the Babylon backend. */
export interface Draw {
  readonly name: string;
  readonly emitter: SimEmitter;
  /** `system`: a Babylon particle system; `instances`: thin instances of a mesh; `quads`/`trail`: geometry built on the CPU. */
  readonly kind: "system" | "instances" | "quads" | "trail";
  /** Particles it holds before it has to grow. */
  capacity: number;
  /**
   * The Babylon particle system of a `system` draw; for the others, the draw itself. Either way
   * `ps.dispose(false)` frees the draw, leaving its texture (callers written before the mesh draws
   * dispose them so; prefer `dispose()`).
   */
  readonly ps: { dispose(disposeTexture?: boolean): void };
  /** Make room for `need` particles. */
  ensure(need: number): void;
  /** Show the simulation's particles as they are now. */
  update(): void;
  dispose(): void;
}

/** The `alphaIndex` a mesh drawing particles gets for an emitter's `renderOrder` (see the file comment). */
export function particleAlphaIndex(renderOrder: number): number {
  if (renderOrder === 0 || !Number.isFinite(renderOrder)) return Number.MAX_VALUE;
  return renderOrder > 0 ? Number.POSITIVE_INFINITY : renderOrder;
}

/**
 * The unlit material mesh-based particles draw with when the emitter has no material asset: its
 * texture times the particle colour (vertex or instance colour), transparent, without depth writes,
 * blended like three.js's MeshBasicMaterial (additive; normal; premultiplied, which multiplies the
 * colour by alpha in the shader). A StandardMaterial with lighting off and a white emissive colour
 * gives texture × colour unclamped, and treats colour spaces exactly as Babylon's particle shader
 * does (the same image-processing step), so these particles look like the billboards: linear colour
 * into the World's linear target, tone mapped once by the finish pass. The texture's alpha comes in
 * as an opacity texture, so the shared texture's `hasAlpha` isn't touched.
 */
export function unlitParticleMaterial(scene: Scene, name: string, texture: BaseTexture, blending: ParticleBlending, twoSided: boolean): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.disableLighting = true;
  m.diffuseColor = new Color3(0, 0, 0);
  m.specularColor = new Color3(0, 0, 0);
  m.emissiveColor = new Color3(1, 1, 1);
  m.diffuseTexture = texture;
  m.opacityTexture = texture;
  m.transparencyMode = Material.MATERIAL_ALPHABLEND;
  m.alphaMode = blending === "additive" ? Constants.ALPHA_ADD : blending === "premultiplied" ? Constants.ALPHA_PREMULTIPLIED : Constants.ALPHA_COMBINE;
  m.disableDepthWrite = true;
  m.backFaceCulling = !twoSided;
  return m;
}

function prepare(mesh: Mesh): void {
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true; // its bounds aren't kept up to date
  mesh.doNotSyncBoundingInfo = true;
}

// --- mesh particles ---------------------------------------------------------------------------------

/**
 * Mesh mode: each particle is a thin instance of the model's first mesh (as the three.js backend uses
 * its first geometry), at the particle's world position, scaled by its size, turned by its rotation
 * about world +Y, and tinted by its colour (the instance colour, which Babylon's standard and PBR
 * materials multiply in). three.quarks draws mesh particles unturned; the rotation is used here so
 * Start Rotation and Rotation over Life mean something. Flipbook tiles aren't applied to meshes.
 */
export class InstanceDraw implements Draw {
  readonly kind = "instances";
  readonly ps = this;
  capacity = 0;
  readonly mesh: Mesh;
  /** Per instance: a 4×4 matrix (Babylon's layout, translation in 12-14) and linear RGBA. */
  matrices = new Float32Array(0);
  colors = new Float32Array(0);
  private readonly own: StandardMaterial | null;

  constructor(
    scene: Scene,
    readonly name: string,
    readonly emitter: SimEmitter,
    capacity: number,
    source: ModelMesh,
    material: Material | null,
    texture: BaseTexture,
  ) {
    const r = emitter.renderer;
    this.mesh = meshOf(scene, name, source);
    prepare(this.mesh);
    this.mesh.freezeWorldMatrix();
    this.mesh.alphaIndex = particleAlphaIndex(r.renderOrder);
    this.own = material ? null : unlitParticleMaterial(scene, `${name}:material`, texture, r.blending, false);
    this.mesh.material = material ?? this.own;
    this.allocate(Math.max(1, capacity));
  }

  private allocate(n: number): void {
    this.capacity = n;
    this.matrices = new Float32Array(n * 16);
    this.colors = new Float32Array(n * 4);
    this.mesh.thinInstanceSetBuffer("matrix", this.matrices, 16, false);
    this.mesh.thinInstanceSetBuffer("color", this.colors, 4, false);
    this.mesh.thinInstanceCount = 0;
    this.mesh.isVisible = false;
  }

  ensure(need: number): void {
    if (need > this.capacity) this.allocate(Math.ceil(need * 1.5));
  }

  update(): void {
    const e = this.emitter;
    const n = Math.min(e.count, this.capacity);
    const m = this.matrices;
    const c = this.colors;
    for (let i = 0; i < n; i++) {
      const p = e.pool[i];
      const s = p.size;
      const cos = Math.cos(p.rotation) * s;
      const sin = Math.sin(p.rotation) * s;
      const o = i * 16;
      // Babylon's RotationY scaled, rows as axes.
      m[o] = cos;
      m[o + 1] = 0;
      m[o + 2] = -sin;
      m[o + 3] = 0;
      m[o + 4] = 0;
      m[o + 5] = s;
      m[o + 6] = 0;
      m[o + 7] = 0;
      m[o + 8] = sin;
      m[o + 9] = 0;
      m[o + 10] = cos;
      m[o + 11] = 0;
      m[o + 12] = p.wx;
      m[o + 13] = p.wy;
      m[o + 14] = p.wz;
      m[o + 15] = 1;
      const k = i * 4;
      c[k] = p.r;
      c[k + 1] = p.g;
      c[k + 2] = p.b;
      c[k + 3] = p.a;
    }
    // With no instances Babylon would draw the mesh itself, so hide it instead.
    this.mesh.isVisible = n > 0;
    this.mesh.thinInstanceCount = n;
    if (n > 0) {
      this.mesh.thinInstanceBufferUpdated("matrix");
      this.mesh.thinInstanceBufferUpdated("color");
    }
  }

  dispose(): void {
    this.mesh.dispose(false, false); // a material asset is shared: not disposed
    this.own?.dispose(false, false); // the texture is shared too
  }
}

// --- quads and trails built on the CPU ----------------------------------------------------------------

/** Below this blend weight the second tile of a blended flipbook isn't drawn. */
export const BLEND_EPSILON = 1 / 512;
/** Trail points kept per particle at most (as `simulation.ts` caps them). */
const MAX_TRAIL = 256;

const point = { x: 0, y: 0, z: 0 };

/**
 * Quads written into one updatable mesh each frame (4 vertices each: position, linear RGBA colour,
 * UV; a fixed index pattern), so any material can draw them.
 *
 * - `quads`: a camera-facing quad per particle, posed like Babylon's billboards (billboard, stretched
 *   along the velocity, horizontal, vertical about +Y), for emitters with a material asset.
 *   `blendTiles` draws a second quad on the next flipbook tile (see `particleDraw.ts`).
 * - `trail`: a ribbon per particle through its trail history (`SimParticle.trail`, newest first), one
 *   quad per segment, `size × widthAt(u)` wide (u 0 at the head, 1 at the tail), coloured with the
 *   particle's colour; U runs along the ribbon (1 at the head, as three.quarks), V across it, within
 *   the particle's flipbook tile. three.quarks records each point's colour and size when it is laid
 *   down; the simulation keeps positions only, so the whole ribbon takes the particle's current
 *   colour and size.
 *
 * Both face one camera, worked out on the CPU: the scene's active camera (the World's first view;
 * the preview's camera). Other views (split screen) see the same geometry, turned towards that one.
 */
export class QuadDraw implements Draw {
  readonly ps = this;
  capacity: number;
  readonly mesh: Mesh;
  /** Quads drawn by the last update. */
  quads = 0;
  positions = new Float32Array(0);
  colors = new Float32Array(0);
  uvs = new Float32Array(0);
  /** Per-vertex normals, only with a material asset: a lit or graph material reads the normal (a Fresnel node, lighting), and its shader doesn't compile without one. */
  normals: Float32Array | null = null;
  private quadCap = 0;
  /** The normal `vertex` writes, set per quad or trail point. */
  private nx = 0;
  private ny = 0;
  private nz = 1;
  /** The camera's position, for normals that face it. */
  private ex = 0;
  private ey = 0;
  private ez = 0;
  /**
   * The drawn part's bounds. Drawing fewer quads than the buffers hold makes the submesh partial, and a
   * partial submesh has no bounds of its own, which Babylon's transparent sort reads (its distance).
   */
  private readonly bounds = new BoundingInfo(Vector3.Zero(), Vector3.Zero());
  private readonly lo = new Vector3();
  private readonly hi = new Vector3();
  private readonly own: StandardMaterial | null;
  private readonly pts = new Float32Array(MAX_TRAIL * 3);
  private readonly sides = new Float32Array(MAX_TRAIL * 3);

  constructor(
    scene: Scene,
    readonly name: string,
    readonly emitter: SimEmitter,
    capacity: number,
    readonly kind: "quads" | "trail",
    material: Material | null,
    texture: BaseTexture,
    private readonly camera: () => Camera | null,
  ) {
    const r = emitter.renderer;
    this.capacity = Math.max(1, capacity);
    this.mesh = new Mesh(name, scene);
    prepare(this.mesh);
    this.mesh.freezeWorldMatrix(); // vertices are in world space
    this.mesh.hasVertexAlpha = true;
    this.mesh.alphaIndex = particleAlphaIndex(r.renderOrder);
    this.own = material ? null : unlitParticleMaterial(scene, `${name}:material`, texture, r.blending, true);
    this.mesh.material = material ?? this.own;
    if (material) this.normals = new Float32Array(0);
    this.grow(kind === "trail" ? this.capacity * 8 : this.capacity * (r.blendTiles ? 2 : 1));
  }

  private grow(quads: number): void {
    this.quadCap = Math.max(1, quads);
    const v = this.quadCap * 4;
    this.positions = new Float32Array(v * 3);
    this.colors = new Float32Array(v * 4);
    this.uvs = new Float32Array(v * 2);
    if (this.normals) this.normals = new Float32Array(v * 3);
    const indices = new Uint32Array(this.quadCap * 6);
    for (let q = 0; q < this.quadCap; q++) {
      const i = q * 6;
      const b = q * 4;
      indices[i] = b;
      indices[i + 1] = b + 1;
      indices[i + 2] = b + 2;
      indices[i + 3] = b;
      indices[i + 4] = b + 2;
      indices[i + 5] = b + 3;
    }
    this.mesh.setVerticesData(VertexBuffer.PositionKind, this.positions, true, 3);
    this.mesh.setVerticesData(VertexBuffer.ColorKind, this.colors, true, 4);
    this.mesh.setVerticesData(VertexBuffer.UVKind, this.uvs, true, 2);
    if (this.normals) this.mesh.setVerticesData(VertexBuffer.NormalKind, this.normals, true, 3);
    this.mesh.setIndices(indices, v);
    this.mesh.isVisible = false;
  }

  ensure(need: number): void {
    if (need > this.capacity) this.capacity = Math.ceil(need * 1.5); // quads grow in update, as needed
  }

  update(): void {
    const cam = this.camera();
    const e = this.emitter;
    const n = Math.min(e.count, this.capacity);
    if (!cam || n === 0) {
      this.show(0);
      return;
    }
    // Quads needed this frame.
    let need = 0;
    if (this.kind === "trail") {
      for (let i = 0; i < n; i++) need += Math.max(0, e.pool[i].trailCount - 1);
    } else need = n * (e.renderer.blendTiles ? 2 : 1);
    if (need > this.quadCap) this.grow(Math.ceil(need * 1.5));
    const w = cam.getWorldMatrix().m; // rows: right, up, back; then the position
    this.ex = w[12];
    this.ey = w[13];
    this.ez = w[14];
    this.show(this.kind === "trail" ? this.writeTrails(n, w) : this.writeQuads(n, w));
  }

  /** Upload the first `quads` quads and draw only those. */
  private show(quads: number): void {
    this.quads = quads;
    this.mesh.isVisible = quads > 0;
    if (!quads) return;
    const v = quads * 4;
    this.mesh.getVertexBuffer(VertexBuffer.PositionKind)?.getWrapperBuffer().updateDirectly(this.positions, 0, v);
    this.mesh.getVertexBuffer(VertexBuffer.ColorKind)?.getWrapperBuffer().updateDirectly(this.colors, 0, v);
    this.mesh.getVertexBuffer(VertexBuffer.UVKind)?.getWrapperBuffer().updateDirectly(this.uvs, 0, v);
    if (this.normals) this.mesh.getVertexBuffer(VertexBuffer.NormalKind)?.getWrapperBuffer().updateDirectly(this.normals, 0, v);
    const sub = this.mesh.subMeshes?.[0];
    if (!sub) return;
    sub.indexCount = quads * 6;
    const p = this.positions;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < v * 3; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    this.bounds.reConstruct(this.lo.set(x0, y0, z0), this.hi.set(x1, y1, z1), Matrix.IdentityReadOnly); // vertices are in world space
    sub.setBoundingInfo(this.bounds);
  }

  /** Set the normal the next vertices take: (x, y, z) normalized, turned to face the camera from (px, py, pz). */
  private facing(x: number, y: number, z: number, px: number, py: number, pz: number): void {
    const l = Math.hypot(x, y, z);
    if (l < 1e-12) {
      x = this.ex - px;
      y = this.ey - py;
      z = this.ez - pz;
    }
    const d = x * (this.ex - px) + y * (this.ey - py) + z * (this.ez - pz);
    const k = (d < 0 ? -1 : 1) / (Math.hypot(x, y, z) || 1);
    this.nx = x * k;
    this.ny = y * k;
    this.nz = z * k;
  }

  /** Write one vertex: position, colour, UV (and the normal set by `facing`, with a material asset). */
  private vertex(i: number, x: number, y: number, z: number, r: number, g: number, b: number, a: number, u: number, v: number): void {
    const p = this.positions;
    const c = this.colors;
    const t = this.uvs;
    p[i * 3] = x;
    p[i * 3 + 1] = y;
    p[i * 3 + 2] = z;
    c[i * 4] = r;
    c[i * 4 + 1] = g;
    c[i * 4 + 2] = b;
    c[i * 4 + 3] = a;
    t[i * 2] = u;
    t[i * 2 + 1] = v;
    const nrm = this.normals;
    if (nrm) {
      nrm[i * 3] = this.nx;
      nrm[i * 3 + 1] = this.ny;
      nrm[i * 3 + 2] = this.nz;
    }
  }

  /**
   * One quad centred on (px, py, pz) spanning ±(ax, ay, az) and ±(bx, by, bz), on flipbook `tile`
   * (tile 0 is the image's top left, as three.js; the texture is loaded with invertY, so V 1 is the
   * image's top).
   */
  private quad(q: number, px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, tile: number, r: number, g: number, b: number, a: number): void {
    const tiles = this.emitter.renderer.tiles;
    const cols = tiles[0];
    const rows = tiles[1];
    const col = tile % cols;
    const row = Math.floor(tile / cols);
    const u0 = col / cols;
    const u1 = (col + 1) / cols;
    const v0 = 1 - (row + 1) / rows;
    const v1 = 1 - row / rows;
    const i = q * 4;
    if (this.normals) this.facing(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx, px, py, pz);
    // Corners as Babylon's particle offsets (0,0) (1,0) (1,1) (0,1).
    this.vertex(i, px - ax - bx, py - ay - by, pz - az - bz, r, g, b, a, u0, v0);
    this.vertex(i + 1, px + ax - bx, py + ay - by, pz + az - bz, r, g, b, a, u1, v0);
    this.vertex(i + 2, px + ax + bx, py + ay + by, pz + az + bz, r, g, b, a, u1, v1);
    this.vertex(i + 3, px - ax + bx, py - ay + by, pz - az + bz, r, g, b, a, u0, v1);
  }

  private writeQuads(n: number, w: ArrayLike<number>): number {
    const e = this.emitter;
    const r = e.renderer;
    const tiles = Math.max(1, r.tiles[0] * r.tiles[1]);
    const blend = r.blendTiles && tiles > 1;
    const rx = w[0], ry = w[1], rz = w[2];
    const ux = w[4], uy = w[5], uz = w[6];
    const ex = w[12], ey = w[13], ez = w[14];
    let q = 0;
    for (let i = 0; i < n; i++) {
      const p = e.pool[i];
      const h = p.size / 2;
      // The quad's own right (R) and up (U) axes, before its roll.
      let Rx = rx, Ry = ry, Rz = rz, Ux = ux, Uy = uy, Uz = uz;
      let ax: number, ay: number, az: number, bx: number, by: number, bz: number;
      if (r.mode === "stretched") {
        // Width across the velocity as seen from the camera, length along it (Babylon's stretched billboard).
        let dx = p.wvx, dy = p.wvy, dz = p.wvz;
        const dl = Math.hypot(dx, dy, dz);
        if (dl < 1e-6) {
          dx = 0;
          dy = 1;
          dz = 0;
        } else {
          dx /= dl;
          dy /= dl;
          dz /= dl;
        }
        const tx = p.wx - ex, ty = p.wy - ey, tz = p.wz - ez;
        let wx = dy * tz - dz * ty, wy = dz * tx - dx * tz, wz = dx * ty - dy * tx;
        const wl = Math.hypot(wx, wy, wz) || 1;
        wx /= wl;
        wy /= wl;
        wz /= wl;
        let lx = ty * wz - tz * wy, ly = tz * wx - tx * wz, lz = tx * wy - ty * wx;
        const ll = Math.hypot(lx, ly, lz) || 1;
        const half = Math.max(p.length, 1e-4) / 2 / ll;
        lx *= half;
        ly *= half;
        lz *= half;
        ax = wx * h;
        ay = wy * h;
        az = wz * h;
        bx = lx;
        by = ly;
        bz = lz;
      } else {
        if (r.mode === "horizontal") {
          // Flat on the ground, its top towards -Z.
          Rx = 1;
          Ry = 0;
          Rz = 0;
          Ux = 0;
          Uy = 0;
          Uz = -1;
        } else if (r.mode === "vertical") {
          // Upright, turned about +Y towards the camera (right kept on the camera's right).
          const dx = p.wx - ex, dz = p.wz - ez;
          const dl = Math.hypot(dx, dz);
          if (dl > 1e-6) {
            const flip = (dz * rx - dx * rz) / dl < 0 ? -1 : 1;
            Rx = (flip * dz) / dl;
            Ry = 0;
            Rz = (-flip * dx) / dl;
          }
          Ux = 0;
          Uy = 1;
          Uz = 0;
        }
        const c = Math.cos(p.rotation) * h;
        const s = Math.sin(p.rotation) * h;
        ax = Rx * c + Ux * s;
        ay = Ry * c + Uy * s;
        az = Rz * c + Uz * s;
        bx = Ux * c - Rx * s;
        by = Uy * c - Ry * s;
        bz = Uz * c - Rz * s;
      }
      const f = blend ? p.tileBlend : 0;
      this.quad(q++, p.wx, p.wy, p.wz, ax, ay, az, bx, by, bz, p.tile, p.r, p.g, p.b, p.a * (1 - f));
      if (f > BLEND_EPSILON) this.quad(q++, p.wx, p.wy, p.wz, ax, ay, az, bx, by, bz, (p.tile + 1) % tiles, p.r, p.g, p.b, p.a * f);
    }
    return q;
  }

  private writeTrails(n: number, w: ArrayLike<number>): number {
    const e = this.emitter;
    const cols = e.renderer.tiles[0];
    const rows = e.renderer.tiles[1];
    const ex = w[12], ey = w[13], ez = w[14];
    const pts = this.pts;
    const sides = this.sides;
    let q = 0;
    for (let i = 0; i < n; i++) {
      const p = e.pool[i];
      const count = Math.min(p.trailCount, MAX_TRAIL);
      if (count < 2) continue;
      for (let k = 0; k < count; k++) {
        trailPoint(p, k, point);
        pts[k * 3] = point.x;
        pts[k * 3 + 1] = point.y;
        pts[k * 3 + 2] = point.z;
      }
      // Each point's half-width vector: across the ribbon's direction there, as seen from the camera.
      let sx = w[0], sy = w[1], sz = w[2]; // the last good side (the camera's right to start)
      for (let k = 0; k < count; k++) {
        const a = Math.max(0, k - 1) * 3;
        const b = Math.min(count - 1, k + 1) * 3;
        const tx = pts[a] - pts[b], ty = pts[a + 1] - pts[b + 1], tz = pts[a + 2] - pts[b + 2];
        const cx = pts[k * 3] - ex, cy = pts[k * 3 + 1] - ey, cz = pts[k * 3 + 2] - ez;
        const nx = ty * cz - tz * cy, ny = tz * cx - tx * cz, nz = tx * cy - ty * cx;
        const len = Math.hypot(nx, ny, nz);
        if (len > 1e-9) {
          sx = nx / len;
          sy = ny / len;
          sz = nz / len;
        }
        const half = (p.size * e.widthAt(k / (count - 1))) / 2;
        sides[k * 3] = sx * half;
        sides[k * 3 + 1] = sy * half;
        sides[k * 3 + 2] = sz * half;
      }
      const col = p.tile % cols;
      const row = Math.floor(p.tile / cols);
      const vLo = 1 - (row + 1) / rows;
      const vHi = 1 - row / rows;
      for (let k = 0; k + 1 < count; k++) {
        const j = q++ * 4;
        const k3 = k * 3;
        const n3 = k3 + 3;
        const ua = (col + 1 - k / (count - 1)) / cols;
        const ub = (col + 1 - (k + 1) / (count - 1)) / cols;
        if (this.normals) this.facing(0, 0, 0, pts[k3], pts[k3 + 1], pts[k3 + 2]); // a ribbon faces the camera
        this.vertex(j, pts[k3] - sides[k3], pts[k3 + 1] - sides[k3 + 1], pts[k3 + 2] - sides[k3 + 2], p.r, p.g, p.b, p.a, ua, vLo);
        this.vertex(j + 1, pts[k3] + sides[k3], pts[k3 + 1] + sides[k3 + 1], pts[k3 + 2] + sides[k3 + 2], p.r, p.g, p.b, p.a, ua, vHi);
        this.vertex(j + 2, pts[n3] + sides[n3], pts[n3 + 1] + sides[n3 + 1], pts[n3 + 2] + sides[n3 + 2], p.r, p.g, p.b, p.a, ub, vHi);
        this.vertex(j + 3, pts[n3] - sides[n3], pts[n3 + 1] - sides[n3 + 1], pts[n3 + 2] - sides[n3 + 2], p.r, p.g, p.b, p.a, ub, vLo);
      }
    }
    return q;
  }

  dispose(): void {
    this.mesh.dispose(false, false);
    this.own?.dispose(false, false);
  }
}
