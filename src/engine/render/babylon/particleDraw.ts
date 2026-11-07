// Internal (ADR 0057, 0075): how simulated particles are drawn on the Babylon backend. Shared by the
// World's player (`particles.ts`) and the editor's previews (`previews/EffectPreview.ts`,
// `previews/ThumbnailRenderer.ts`). `makeDraw` picks, per emitter:
//
// - a Babylon CPU `ParticleSystem`, with its own emission and update turned off, showing the particle
//   list `EffectSimulation` produced (billboards, stretched, horizontal, vertical, flipbook sheets,
//   blending) — the cheapest, used whenever it can draw the emitter;
// - mesh particles (`mesh` mode), trails (`trail` mode), and any emitter with a material asset, which
//   Babylon's particle system can't draw, as meshes (`particleMeshes.ts`).
//
// `renderOrder`: Babylon draws a rendering group's particle systems in the order of
// `scene.particleSystems`, so `sortParticleSystems` keeps that list stably sorted by the emitters'
// renderOrder (systems that aren't ours count as 0). They all draw before the group's transparent
// meshes, mesh-based particles included, so a negative renderOrder can't put a billboard emitter under
// a transparent mesh, nor a positive one over it, as it can on three.js (see `particleMeshes.ts` for
// how the mesh draws sort).
import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Particle } from "@babylonjs/core/Particles/particle.js";
import { ParticleSystem as BabylonParticleSystem } from "@babylonjs/core/Particles/particleSystem.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { meshesIfLoaded, type ModelMesh } from "../../scene/models";
import type { ParticleRenderer as RendererSettings } from "../../scene/particles";
import type { SimEmitter, SimParticle } from "../particles/simulation";
import { BLEND_EPSILON, InstanceDraw, QuadDraw, type Draw } from "./particleMeshes";
import type { DepthSource } from "./softParticles";

export type { Draw } from "./particleMeshes";
export { particleAlphaIndex } from "./particleMeshes";

/** The default dot texture's size in pixels. */
export const DOT_SIZE = 64;

/** The mesh a mesh-mode emitter draws when its own can't be had. */
const FALLBACK_MESH = "builtin:cube";

// Babylon's billboard modes (`ParticleSystem.BILLBOARDMODE_*`).
const BILLBOARD_ALL = 7;
const BILLBOARD_Y = 2;
const BILLBOARD_STRETCHED = 8;

/** The soft round dot particles use when they have no texture. */
export function createDotTexture(scene: Scene): RawTexture {
  const size = DOT_SIZE;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const a = Math.max(0, 1 - d);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(a * a * (3 - 2 * a) * 255);
    }
  }
  const dot = new RawTexture(data, size, size, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE);
  dot.hasAlpha = true;
  dot.name = "particle dot";
  return dot;
}

/** What an emitter's draw needs besides its texture. */
export interface DrawOptions {
  /** The emitter's material asset as a Babylon material (shared, never disposed by the draw), or null for none. */
  material?: Material | null;
  /** Mesh mode: the model mesh to draw. Default: the emitter's mesh if it's loaded, else a cube. */
  mesh?: ModelMesh | null;
  /** The camera trails and material-asset quads face. Default: the scene's active camera (the World's first view). */
  camera?: () => Camera | null;
  /** The scene's depth, for soft emitters (`softness`, ADR 0126). Without it they draw hard. */
  depth?: DepthSource | null;
  /**
   * The scene has height fog (ADR 0110): billboards draw as mesh quads, whose material fogs (Babylon's
   * particle shader can't). The player rebuilds draws when this changes.
   */
  heightFog?: boolean;
}

/** A Babylon draw for an emitter, holding up to `capacity` particles before it grows; `isDot` when `texture` is the default dot. */
/**
 * Whether an emitter drawn without a material asset is drawn by a Babylon particle system reading its
 * texture as a sprite sheet. Its texture is then loaded unflipped: Babylon's particle shader reads a
 * sheet's cells with V 0 at the image's top, unlike its other textures (trails, `QuadDraw`, read
 * flipped ones).
 */
export function usesSheet(r: RendererSettings, heightFog = false): boolean {
  return drawsAsSystem(r, heightFog) && r.tiles[0] * r.tiles[1] > 1;
}

/**
 * Whether an emitter without a material asset draws through a Babylon particle system: billboard,
 * stretched, horizontal or vertical, not soft (ADR 0126) and not under height fog. The others draw as
 * meshes (`particleMeshes.ts`), whose materials can fade and fog.
 */
export function drawsAsSystem(r: RendererSettings, heightFog = false): boolean {
  return r.mode !== "mesh" && r.mode !== "trail" && !((r.softness ?? 0) > 0) && !heightFog;
}

export function makeDraw(scene: Scene, name: string, e: SimEmitter, capacity: number, texture: BaseTexture, isDot: boolean, options: DrawOptions = {}): Draw {
  const r = e.renderer;
  const material = options.material ?? null;
  const camera = options.camera ?? (() => scene.activeCamera ?? scene.cameraToUseForPointers);
  const soft = (r.softness ?? 0) > 0 && options.depth ? { softness: r.softness!, depth: options.depth } : null;
  if (r.mode === "mesh") {
    const source = options.mesh ?? meshesIfLoaded(r.mesh)?.[0] ?? meshesIfLoaded(FALLBACK_MESH)![0];
    return new InstanceDraw(scene, name, e, capacity, source, material, texture, soft);
  }
  if (r.mode === "trail") return new QuadDraw(scene, name, e, capacity, "trail", material, texture, camera, soft);
  if (material || !drawsAsSystem(r, options.heightFog)) return new QuadDraw(scene, name, e, capacity, "quads", material, texture, camera, soft);
  return new SystemDraw(scene, name, e, capacity, texture, isDot);
}

/** Copy the simulation's particles into the draw (it must hold `e.count`, see `Draw.ensure`). */
export function copyParticles(d: Draw): void {
  d.update();
}

// --- render order -----------------------------------------------------------------------------------

/** Each of our Babylon particle systems' renderOrder. */
const ORDER = new WeakMap<object, number>();
const orderOf = (ps: object): number => ORDER.get(ps) ?? 0;

/** Stably sort the scene's particle systems by renderOrder, so higher ones draw later (a no-op when sorted). */
export function sortParticleSystems(scene: Scene): void {
  const list = scene.particleSystems;
  for (let i = 1; i < list.length; i++) {
    if (orderOf(list[i - 1]) > orderOf(list[i])) {
      list.sort((a, b) => orderOf(a) - orderOf(b)); // stable
      return;
    }
  }
}

// --- Babylon particle systems -----------------------------------------------------------------------

/**
 * An emitter drawn by a Babylon CPU particle system whose list mirrors the simulation.
 *
 * `blendTiles` (three.quarks mixes the texels of the flipbook's tile and the next by the tile value's
 * fraction): each particle is drawn twice, on its tile at (1 − f) of its opacity and on the next tile
 * at f, from `SimParticle.tileBlend`. That is exact for additive and premultiplied blending (two
 * weighted sums add up to the mixed texel) and close for alpha blending (where the second copy also
 * dims the first a little); it keeps Babylon's own particle shader, where a custom one would need
 * GLSL and WGSL twins of Babylon's particle shaders. It costs a second particle only while a
 * particle is between tiles.
 */
class SystemDraw implements Draw {
  readonly kind = "system";
  ps: BabylonParticleSystem;
  capacity: number;
  /** Babylon particles taken off the list, reused later. */
  private spare: Particle[] = [];
  readonly mode: "billboard" | "stretched" | "horizontal" | "vertical";
  /** Blended flipbook: up to two Babylon particles per simulated one. */
  private readonly blend: boolean;

  constructor(
    private readonly scene: Scene,
    readonly name: string,
    readonly emitter: SimEmitter,
    capacity: number,
    readonly texture: BaseTexture,
    private readonly isDot: boolean,
  ) {
    const r = emitter.renderer;
    this.mode = r.mode === "stretched" || r.mode === "horizontal" || r.mode === "vertical" ? r.mode : "billboard";
    this.blend = r.blendTiles && r.tiles[0] * r.tiles[1] > 1;
    this.capacity = Math.max(1, capacity);
    this.ps = this.build();
  }

  private build(): BabylonParticleSystem {
    const r: RendererSettings = this.emitter.renderer;
    const sheet = r.tiles[0] * r.tiles[1] > 1;
    const ps = new BabylonParticleSystem(this.name, this.capacity * (this.blend ? 2 : 1), this.scene, null, sheet);
    ps.particleTexture = this.texture;
    ps.emitter = Vector3.Zero();
    ps.emitRate = 0;
    ps.updateFunction = () => {}; // the simulation owns the list; update() mirrors into it
    ps.renderingGroupId = 0;
    ps.blendMode = r.blending === "additive" ? BabylonParticleSystem.BLENDMODE_ADD : r.blending === "premultiplied" ? Constants.ALPHA_PREMULTIPLIED : BabylonParticleSystem.BLENDMODE_STANDARD;
    ps.isBillboardBased = this.mode !== "horizontal";
    ps.billboardMode = this.mode === "stretched" ? BILLBOARD_STRETCHED : this.mode === "vertical" ? BILLBOARD_Y : BILLBOARD_ALL;
    if (sheet) {
      const size = this.isDot ? { width: DOT_SIZE, height: DOT_SIZE } : this.texture.getBaseSize();
      ps.spriteCellWidth = size.width / r.tiles[0];
      ps.spriteCellHeight = size.height / r.tiles[1];
    }
    ORDER.set(ps, r.renderOrder);
    ps.start();
    sortParticleSystems(this.scene);
    return ps;
  }

  ensure(need: number): void {
    if (need <= this.capacity) return;
    // Babylon sizes its buffers at construction: rebuild bigger (the simulation keeps its state).
    this.capacity = Math.ceil(need * 1.5);
    this.ps.dispose(false);
    this.spare = [];
    this.ps = this.build();
  }

  update(): void {
    const e = this.emitter;
    const list = this.ps.particles;
    const n = Math.min(e.count, this.capacity);
    let total = n;
    if (this.blend) for (let i = 0; i < n; i++) if (e.pool[i].tileBlend > BLEND_EPSILON) total++;
    while (list.length < total) list.push(this.spare.pop() ?? new Particle(this.ps));
    while (list.length > total) this.spare.push(list.pop()!);
    const tiles = this.emitter.renderer.tiles[0] * this.emitter.renderer.tiles[1];
    // Premultiplied blending takes the colour as already multiplied by alpha (Babylon's particle shader doesn't): weight it all.
    const premultiplied = this.emitter.renderer.blending === "premultiplied";
    let j = 0;
    for (let i = 0; i < n; i++) {
      const p = e.pool[i];
      const f = this.blend ? p.tileBlend : 0;
      this.write(list[j++], p, p.tile, 1 - f, premultiplied);
      if (f > BLEND_EPSILON) this.write(list[j++], p, (p.tile + 1) % tiles, f, premultiplied);
    }
  }

  /** One Babylon particle showing `p` on flipbook `tile`, its opacity times `weight`. */
  private write(b: Particle, p: SimParticle, tile: number, weight: number, premultiplied: boolean): void {
    b.position.set(p.wx, p.wy, p.wz);
    const k = premultiplied ? weight : 1;
    b.color.set(p.r * k, p.g * k, p.b * k, p.a * weight);
    b.cellIndex = tile;
    b.size = 1;
    switch (this.mode) {
      case "stretched": {
        const speed = Math.hypot(p.wvx, p.wvy, p.wvz);
        b.angle = 0;
        b.scale.set(p.size, Math.max(p.length, 1e-4));
        if (speed > 1e-6) b.direction.set(p.wvx, p.wvy, p.wvz);
        else b.direction.set(0, 1, 0);
        break;
      }
      case "horizontal":
        b.angle = p.rotation;
        b.scale.set(p.size, p.size);
        b.direction.set(0.001, 1, 0); // the quad's normal; Babylon needs it off the pole
        break;
      default:
        b.angle = p.rotation;
        b.scale.set(p.size, p.size);
    }
  }

  dispose(): void {
    this.ps.dispose(false);
  }
}
