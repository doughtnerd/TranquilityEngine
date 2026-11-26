/**
 * The 2D lighting rig on Babylon (ADR 0399, 0413), part of the core lighting rig (ADR 0252): Light2D components drawn
 * into screen-space light textures, one per layer batch and blend style (with two more, the directional textures, for a
 * batch whose lights light normal maps), and ShadowCaster2Ds' edges extruded into shadow textures (a channel per
 * shadowed light). The lit layered-quad material (`lights2DMaterial.ts`) reads them.
 *
 * - `sync(world, limits)` runs once a frame, before the content phase, so the sprite and quad features see this frame's
 *   layer batches: it batches the layers (`render/lights2D/layerBatches.ts`), ranks shadowed lights against the tier's
 *   cap, and builds every light's and shadow's geometry in world space (camera-independent), into vertex streams.
 *   `version` changes when the batching or the texture layout does, and `onLayoutChange` tells the 2D materials
 *   (`materials2D.ts`), which pick their lit materials again.
 * - `layout()` is the light textures' layout for the pass plan (ADR 0274): only it rebuilds the frame graph.
 * - `draw…` are called by the frame graph's 2D light task (`frameGraph.ts`) for each camera: one draw per shadow
 *   texture and one per light texture (plus one per sprite light's texture), with nothing per light but vertex data.
 *
 * With no Light2D (or the scene view's 2D Lighting off) there's no layout: the pass isn't planned and every 2D draw is
 * unlit, as before 2D lights existed.
 */
import { Constants } from "@babylonjs/core/Engines/constants.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import type { DataBuffer } from "@babylonjs/core/Buffers/dataBuffer.js";
import { EffectWrapper } from "@babylonjs/core/Materials/effectRenderer.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import type { ThinTexture } from "@babylonjs/core/Materials/Textures/thinTexture.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import type { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import { Observable } from "@babylonjs/core/Misc/observable.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { World } from "../../core/World";
import type { Lights2DLimits } from "../../core/graphics";
import type { Point2 } from "../../physics/polygon";
import { Assets } from "../../scene/Assets";
import { splitSpriteRef } from "../../scene/importSettings";
import { CompositeShadowCaster2D, Light2D, ShadowCaster2D } from "../components";
import { casterGroups, casterOutline, type CasterOutline } from "../lights2D/casterOutlines";
import { layerBatches, type LayerBatch } from "../lights2D/layerBatches";
import { falloffExponent, freeformBounds, freeformMesh, insidePolygon, type LightMesh } from "../lights2D/lightShapes";
import { affineOf, srgbToLinear, targetsLayer } from "../lights2D/sample";
import { blendStyleIndex, masksOverlap, type LightBlendStyle } from "../lights2D/settings";
import type { Light2DLayout } from "../passPlan";
import { spriteFrame } from "../spriteFrame";
import { LIGHT2D_ATTRIBUTES, LIGHT2D_PASS, LIGHT2D_PASS_DIR, LIGHT2D_SAMPLERS, LIGHT2D_SIZES, LIGHT2D_UNIFORMS, SHADOW2D_ATTRIBUTES, SHADOW2D_PASS, SHADOW2D_SIZES, SHADOW2D_UNIFORMS } from "./lights2DShaders";

/** What the rig borrows from the renderer. */
export interface Lights2DDeps {
  readonly scene: Scene;
  /** A loaded texture, or null (it starts loading). */
  texture(path: string): Texture | null;
  /** A loaded texture's authored size (ADR 0119), or null. */
  textureSize(path: string): readonly [number, number] | null;
}

/** Vertex data built on the CPU: per attribute a growing float list, and triangle indices. */
class CpuStream {
  readonly data: number[][];
  readonly indices: number[] = [];
  vertices = 0;
  constructor(readonly sizes: readonly number[]) {
    this.data = sizes.map(() => []);
  }
  /** Add a vertex: one value list per attribute, in order. */
  vertex(...values: readonly (readonly number[])[]): number {
    values.forEach((v, i) => {
      const list = this.data[i]!;
      for (let k = 0; k < this.sizes[i]!; k++) list.push(v[k] ?? 0);
    });
    return this.vertices++;
  }
  clear(): void {
    for (const d of this.data) d.length = 0;
    this.indices.length = 0;
    this.vertices = 0;
  }
}

/** The GPU side of a stream: growing dynamic vertex and index buffers. */
class GpuStream {
  private buffers: Record<string, VertexBuffer> = {};
  private index: DataBuffer | null = null;
  private vertexCapacity = 0;
  private indexCapacity = 0;
  indexCount = 0;

  constructor(
    private readonly engine: AbstractEngine,
    private readonly kinds: readonly string[],
    private readonly sizes: readonly number[],
  ) {}

  upload(cpu: CpuStream): void {
    this.indexCount = cpu.indices.length;
    if (!this.indexCount) return;
    if (cpu.vertices > this.vertexCapacity) {
      for (const b of Object.values(this.buffers)) b.dispose();
      this.vertexCapacity = Math.max(64, cpu.vertices * 2);
      this.buffers = {};
      this.kinds.forEach((kind, i) => {
        this.buffers[kind] = new VertexBuffer(this.engine, new Float32Array(this.vertexCapacity * this.sizes[i]!), kind, { updatable: true, size: this.sizes[i]!, stride: this.sizes[i]! });
      });
    }
    this.kinds.forEach((kind, i) => this.buffers[kind]!.updateDirectly(Float32Array.from(cpu.data[i]!), 0));
    if (cpu.indices.length > this.indexCapacity) {
      if (this.index) this.engine._releaseBuffer(this.index);
      this.indexCapacity = Math.max(96, cpu.indices.length * 2);
      this.index = this.engine.createIndexBuffer(new Uint32Array(this.indexCapacity), true, "myco2DLights");
    }
    this.engine.updateDynamicIndexBuffer(this.index!, Uint32Array.from(cpu.indices), 0);
  }

  /** Bind and draw what was uploaded (nothing when empty). */
  draw(wrapper: EffectWrapper): void {
    if (!this.indexCount || !this.index) return;
    this.engine.bindBuffers(this.buffers, this.index, wrapper.effect);
    this.engine.drawElementsType(Constants.MATERIAL_TriangleFillMode, 0, this.indexCount);
  }

  dispose(): void {
    for (const b of Object.values(this.buffers)) b.dispose();
    if (this.index) this.engine._releaseBuffer(this.index);
    this.buffers = {};
    this.index = null;
  }
}

/** A light texture's draw data: the batched lights, and sprite lights by texture. */
interface TextureDraw {
  cpu: CpuStream;
  gpu: GpuStream;
  sprites: { texture: Texture; cpu: CpuStream; gpu: GpuStream }[];
}

/** One caster this frame, in world XY. */
interface CasterNow {
  loops: Point2[][];
  chains: Point2[][];
  /** For a composite (ADR 0415): each loop's member, so edges inside another member's loop don't cast. Null for one caster. */
  owner: number[] | null;
  box: [number, number, number, number];
  z: number;
  targets: readonly string[];
  selfShadows: boolean;
  /** Its shadow layers (ADR 0415). */
  mask: readonly string[];
}

/** Floats per accurate light in a batch's `accurate` uniforms (six vec4s; see `accurateUniforms`). */
export const ACCURATE_FLOATS = 24;
const MASK_CHANNEL = { none: -1, r: 0, g: 1, b: 2, a: 3 } as const;

/** One light this frame, with what shadows need. */
interface LightNow {
  light: Light2D;
  /** World bounds, and the reach shadows extrude past. */
  box: [number, number, number, number];
  reach: number;
  x: number;
  y: number;
  slot: number;
}

/** A Light2D component's derived geometry, kept while its fields don't change. */
interface LightCache {
  sig: string;
  mesh: LightMesh | null;
}

const WHITE_PIXEL = new Uint8Array([255, 255, 255, 255]);
const BLACK_PIXEL = new Uint8Array([0, 0, 0, 0]);
const CLIP_QUAD: [number, number][] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

/** The rigs by scene, for the lit 2D material (which has only its scene and mesh). */
const rigs = new WeakMap<Scene, BabylonLights2D>();

/** @internal The 2D lighting rig drawing `scene`, if any (a World's renderer makes one). */
export function lights2DOf(scene: Scene): BabylonLights2D | undefined {
  return rigs.get(scene);
}

/** Diagnostics (`RenderDiagnostics.lighting.lights2D`). */
export interface Lights2DState {
  lights: number;
  shadowed: number;
  unshadowed: number;
  casters: number;
  batches: number;
  merged: number;
  styles: number;
  textures: number;
}

/** @internal The 2D lighting rig of one Babylon scene. */
export class BabylonLights2D {
  /** Changes when the layer batches or the texture layout change. */
  version = 0;
  /** Notified when `version` changes (the 2D materials watch it, ADR 0418). */
  readonly onLayoutChange = new Observable<void>();
  /** The editor's scene view can switch 2D lighting off (every 2D draw unlit). */
  enabled = true;
  private layers: readonly string[] = [];
  private layerBatch: Int32Array = new Int32Array(0);
  private batches: LayerBatch[] = [];
  /** Per layer batch: its accurate lights (ADR 0415), packed `ACCURATE_FLOATS` each, rebuilt every frame. */
  private accurate: Float32Array[] = [];
  /** The lights lighting accurately in each batch (left out of its light textures). */
  private accurateSets: Set<Light2D>[] = [];
  private styleList: readonly LightBlendStyle[] = [];
  private currentLayout: Light2DLayout | null = null;
  private layoutKey = "";
  private draws: TextureDraw[][] = [];
  private shadows: { cpu: CpuStream; gpu: GpuStream }[] = [];
  private readonly lightCache = new WeakMap<Light2D, LightCache>();
  private readonly casterCache = new WeakMap<ShadowCaster2D, CasterOutline>();
  private readonly wrappers = new Map<string, EffectWrapper>();
  private white: RawTexture | null = null;
  private black: RawTexture | null = null;
  private stateNow: Lights2DState = { lights: 0, shadowed: 0, unshadowed: 0, casters: 0, batches: 0, merged: 0, styles: 0, textures: 0 };
  /** 8-bit light textures where half float isn't renderable: values stored at a quarter. */
  readonly range: number;

  constructor(private readonly deps: Lights2DDeps) {
    rigs.set(deps.scene, this);
    const caps = deps.scene.getEngine().getCaps();
    this.range = caps.textureHalfFloatRender ? 1 : 4;
  }

  private get engine(): AbstractEngine {
    return this.deps.scene.getEngine();
  }

  /** This frame's 2D lights and casters, batched and built (see the file comment). */
  sync(world: World, limits: Lights2DLimits): void {
    const layers = world.settings.render.sortingLayers;
    const styles = world.settings.lighting2D.blendStyles;
    const lights = this.enabled ? world._componentsOfType(Light2D).filter((l) => l.isActiveAndEnabled && l.intensity > 0) : [];
    const now: LightNow[] = lights.map((light) => this.lightNow(world, light));
    // Accurate normal maps (ADR 0415): point lights asking for it on a tier that allows it. A batch takes the tier's cap
    // of them (brightest and biggest first); the rest light as fast, so batching runs again when any is over.
    const accurate = new Set(limits.normalMaps && limits.accurateLights > 0 ? lights.filter((l) => l.normalMaps === "accurate" && l.type === "point") : []);
    const batch = () =>
      layerBatches(
        layers.length,
        lights.map((l) => ({
          layers: l.targetSortingLayers.length ? l.targetSortingLayers.map((n) => layers.indexOf(n)).filter((i) => i >= 0) : null,
          style: blendStyleIndex(world.settings.lighting2D, l.blendStyle),
          directional: limits.normalMaps && l.normalMaps !== "off" && !accurate.has(l),
        })),
        limits.layerBatches,
      );
    let batching = batch();
    const rank = (n: LightNow) => n.light.intensity * n.reach * n.reach;
    const accurateIn = (b: LayerBatch) => b.lights.map((i) => now[i]!).filter((n) => accurate.has(n.light)).sort((p, q) => rank(q) - rank(p));
    let over = false;
    for (const b of batching.batches) for (const n of accurateIn(b).slice(limits.accurateLights)) over = accurate.delete(n.light) || over;
    if (over) batching = batch();
    this.accurateSets = batching.batches.map((b) => new Set(accurateIn(b).map((n) => n.light)));
    // Shadowed lights, ranked by intensity × reach² (bigger, brighter lights keep their shadows), capped by the tier.
    const shadowed = now.filter((n) => n.light.shadows && n.light.type !== "global" && n.light.shadowStrength > 0);
    shadowed.sort((a, b) => b.light.intensity * b.reach * b.reach - a.light.intensity * a.reach * a.reach);
    const kept = shadowed.slice(0, limits.shadowedLights);
    kept.forEach((n, i) => (n.slot = i));
    const layout: Light2DLayout | null = batching.batches.length
      ? { batches: batching.batches.map((b) => ({ styles: b.styles.length, directional: b.directional })), scale: limits.textureScale, shadowTextures: Math.ceil(kept.length / 4), lowPrecision: this.range !== 1 }
      : null;
    const key = `${JSON.stringify(layout)}|${[...batching.layerBatch].join(",")}|${batching.batches.map((b) => b.styles.join(".")).join(",")}|${this.accurateSets.map((s) => s.size).join(",")}`;
    const changed = key !== this.layoutKey;
    if (changed) {
      this.layoutKey = key;
      this.version++;
    }
    this.layers = layers;
    this.layerBatch = batching.layerBatch;
    this.batches = batching.batches;
    this.styleList = styles;
    this.currentLayout = layout;

    const casters = kept.length ? this.castersNow(world) : [];
    this.buildLights(world, now, limits);
    this.buildAccurate(world, now, limits);
    this.buildShadows(now.filter((n) => n.slot >= 0), casters);
    this.stateNow = {
      lights: lights.length,
      shadowed: kept.length,
      unshadowed: shadowed.length - kept.length,
      casters: casters.length,
      batches: batching.batches.length,
      merged: batching.merged,
      styles: new Set(batching.batches.flatMap((b) => b.styles)).size,
      textures: batching.batches.reduce((n, b) => n + b.styles.length * (b.directional ? 3 : 1), 0) + Math.ceil(kept.length / 4),
    };
    if (changed) this.onLayoutChange.notifyObservers(); // once this frame's batches are in place
  }

  /** The light textures' layout this frame, or null when nothing is lit. */
  layout(): Light2DLayout | null {
    return this.currentLayout;
  }

  /** The layer batch a sorting layer's draws read (-1: unlit). */
  batchOfLayer(name: string): number {
    if (!this.currentLayout) return -1;
    const i = this.layers.indexOf(name);
    return i < 0 ? (this.layerBatch[0] ?? -1) : (this.layerBatch[i] ?? -1);
  }

  /**
   * A layer batch's blend styles (indices into the project's), whether it has the directional textures, and its accurate
   * lights this frame (ADR 0415; `accurateUniforms` packs them; their count changes only with `version`).
   */
  batch(i: number): { styles: readonly number[]; directional: boolean; accurate: Float32Array } | null {
    const b = this.batches[i];
    return b ? { styles: b.styles, directional: b.directional, accurate: this.accurate[i] ?? new Float32Array(0) } : null;
  }

  /** A blend style by index (the first when out of range). */
  style(i: number): LightBlendStyle {
    return this.styleList[i] ?? this.styleList[0] ?? { name: "Multiply", mask: "none", multiply: 1, add: 0 };
  }

  state(): Lights2DState {
    return this.stateNow;
  }

  // --- building ---------------------------------------------------------------------------------

  private lightNow(world: World, light: Light2D): LightNow {
    const e = light.node.entity;
    const t = affineOf(world.worldMatrix(e), e * 16);
    const scale = Math.max(Math.hypot(t[0], t[1]), Math.hypot(t[2], t[3]));
    let local: [number, number, number, number];
    if (light.type === "point") local = [-light.outerRadius, -light.outerRadius, light.outerRadius, light.outerRadius];
    else if (light.type === "freeform") local = freeformBounds(light.shape.map((p): Point2 => [p.x, p.y]), light.falloffSize);
    else if (light.type === "sprite") local = this.spriteQuad(world, light)?.box ?? [-0.5, -0.5, 0.5, 0.5];
    else local = [-Infinity, -Infinity, Infinity, Infinity];
    const box = transformBox(t, local);
    const reach = Number.isFinite(box[0]) ? Math.hypot(box[2] - box[0], box[3] - box[1]) + scale : 0;
    return { light, box, reach, x: t[4], y: t[5], slot: -1 };
  }

  private buildLights(world: World, now: readonly LightNow[], limits: Lights2DLimits): void {
    const engine = this.engine;
    // Reuse each texture's streams; sprite streams are rebuilt (sprite lights are few).
    this.draws.forEach((row) => row.forEach((d) => d.sprites.forEach((s) => s.gpu.dispose())));
    const draws: TextureDraw[][] = this.batches.map((b, bi) =>
      b.styles.map((_, si) => {
        const old = this.draws[bi]?.[si];
        if (old) {
          old.cpu.clear();
          old.sprites = [];
          return old;
        }
        return { cpu: new CpuStream(LIGHT2D_SIZES), gpu: new GpuStream(engine, LIGHT2D_ATTRIBUTES, LIGHT2D_SIZES), sprites: [] };
      }),
    );
    for (let bi = draws.length; bi < this.draws.length; bi++) this.draws[bi]?.forEach((d) => d.gpu.dispose());
    this.draws = draws;
    const byLight = new Map<Light2D, LightNow>(now.map((n) => [n.light, n]));
    const settings = world.settings.lighting2D;
    this.batches.forEach((b, bi) => {
      b.styles.forEach((style, si) => {
        const draw = draws[bi]![si]!;
        const skip = this.accurateSets[bi];
        // Additive lights first, then alpha blend ones in scene order, each covering what's drawn before it (ADR 0415).
        const ordered = [...b.lights].sort((p, q) => Number(now[p]?.light.overlap === "alphaBlend") - Number(now[q]?.light.overlap === "alphaBlend"));
        for (const li of ordered) {
          const n = now[li];
          if (!n || skip?.has(n.light) || blendStyleIndex(settings, n.light.blendStyle) !== style) continue;
          this.appendLight(world, draw, byLight.get(n.light)!, limits);
        }
        draw.gpu.upload(draw.cpu);
        for (const s of draw.sprites) s.gpu.upload(s.cpu);
      });
    });
  }

  /** One light's geometry into a texture's draw (see `lights2DShaders.ts` for the attributes). */
  private appendLight(world: World, draw: TextureDraw, n: LightNow, limits: Lights2DLimits): void {
    const l = n.light;
    const e = l.node.entity;
    const m = world.worldMatrix(e);
    const t = affineOf(m, e * 16);
    const z = m[e * 16 + 14]!;
    const i = Math.max(l.intensity, 0);
    const color = [srgbToLinear(l.color.r) * i, srgbToLinear(l.color.g) * i, srgbToLinear(l.color.b) * i, 1];
    const directional = limits.normalMaps && l.normalMaps !== "off" ? 1 : 0;
    const misc = (kind: number) => [kind, falloffExponent(l.falloff), directional, n.slot];
    const light = [n.x, n.y, l.height, l.shadowStrength];
    const extra = [limits.softShadows ? Math.max(0, Math.min(1, l.shadowSoftness)) : 0, z, l.overlap === "alphaBlend" ? 1 : 0, 0];
    const place = (x: number, y: number) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
    const quad = (cpu: CpuStream, corners: number[][], locals: number[][], shape: number[], kind: number) => {
      const base = cpu.vertices;
      corners.forEach((c, k) => cpu.vertex(c, locals[k]!, color, shape, misc(kind), light, extra));
      cpu.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    if (l.type === "global") {
      quad(draw.cpu, CLIP_QUAD, CLIP_QUAD, [0, 0, 0, 0], 0);
    } else if (l.type === "point") {
      const r = Math.max(l.outerRadius, 0);
      const locals = CLIP_QUAD.map(([x, y]) => [x * r, y * r]);
      const outer = Math.min(Math.max(l.outerAngle, 0), 360);
      const shape = [l.innerRadius, l.outerRadius, outer >= 360 ? 180 : Math.min(Math.max(l.innerAngle, 0), outer) / 2, outer >= 360 ? 180 : outer / 2];
      quad(draw.cpu, locals.map(([x, y]) => place(x!, y!)), locals, shape, 1);
    } else if (l.type === "freeform") {
      const sig = `${JSON.stringify(l.shape.map((p) => [p.x, p.y]))}|${l.falloffSize}`;
      let cache = this.lightCache.get(l);
      if (!cache || cache.sig !== sig) this.lightCache.set(l, (cache = { sig, mesh: freeformMesh(l.shape.map((p): Point2 => [p.x, p.y]), l.falloffSize) }));
      const mesh = cache.mesh;
      if (!mesh) return;
      const base = draw.cpu.vertices;
      for (let v = 0; v < mesh.alpha.length; v++) {
        const x = mesh.positions[v * 2]!, y = mesh.positions[v * 2 + 1]!;
        draw.cpu.vertex(place(x, y), [x, y], [color[0]!, color[1]!, color[2]!, mesh.alpha[v]!], [0, 0, 0, 0], misc(2), light, extra);
      }
      for (const idx of mesh.indices) draw.cpu.indices.push(base + idx);
    } else {
      const q = this.spriteQuad(world, l);
      if (!q) return;
      let s = draw.sprites.find((d) => d.texture === q.texture);
      if (!s) draw.sprites.push((s = { texture: q.texture, cpu: new CpuStream(LIGHT2D_SIZES), gpu: new GpuStream(this.engine, LIGHT2D_ATTRIBUTES, LIGHT2D_SIZES) }));
      const [x0, y0, x1, y1] = q.box;
      const [u0, v0, u1, v1] = q.uv;
      quad(s.cpu, [place(x0, y0), place(x1, y0), place(x1, y1), place(x0, y1)], [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], [0, 0, 0, 0], 3);
    }
  }

  /**
   * Each batch's accurate lights packed for the lit material (ADR 0415), per light six vec4s:
   * position X, Y, height, shadow slot; world→local 2×2 (local = (m0·dx + m2·dy, m1·dx + m3·dy)); falloff exponent,
   * shadow strength, softness, mask channel; inner radius, outer radius, half inner and half outer angle; linear colour ×
   * intensity; the blend style's multiply and add.
   */
  private buildAccurate(world: World, now: readonly LightNow[], limits: Lights2DLimits): void {
    const byLight = new Map<Light2D, LightNow>(now.map((n) => [n.light, n]));
    this.accurate = this.accurateSets.map((set) => {
      const out = new Float32Array(set.size * ACCURATE_FLOATS);
      let k = 0;
      for (const l of set) {
        const n = byLight.get(l)!;
        const e = l.node.entity;
        const t = affineOf(world.worldMatrix(e), e * 16);
        const det = t[0] * t[3] - t[1] * t[2];
        const inv = Math.abs(det) < 1e-12 ? [0, 0, 0, 0] : [t[3] / det, -t[1] / det, -t[2] / det, t[0] / det];
        const outer = Math.min(Math.max(l.outerAngle, 0), 360);
        const style = this.style(blendStyleIndex(world.settings.lighting2D, l.blendStyle));
        const i = Math.max(l.intensity, 0);
        out.set(
          [
            n.x, n.y, l.height, n.slot,
            ...inv,
            falloffExponent(l.falloff), Math.max(0, Math.min(1, l.shadowStrength)), limits.softShadows ? Math.max(0, Math.min(1, l.shadowSoftness)) : 0, MASK_CHANNEL[style.mask],
            l.innerRadius, l.outerRadius, outer >= 360 ? 180 : Math.min(Math.max(l.innerAngle, 0), outer) / 2, outer >= 360 ? 180 : outer / 2,
            srgbToLinear(l.color.r) * i, srgbToLinear(l.color.g) * i, srgbToLinear(l.color.b) * i, 0,
            style.multiply, style.add, 0, 0,
          ],
          k,
        );
        k += ACCURATE_FLOATS;
      }
      return out;
    });
  }

  /** A sprite light's quad in its node's XY (by its sprite's frame), its UVs and texture, or null while it loads. */
  private spriteQuad(world: World, l: Light2D): { box: [number, number, number, number]; uv: [number, number, number, number]; texture: Texture } | null {
    const { path, slice } = splitSpriteRef(l.sprite);
    if (!path) return null;
    const texture = this.deps.texture(path);
    const size = this.deps.textureSize(path);
    if (!texture || !size) return null;
    const f = spriteFrame(Assets.importSettings(path), slice, size[0], size[1], { component: 0, project: world.settings.render.pixelsPerUnit });
    const [w, h] = f.size, [px, py] = f.pivot;
    return { box: [-px * w, -py * h, (1 - px) * w, (1 - py) * h], uv: f.uv ?? [0, 0, 1, 1], texture };
  }

  private castersNow(world: World): CasterNow[] {
    const out: CasterNow[] = [];
    const textureSize = (path: string) => this.deps.textureSize(path);
    const casters = world._componentsOfType(ShadowCaster2D).filter((c) => c.isActiveAndEnabled);
    // A CompositeShadowCaster2D's casters cast as one, with its settings (ADR 0415).
    for (const g of casterGroups(world, casters, (c) => c instanceof CompositeShadowCaster2D)) {
      if (!g.settings.castShadows) continue;
      const loops: Point2[][] = [], chains: Point2[][] = [], owner: number[] = [];
      let z = 0;
      g.members.forEach((c, mi) => {
        if (!g.composite && !c.castShadows) return;
        const outline = casterOutline(world, c, textureSize);
        this.casterCache.set(c, outline);
        const e = c.node.entity;
        const m = world.worldMatrix(e);
        const t = affineOf(m, e * 16);
        z = m[e * 16 + 14]!;
        const det = t[0] * t[3] - t[1] * t[2];
        const place = (p: Point2): Point2 => [t[0] * p[0] + t[2] * p[1] + t[4], t[1] * p[0] + t[3] * p[1] + t[5]];
        // Loops with the solid on their left: a shape source's already are (holes clockwise); the rest are made counter-clockwise.
        for (const loop of outline.loops) {
          const w = loop.map(place);
          loops.push(outline.from === "source" ? (det < 0 ? w.reverse() : w) : area(w) < 0 ? w.reverse() : w);
          owner.push(mi);
        }
        for (const ch of outline.chains) chains.push(ch.map(place));
      });
      if (!loops.length && !chains.length) continue;
      let box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const list of [...loops, ...chains]) for (const [x, y] of list) box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
      const s = g.settings;
      out.push({ loops, chains, owner: g.composite ? owner : null, box, z, targets: s.targetSortingLayers, selfShadows: s.selfShadows, mask: s.shadowMask });
    }
    return out;
  }

  private buildShadows(shadowed: readonly LightNow[], casters: readonly CasterNow[]): void {
    const count = Math.ceil(shadowed.length / 4);
    for (let k = count; k < this.shadows.length; k++) this.shadows[k]!.gpu.dispose();
    this.shadows.length = Math.min(this.shadows.length, count);
    for (let k = 0; k < count; k++) {
      const s = (this.shadows[k] ??= { cpu: new CpuStream(SHADOW2D_SIZES), gpu: new GpuStream(this.engine, SHADOW2D_ATTRIBUTES, SHADOW2D_SIZES) });
      s.cpu.clear();
    }
    for (const n of shadowed) {
      const s = this.shadows[n.slot >> 2]!;
      const c = n.slot & 3;
      const channel = [c === 0 ? 1 : 0, c === 1 ? 1 : 0, c === 2 ? 1 : 0, c === 3 ? 1 : 0];
      const lightAttr = [n.x, n.y, n.reach, 0];
      const lightTargets = n.light.targetSortingLayers;
      for (const caster of casters) {
        if (!overlaps(caster.box, n.box)) continue;
        if (lightTargets.length && caster.targets.length && !caster.targets.some((t) => targetsLayer(lightTargets, t))) continue;
        if (!masksOverlap(n.light.shadowMask, caster.mask)) continue; // ADR 0415: light masks
        const edge = (a: Point2, b: Point2) => {
          const base = s.cpu.vertex(a, [0, caster.z], lightAttr, channel);
          s.cpu.vertex(b, [0, caster.z], lightAttr, channel);
          s.cpu.vertex(b, [1, caster.z], lightAttr, channel);
          s.cpu.vertex(a, [1, caster.z], lightAttr, channel);
          s.cpu.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        };
        caster.loops.forEach((loop, li) => {
          for (let i = 0; i < loop.length; i++) {
            const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
            if (caster.owner) {
              const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
              if (caster.loops.some((other, oi) => caster.owner![oi] !== caster.owner![li] && insidePolygon(other, mx, my))) continue;
            }
            if (!caster.selfShadows) {
              // Only edges facing away from the light (their outward normal, right of a→b, points away): the shadow starts
              // at the caster's far side, so its own face stays lit (ADR 0413 self shadows off).
              const nx = b[1] - a[1], ny = a[0] - b[0];
              if (nx * ((a[0] + b[0]) / 2 - n.x) + ny * ((a[1] + b[1]) / 2 - n.y) <= 0) continue;
            }
            edge(a, b);
          }
        });
        for (const chain of caster.chains) for (let i = 1; i < chain.length; i++) edge(chain[i - 1]!, chain[i]!);
      }
    }
    for (const s of this.shadows) s.gpu.upload(s.cpu);
  }

  // --- drawing (the frame graph's 2D light task) -------------------------------------------------

  private wrapper(name: string, vertex: string, attributes: readonly string[], uniforms: readonly string[], samplers: readonly string[]): EffectWrapper {
    let w = this.wrappers.get(name);
    if (!w) {
      w = new EffectWrapper({
        engine: this.engine,
        name,
        vertexShader: vertex,
        fragmentShader: name,
        useShaderStore: true,
        attributeNames: [...attributes],
        uniformNames: [...uniforms],
        samplerNames: [...samplers],
        shaderLanguage: this.engine.isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
        useAsPostProcess: false,
      });
      this.wrappers.set(name, w);
    }
    return w;
  }

  /** Whether every effect the pass needs has compiled (the pass skips drawing until then). */
  ready(directional: boolean): boolean {
    const light = this.wrapper(LIGHT2D_PASS, LIGHT2D_PASS, LIGHT2D_ATTRIBUTES, LIGHT2D_UNIFORMS, LIGHT2D_SAMPLERS);
    const dir = directional ? this.wrapper(LIGHT2D_PASS_DIR, LIGHT2D_PASS, LIGHT2D_ATTRIBUTES, LIGHT2D_UNIFORMS, LIGHT2D_SAMPLERS) : null;
    const shadow = this.wrapper(SHADOW2D_PASS, SHADOW2D_PASS, SHADOW2D_ATTRIBUTES, SHADOW2D_UNIFORMS, []);
    return light.isReady() && (!dir || dir.isReady()) && shadow.isReady();
  }

  /** Draw shadow texture `k` (its render target bound and cleared). */
  drawShadows(k: number, viewProjection: Matrix): void {
    const s = this.shadows[k];
    if (!s?.gpu.indexCount) return;
    const engine = this.engine;
    const w = this.wrapper(SHADOW2D_PASS, SHADOW2D_PASS, SHADOW2D_ATTRIBUTES, SHADOW2D_UNIFORMS, []);
    if (!w.isReady()) return;
    this.beginDraw(Constants.ALPHA_MAX, 1);
    engine.enableEffect(w.drawWrapper);
    w.effect.setMatrix("viewProjection", viewProjection);
    s.gpu.draw(w);
    this.endDraw(1);
  }

  /**
   * Draw layer batch `batch`'s light texture for its style slot `slot` (its render target, or the three directional
   * targets, bound and cleared). `bindShadow(effect, name, k)` binds shadow texture `k` (or nothing past the last).
   */
  drawLights(batch: number, slot: number, viewProjection: Matrix, size: readonly [number, number], bindShadow: (effect: EffectWrapper["effect"], name: string, k: number) => boolean): void {
    const d = this.draws[batch]?.[slot];
    const b = this.batches[batch];
    if (!d || !b) return;
    const directional = b.directional;
    const w = directional ? this.wrapper(LIGHT2D_PASS_DIR, LIGHT2D_PASS, LIGHT2D_ATTRIBUTES, LIGHT2D_UNIFORMS, LIGHT2D_SAMPLERS) : this.wrapper(LIGHT2D_PASS, LIGHT2D_PASS, LIGHT2D_ATTRIBUTES, LIGHT2D_UNIFORMS, LIGHT2D_SAMPLERS);
    if (!w.isReady()) return;
    const engine = this.engine;
    const targets = directional ? 3 : 1;
    this.beginDraw(Constants.ALPHA_PREMULTIPLIED_PORTERDUFF, targets); // additive lights write alpha 0 (see `lights2DShaders.ts`)
    const bind = (sprite: ThinTexture) => {
      engine.enableEffect(w.drawWrapper);
      const effect = w.effect;
      effect.setMatrix("viewProjection", viewProjection);
      effect.setFloat4("l2dScreen", 1 / size[0], 1 / size[1], 1 / this.range, 0);
      for (let k = 0; k < 4; k++) if (!bindShadow(effect, `l2dShadow${k}`, k)) effect.setTexture(`l2dShadow${k}`, this.blackFallback());
      effect.setTexture("l2dSprite", sprite);
    };
    if (d.gpu.indexCount) {
      bind(this.whiteFallback());
      d.gpu.draw(w);
    }
    for (const s of d.sprites) {
      if (!s.gpu.indexCount || !s.texture.isReady()) continue;
      bind(s.texture);
      s.gpu.draw(w);
    }
    this.endDraw(targets);
  }

  private beginDraw(alphaMode: number, targets: number): void {
    const engine = this.engine;
    engine.setState(false);
    engine.depthCullingState.depthTest = false;
    engine.depthCullingState.depthMask = false;
    for (let t = 0; t < targets; t++) engine.setAlphaMode(alphaMode, true, t);
  }

  private endDraw(targets: number): void {
    const engine = this.engine;
    for (let t = 0; t < targets; t++) engine.setAlphaMode(Constants.ALPHA_DISABLE, true, t);
    engine.depthCullingState.depthTest = true;
  }

  /** A 1×1 white texture: what a lit material reads while its camera has no light textures yet. */
  whiteFallback(): RawTexture {
    return (this.white ??= RawTexture.CreateRGBATexture(WHITE_PIXEL, 1, 1, this.deps.scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE));
  }

  /** A 1×1 transparent black texture (no light, no shadow). */
  blackFallback(): RawTexture {
    return (this.black ??= RawTexture.CreateRGBATexture(BLACK_PIXEL, 1, 1, this.deps.scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE));
  }

  dispose(): void {
    this.onLayoutChange.clear();
    for (const row of this.draws) for (const d of row) {
      d.gpu.dispose();
      for (const s of d.sprites) s.gpu.dispose();
    }
    for (const s of this.shadows) s.gpu.dispose();
    for (const w of this.wrappers.values()) w.dispose();
    this.wrappers.clear();
    this.white?.dispose();
    this.black?.dispose();
    this.draws = [];
    this.shadows = [];
    if (rigs.get(this.deps.scene) === this) rigs.delete(this.deps.scene);
  }
}

function transformBox(t: readonly number[], b: readonly [number, number, number, number]): [number, number, number, number] {
  if (!Number.isFinite(b[0])) return [-Infinity, -Infinity, Infinity, Infinity];
  let out: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of [
    [b[0], b[1]],
    [b[2], b[1]],
    [b[2], b[3]],
    [b[0], b[3]],
  ] as const) {
    const wx = t[0]! * x + t[2]! * y + t[4]!, wy = t[1]! * x + t[3]! * y + t[5]!;
    out = [Math.min(out[0], wx), Math.min(out[1], wy), Math.max(out[2], wx), Math.max(out[3], wy)];
  }
  return out;
}

const overlaps = (a: readonly number[], b: readonly number[]) => a[0]! <= b[2]! && a[2]! >= b[0]! && a[1]! <= b[3]! && a[3]! >= b[1]!;

function area(p: readonly Point2[]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j]![0] * p[i]![1] - p[i]![0] * p[j]![1];
  return a;
}
