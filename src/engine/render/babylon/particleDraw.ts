// Internal (ADR 0057, 0075, 0094, 0126, 0153): the particle draw factory. Every Babylon draw of a
// particle effect is made here, by `createDraw`, for the effect player (`effectPlayer.ts`), which the
// World, the particle graph's preview, the thumbnails and the warm-up all play through. It decides:
//
// - which draw a CPU emitter gets: a Babylon CPU `ParticleSystem` (`SystemDraw` below), with its own
//   emission and update turned off, showing the particle list `EffectSimulation` produced (billboards,
//   stretched, horizontal, vertical, flipbook sheets, blending), the cheapest, used whenever it can draw
//   the emitter; else meshes (`particleMeshes.ts`): thin instances for `mesh` mode, ribbons for `trail`,
//   quads for an emitter with a material asset, a soft one or one under height fog;
// - which draw a kernel output gets (ADR 0094, 0126): an instanced mesh with its material asset's copy
//   where the material can (`kernelMaterial.ts`), else the instanced shader draw (`gpuParticles.ts`);
// - what each draw shades with: its material asset, its texture, or the dot, with the soft fade
//   (ADR 0126) wherever the emitter or output is soft;
// - where it sits in the draw order (`renderOrder`, below).
//
// Draw order: Babylon draws a rendering group's particle systems in the order of
// `scene.particleSystems`, so `orderSystem` keeps that list stably sorted by the emitters' renderOrder
// (systems that aren't ours count as 0). They all draw before the group's transparent meshes, mesh-based
// particles included, so a negative renderOrder can't put a billboard emitter under a transparent mesh,
// nor a positive one over it. A mesh draw's place among transparent meshes, 2D content included, is
// its `alphaIndex`, which the layered 2D quads module sets (`placeParticles`, `layeredQuads.ts`, ADR
// 0186). `placeParticles` and `orderSystem` are the only places a particle draw is ordered.
import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { Particle } from "@babylonjs/core/Particles/particle.js";
import { ParticleSystem as BabylonParticleSystem } from "@babylonjs/core/Particles/particleSystem.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { meshesIfLoaded, type ModelMesh } from "../../scene/models";
import type { ParticleBlending, ParticleRenderer as RendererSettings } from "../../scene/particles";
import type { KernelEffect } from "../particles/gpu/kernelEffect";
import type { SimEmitter, SimParticle } from "../particles/simulation";
import { KernelDraw, sortRunOnce, type BabylonRun, type SceneDepth } from "./gpuParticles";
import { heightFogOn } from "./heightFog";
import { KernelMaterialDraw, drawsKernelParticles } from "./kernelMaterial";
import { placeParticles } from "./layeredQuads";
import { BLEND_EPSILON, InstanceDraw, QuadDraw, unlitParticleMaterial } from "./particleMeshes";
import { MycoSoftParticlePlugin, type DepthSource } from "./softParticles";

/** One drawing of an effect's emitter (CPU) or kernel output on the Babylon backend, made by `createDraw`. */
export interface Draw {
  readonly name: string;
  /**
   * `system`: a Babylon particle system; `instances`: thin instances of a mesh; `quads`/`trail`:
   * geometry built on the CPU; `kernel`: a kernel output's instanced shader draw; `kernelMaterial`: a
   * kernel output drawn with its material asset's copy.
   */
  readonly kind: "system" | "instances" | "quads" | "trail" | "kernel" | "kernelMaterial";
  /** The Babylon meshes it draws (transparent, ordered by `alphaIndex`). */
  readonly meshes: readonly Mesh[];
  /** The Babylon particle systems it draws (a `system` draw's one, replaced when it grows). */
  readonly systems: readonly BabylonParticleSystem[];
  /** Whether what it draws with is ready (shaders compiled, textures loaded). */
  isReady(): boolean;
  /** Show the particles as they are now (a kernel draw binds the run's latest state). */
  update(): void;
  /** Free it, leaving shared textures and material assets. */
  dispose(): void;
}

/** A CPU emitter's draw: it mirrors the simulation's particle list. */
export interface EmitterDraw extends Draw {
  readonly kind: "system" | "instances" | "quads" | "trail";
  readonly emitter: SimEmitter;
  /** Particles it holds before it has to grow. */
  capacity: number;
  /** Make room for `need` particles. */
  ensure(need: number): void;
}

/** What a mesh draw shades with: owned by the draw, which disposes it (a shared material asset is left alone). */
export interface DrawMaterial {
  readonly material: Material;
  /** It is the emitter's material asset (or a soft copy of it), not the draw's own unlit material. */
  readonly asset: boolean;
  dispose(): void;
}

/** What the factory asks of the scene's shared resources (`EffectResources`). */
export interface DrawResources {
  readonly scene: Scene;
  /** An emitter's material asset, or null (none, or not available yet). */
  materialFor(path: string | undefined): Material | null;
  /** An unshared copy of a material asset, or null. */
  copyMaterial(path: string, name: string): { material: Material; dispose(): void } | null;
  /** A texture: null while it loads, "failed" if it didn't. */
  textureFor(path: string, sheet: boolean): BaseTexture | null | "failed";
  /** The soft round dot drawn without a texture. */
  dotTexture(): BaseTexture;
  /** A model's mesh: null while it loads, undefined when there's none. */
  meshFor(ref: string): ModelMesh | null | undefined;
  /** The scene's depth, for soft particles. */
  sceneDepth(): SceneDepth;
  warnOnce(key: string, message: string): void;
}

/** A kernel system's run in a `KernelEffect`. */
export type SystemRun = KernelEffect["systems"][number];

/** A CPU emitter to draw, holding up to `capacity` particles before it grows. */
export interface EmitterSource {
  emitter: SimEmitter;
  capacity: number;
  /** The camera trails and quads face. Default: the scene's active camera (the World's first view). */
  camera?: () => Camera | null;
}

/** A kernel system's output to draw. */
export interface KernelSource {
  system: SystemRun;
  output: number;
}

/** The default dot texture's size in pixels. */
export const DOT_SIZE = 64;

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

/** The mesh a mesh-mode emitter draws when its own can't be had. */
const FALLBACK_MESH = "builtin:cube";

/**
 * The draw for a CPU emitter or a kernel output (see the file comment): the one place a particle draw is
 * made, given what it shades with and put in the draw order.
 */
export function createDraw(res: DrawResources, name: string, source: EmitterSource): EmitterDraw;
export function createDraw(res: DrawResources, name: string, source: KernelSource): Draw;
export function createDraw(res: DrawResources, name: string, source: EmitterSource | KernelSource): Draw {
  return "emitter" in source ? emitterDraw(res, name, source) : kernelDraw(res, name, source);
}

/** A CPU emitter's draw: with its material asset, else its texture, else the dot. */
function emitterDraw(res: DrawResources, name: string, { emitter: e, capacity, camera }: EmitterSource): EmitterDraw {
  const scene = res.scene;
  const r = e.renderer;
  const asset = res.materialFor(r.material);
  const heightFog = heightFogOn(scene);
  const found = r.texture && !asset ? res.textureFor(r.texture, usesSheet(r, heightFog)) : null;
  const isDot = !found || found === "failed";
  const texture = isDot ? res.dotTexture() : found;
  if (!asset && drawsAsSystem(r, heightFog)) return new SystemDraw(scene, name, e, capacity, texture, isDot, (ps) => orderSystem(scene, ps, r.renderOrder));
  const look = (twoSided: boolean) => meshMaterial(res, name, asset, r.material, texture, r.blending, twoSided, r.softness ?? 0);
  let d: InstanceDraw | QuadDraw;
  if (r.mode === "mesh") d = new InstanceDraw(scene, name, e, capacity, res.meshFor(r.mesh) ?? meshesIfLoaded(FALLBACK_MESH)![0], look(false));
  else d = new QuadDraw(scene, name, e, capacity, r.mode === "trail" ? "trail" : "quads", look(true), camera ?? (() => scene.activeCamera ?? scene.cameraToUseForPointers));
  placeParticles(d.mesh, r.renderOrder);
  return d;
}

/** A kernel output's draw (ADR 0094, 0126): with its material asset where it can be, else its texture. */
function kernelDraw(res: DrawResources, name: string, { system: s, output: k }: KernelSource): Draw {
  const o = s.kernel.outputs[k];
  const found = o.settings.texture ? res.textureFor(o.settings.texture, false) : null;
  const texture = found && found !== "failed" ? found : res.dotTexture();
  const mesh = o.type === "mesh" ? (res.meshFor(o.settings.mesh) ?? undefined) : undefined;
  const softness = o.settings.softness ?? 0;
  let d: KernelDraw | KernelMaterialDraw | null = null;
  if (o.settings.material && o.type !== "trail") {
    d = kernelMaterialDraw(res, name, s, k, o.settings.material, mesh);
    if (d && softness > 0) soften(d.material, softness, res.sceneDepth());
  }
  if (o.settings.material && !d) res.warnOnce(`kmat|${name}|${o.settings.material}`, `${name}: the kernel output "${s.kernel.name}" draws with its texture: ${o.type === "trail" ? "trails don't take material assets yet" : `"${o.settings.material}" isn't a PBR material (or hasn't loaded)`}.`);
  d ??= new KernelDraw(res.scene, name, s.kernel, k, s.run as BabylonRun, texture, softness > 0 ? { softness, depth: res.sceneDepth() } : null, { mesh });
  placeParticles(d.mesh, o.settings.renderOrder);
  return d;
}

/** A kernel output drawn with a material asset's copy (ADR 0126), or null when the material can't (not PBR, not loaded). */
function kernelMaterialDraw(res: DrawResources, name: string, s: SystemRun, k: number, path: string, mesh: ModelMesh | undefined): KernelMaterialDraw | null {
  if (!drawsKernelParticles(res.materialFor(path))) return null;
  const copy = res.copyMaterial(path, `${name}:material`);
  if (!copy || !drawsKernelParticles(copy.material)) {
    copy?.dispose();
    return null;
  }
  const run = s.run as BabylonRun;
  const source = { textures: (sorted: boolean) => run.textures(sorted), sortFor: () => sortRunOnce(res.scene, run) };
  return new KernelMaterialDraw(res.scene, name, s.kernel, k, source, { material: copy.material, dispose: copy.dispose }, { mesh, interleaved: run.kind === "webgpu" });
}

// --- what mesh draws shade with ---------------------------------------------------------------------

/** A mesh draw's material: the material asset (shared) or its own unlit one, with the soft fade where the emitter is soft. */
function meshMaterial(res: DrawResources, name: string, asset: Material | null, path: string, texture: BaseTexture, blending: ParticleBlending, twoSided: boolean, softness: number): DrawMaterial {
  const own = asset ? null : unlitParticleMaterial(res.scene, `${name}:material`, texture, blending, twoSided);
  const base = (asset ?? own)!;
  const used = softness > 0 ? softened(base, !asset, softness, res.sceneDepth(), (n) => res.copyMaterial(path, n)) : { material: base, copy: null };
  return {
    material: used.material,
    asset: !!asset,
    dispose: () => {
      own?.dispose(false, false); // the texture is shared
      used.copy?.dispose();
    },
  };
}

/**
 * The material a mesh draw uses with soft particles: its own unlit material gains the fade; a material
 * asset is shared, so the draw takes a copy of it with the fade (disposed with the draw). Materials
 * that aren't standard or PBR (none today) draw hard. Returns the material and the copy to dispose.
 */
function softened(material: Material, own: boolean, softness: number, depth: DepthSource, copy: (name: string) => { material: Material; dispose(): void } | null): { material: Material; copy: { dispose(): void } | null } {
  if (own && material instanceof StandardMaterial) {
    soften(material, softness, depth);
    return { material, copy: null };
  }
  if (material instanceof PBRMaterial || material instanceof StandardMaterial) {
    const name = `${material.name} (soft)`;
    const made = copy(name) ?? ((c) => (c ? { material: c, dispose: () => c.dispose(false, false) } : null))(material.clone(name));
    if (made && (made.material instanceof PBRMaterial || made.material instanceof StandardMaterial)) {
      soften(made.material, softness, depth);
      return { material: made.material, copy: made };
    }
    made?.dispose();
  }
  return { material, copy: null };
}

/** The soft fade (ADR 0126) on an unshared material: the one place it's attached. */
function soften(material: StandardMaterial | PBRMaterial, softness: number, depth: DepthSource): void {
  new MycoSoftParticlePlugin(material, softness, depth);
}

// --- render order -----------------------------------------------------------------------------------

/** Each of our Babylon particle systems' renderOrder. */
const ORDER = new WeakMap<object, number>();
const orderOf = (ps: object): number => ORDER.get(ps) ?? 0;

/** Put a Babylon particle system in the draw order: the scene's list stably sorted by renderOrder, higher ones later (a no-op when sorted). */
function orderSystem(scene: Scene, ps: BabylonParticleSystem, renderOrder: number): void {
  ORDER.set(ps, renderOrder);
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
class SystemDraw implements EmitterDraw {
  readonly kind = "system";
  readonly meshes = [] as const;
  /** Its one Babylon particle system (replaced when it grows). */
  readonly systems: [BabylonParticleSystem];
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
    /** Puts each Babylon particle system it builds in the draw order. */
    private readonly place: (ps: BabylonParticleSystem) => void,
  ) {
    const r = emitter.renderer;
    this.mode = r.mode === "stretched" || r.mode === "horizontal" || r.mode === "vertical" ? r.mode : "billboard";
    this.blend = r.blendTiles && r.tiles[0] * r.tiles[1] > 1;
    this.capacity = Math.max(1, capacity);
    this.systems = [this.build()];
  }

  private get ps(): BabylonParticleSystem {
    return this.systems[0];
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
    ps.start();
    this.place(ps);
    return ps;
  }

  ensure(need: number): void {
    if (need <= this.capacity) return;
    // Babylon sizes its buffers at construction: rebuild bigger (the simulation keeps its state).
    this.capacity = Math.ceil(need * 1.5);
    this.ps.dispose(false);
    this.spare = [];
    this.systems[0] = this.build();
  }

  isReady(): boolean {
    return this.ps.isReady();
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
