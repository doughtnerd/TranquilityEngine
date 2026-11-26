// Internal (ADR 0057, 0075, 0094, 0126, 0153, 0251): the particle draw factory. Every Babylon draw of a
// particle effect is made here, by `createDraw`, for the effect player (`effectPlayer.ts`), which the
// World, the particle graph's preview, the thumbnails and the warm-up all play through. Every system
// runs on a kernel executor (ADR 0251), so every draw is a kernel output's. It decides:
//
// - which draw an output gets: an instanced mesh with its material asset's copy where the material can
//   (`kernelMaterial.ts`: quads, stretched, horizontal, vertical, meshes and trails), else the instanced
//   shader draw (`gpuParticles.ts`);
// - what each draw shades with: its material asset, its texture, or the dot, with the soft fade
//   (ADR 0126) wherever the output is soft;
// - where it sits in the draw order: its mesh's place among transparent meshes, 2D content included, is
//   its `alphaIndex`, which the layered 2D quads module sets (`placeParticles`, `layeredQuads.ts`,
//   ADR 0186), the only place a particle draw is ordered.
import { Constants } from "@babylonjs/core/Engines/constants.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { ModelMesh } from "../../scene/models";
import type { KernelEffect } from "../particles/gpu/kernelEffect";
import { KernelDraw, sortRunOnce, type BabylonRun, type SceneDepth } from "./gpuParticles";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { KernelMaterialDraw, drawsKernelParticles } from "./kernelMaterial";
import { layeredQuadMaterial, lightLayeredQuads, placeInLayer, placeParticles } from "./layeredQuads";
import type { LitQuadSetup } from "./lights2DMaterial";
import { MycoSoftParticlePlugin } from "./softParticles";

/** One drawing of a kernel output on the Babylon backend, made by `createDraw`. */
export interface Draw {
  readonly name: string;
  /** `kernel`: the output's instanced shader draw; `kernelMaterial`: drawn with its material asset's copy. */
  readonly kind: "kernel" | "kernelMaterial";
  /** The Babylon meshes it draws (transparent, ordered by `alphaIndex`). */
  readonly meshes: readonly Mesh[];
  /** Whether what it draws with is ready (shaders compiled, textures loaded). */
  isReady(): boolean;
  /** Show the particles as they are now (binds the run's latest state). */
  update(): void;
  /** Free it, leaving shared textures and material assets. */
  dispose(): void;
}

/** What the factory asks of the scene's shared resources (`EffectResources`). */
export interface DrawResources {
  readonly scene: Scene;
  /** An output's material asset, or null (none, or not available yet). */
  materialFor(path: string | undefined): Material | null;
  /** An unshared copy of a material asset, or null. */
  copyMaterial(path: string, name: string): { material: Material; dispose(): void } | null;
  /** A texture: null while it loads, "failed" if it didn't. */
  textureFor(path: string): BaseTexture | null | "failed";
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

/** A kernel system's output to draw. */
export interface KernelSource {
  system: SystemRun;
  output: number;
}

/**
 * A 2D particle system's place (ADR 0415): its draw order among layered 2D content (`sortingOrder`), and its layer
 * batch's 2D lighting, or null when unlit (the 2D materials' setup, ADR 0418: another object when the lighting changes,
 * and the draws are rebuilt; a new order only moves them).
 */
export interface ParticleLayer2D {
  order: number;
  lit: LitQuadSetup | null;
}

/** The default dot texture's size in pixels. */
export const DOT_SIZE = 64;

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
 * The draw for a kernel output (see the file comment): the one place a particle draw is made, given what
 * it shades with and put in the draw order. With its material asset where it can be, else its texture.
 */
export function createDraw(res: DrawResources, name: string, { system: s, output: k }: KernelSource, layer2D: ParticleLayer2D | null = null): Draw {
  const o = s.kernel.outputs[k];
  const found = o.settings.texture ? res.textureFor(o.settings.texture) : null;
  const texture = found && found !== "failed" ? found : res.dotTexture();
  const mesh = o.type === "mesh" ? (res.meshFor(o.settings.mesh) ?? undefined) : undefined;
  const softness = o.settings.softness ?? 0;
  let d: KernelDraw | KernelMaterialDraw | null = null;
  if (o.settings.material) {
    d = kernelMaterialDraw(res, name, s, k, o.settings.material, mesh);
    if (d && layer2D?.lit) lightLayeredQuads(d.material, layer2D.lit); // a 2D system's material lit by 2D lights (ADR 0415)
    if (d && softness > 0) soften(d.material, softness, res.sceneDepth());
    if (!d) res.warnOnce(`kmat|${name}|${o.settings.material}`, `${name}: the kernel output "${s.kernel.name}" draws with its texture: "${o.settings.material}" isn't a PBR material (or hasn't loaded).`);
  }
  // A lit 2D system's output without a material (ADR 0415): the 2D quad material with its texture and blending, which
  // the 2D light plugin takes (the instanced shader draw's material can't).
  if (!d && layer2D?.lit) d = litQuadDraw(res, name, s, k, texture, o.settings.blending, layer2D.lit, mesh);
  d ??= new KernelDraw(res.scene, name, s.kernel, k, s.run as BabylonRun, texture, softness > 0 ? { softness, depth: res.sceneDepth() } : null, { mesh });
  if (layer2D) placeInLayer(d.mesh, layer2D.order);
  else placeParticles(d.mesh, o.settings.renderOrder);
  return d;
}

/** A lit 2D system's output drawn with the 2D quad material (its texture, its blending) and the 2D light plugin. */
function litQuadDraw(res: DrawResources, name: string, s: SystemRun, k: number, texture: BaseTexture, blending: string, lit: LitQuadSetup, mesh: ModelMesh | undefined): KernelMaterialDraw {
  const m = layeredQuadMaterial(`${name}:lit2d`, res.scene, texture as Texture);
  texture.hasAlpha = true;
  if (blending === "additive") m.alphaMode = Constants.ALPHA_ADD;
  else if (blending === "premultiplied") m.alphaMode = Constants.ALPHA_PREMULTIPLIED;
  lightLayeredQuads(m, lit);
  const run = s.run as BabylonRun;
  const source = { textures: (sorted: boolean, trail: boolean) => run.textures(sorted, trail), sortFor: () => sortRunOnce(res.scene, run) };
  return new KernelMaterialDraw(res.scene, name, s.kernel, k, source, { material: m, dispose: () => m.dispose() }, { mesh, interleaved: run.kind === "webgpu" });
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
  const source = { textures: (sorted: boolean, trail: boolean) => run.textures(sorted, trail), sortFor: () => sortRunOnce(res.scene, run) };
  return new KernelMaterialDraw(res.scene, name, s.kernel, k, source, { material: copy.material, dispose: copy.dispose }, { mesh, interleaved: run.kind === "webgpu" });
}

/** The soft fade (ADR 0126) on a material asset's unshared copy: the one place it's attached. */
function soften(material: PBRMaterial, softness: number, depth: SceneDepth): void {
  new MycoSoftParticlePlugin(material, softness, depth);
}
