/**
 * ADR 0080 on Babylon: warm up shader pipelines by drawing meshes once, hidden, and report the shader
 * variants that get compiled anyway.
 *
 * Babylon's WebGPU engine makes a render pipeline at the first draw that needs one, keyed on the
 * effect (a material's compiled shaders for one set of defines, shared between materials with the same
 * defines and kept for the engine's life by `Effect.PersistentMode`) and the fixed state: vertex layout,
 * target formats and sample count, blend, depth and cull (`webgpuCacheRenderPipeline.js`). Compiling an
 * effect alone (`forceCompilationAsync`) doesn't make the pipeline. So each warm mesh is drawn for real,
 * in the frame graph's own passes (main, geometry, shadows when it casts them), scaled to nothing just in
 * front of the view camera: it passes culling and is drawn, but covers no pixel.
 */
import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import type { Effect } from "@babylonjs/core/Materials/effect.js";
import type { Material as BabylonMaterial } from "@babylonjs/core/Materials/material.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { meshesIfLoaded, type ModelMesh } from "../../scene/models";
import type { WarmMesh } from "../../scene/warmUp";
import { meshOf } from "./materials";

/** Warm meshes drawn per frame: each new pipeline stalls its frame, so they're spread out. */
const BATCH = 6;
/** Frames a batch waits for its materials (textures, shader imports) before it's given up. */
const MAX_FRAMES = 240;
/** Frames a warm mesh whose model is still loading is put back before it's dropped. */
const MAX_RETRIES = 600;
/** How small a warm mesh is drawn, and how far past the near plane: it covers no pixel. */
const WARM_SCALE = 1e-5;
/** Names of warm meshes start with this; the report and editor overlays skip them. */
export const WARM_PREFIX = "myco.warm:";

/** What the warmer needs from the renderer. */
export interface WarmDeps {
  scene: Scene;
  /** The shared Babylon material of a material asset (what renderers without overrides draw with), or null. */
  materialFor(path: string): BabylonMaterial | null;
  /** The material a renderer without a material asset gets for a model mesh (its own surfaces, else the default). */
  materialForSource(src: ModelMesh, mesh: Mesh): BabylonMaterial;
  /** Whether the material is a shader graph's (graph copies share the compiled program; no blend copy). */
  isGraph(material: BabylonMaterial): boolean;
  /** Whether the material opts out of fog (ADR 0071), which changes its shader. */
  fogless(material: BabylonMaterial): boolean;
  /** Whether textures are still loading: a material's texture changes its shader, so a batch waits for them. */
  loadingTextures(): boolean;
}

interface Batch {
  meshes: Mesh[];
  clones: BabylonMaterial[];
  /** Blend copies and their bases: a base's textures arrive after it's made, and the copy must follow. */
  blends: [PBRMaterial, PBRMaterial][];
  /** The batch's PBR materials and the textures they had last frame: a change means a new variant to draw. */
  watched: { material: PBRMaterial; albedo: unknown; bump: unknown }[];
  casters: Mesh[];
  frames: number;
  readyFrames: number;
}

/** @internal Queues meshes to warm and draws a batch of them each frame (ADR 0080). */
export class PipelineWarmer {
  private queue: WarmMesh[] = [];
  private batch: Batch | null = null;
  private waiters: (() => void)[] = [];
  private readonly retries = new Map<WarmMesh, number>();
  private readonly matrix = new Matrix();
  /** Called when the queue drains (the report keeps quiet for a moment after). */
  onDrained: (() => void) | null = null;

  constructor(private readonly deps: WarmDeps) {}

  /** Whether meshes are queued or being drawn. */
  get busy(): boolean {
    return this.queue.length > 0 || this.batch !== null;
  }

  /** Queue `meshes`; resolves when everything queued so far has been drawn. */
  add(meshes: readonly WarmMesh[]): Promise<void> {
    this.queue.push(...meshes);
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Before the frame graph runs: place this frame's batch in front of `camera`, its shadow casters onto `casters`. */
  beforeRender(camera: Camera | null, casters: Mesh[]): void {
    if (!this.batch && this.queue.length && camera) this.batch = this.build(camera);
    if (!this.batch) return;
    casters.push(...this.batch.casters);
    // A material asset's textures load after it's made (and after the copy was taken): keep the
    // copies in step, and count the batch as drawn only once nothing changes.
    for (const [blend, base] of this.batch.blends) {
      if (blend.albedoTexture === base.albedoTexture && blend.bumpTexture === base.bumpTexture) continue;
      blend.albedoTexture = base.albedoTexture;
      blend.bumpTexture = base.bumpTexture;
    }
    for (const w of this.batch.watched) {
      if (w.albedo === w.material.albedoTexture && w.bump === w.material.bumpTexture) continue;
      w.albedo = w.material.albedoTexture;
      w.bump = w.material.bumpTexture;
      this.batch.readyFrames = 0;
    }
  }

  /** After the frame: a batch that has drawn twice with every material ready is done. */
  afterRender(): void {
    const b = this.batch;
    if (!b) return;
    b.frames++;
    if (!this.deps.loadingTextures() && b.meshes.every((m) => m.isReady(true))) b.readyFrames++;
    if (b.readyFrames < 2 && b.frames < MAX_FRAMES) return;
    this.drop(b);
    this.batch = null;
    if (!this.queue.length) this.drained();
  }

  dispose(): void {
    if (this.batch) this.drop(this.batch);
    this.batch = null;
    this.queue = [];
    this.drained();
  }

  private drained(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
    this.onDrained?.();
  }

  private drop(b: Batch): void {
    for (const m of b.meshes) m.dispose();
    for (const c of b.clones) c.dispose();
  }

  private build(camera: Camera): Batch {
    const b: Batch = { meshes: [], clones: [], blends: [], watched: [], casters: [], frames: 0, readyFrames: 0 };
    const forward = camera.getDirection(Vector3.Forward(this.deps.scene.useRightHandedSystem));
    const at = camera.globalPosition.add(forward.scale(Math.max(camera.minZ, 0.01) * 4));
    Matrix.ComposeToRef(new Vector3(WARM_SCALE, WARM_SCALE, WARM_SCALE), Quaternion.Identity(), at, this.matrix);
    const later: WarmMesh[] = [];
    let taken = 0;
    while (this.queue.length && taken < BATCH) {
      const w = this.queue.shift()!;
      const sources = meshesIfLoaded(w.mesh);
      if (sources === null) {
        // Its model is still loading: try again later, for a while.
        const n = (this.retries.get(w) ?? 0) + 1;
        this.retries.set(w, n);
        if (n < MAX_RETRIES) later.push(w);
        continue;
      }
      this.retries.delete(w);
      taken++;
      const base = w.material ? this.deps.materialFor(w.material) : null;
      const variants: (BabylonMaterial | null)[] = [base];
      if (w.blended && base instanceof PBRMaterial && !this.deps.isGraph(base)) {
        // What a renderer fading its colour draws (`applyBuiltinOverrides`: alpha below 1 blends).
        const blend = base.clone(`${WARM_PREFIX}${base.name}:blend`);
        blend.alpha = 0.5;
        blend.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
        b.clones.push(blend);
        b.blends.push([blend, base]);
        variants.push(blend);
      }
      for (const variant of variants) {
        for (const src of sources) {
          const mesh = meshOf(this.deps.scene, `${WARM_PREFIX}${src.name}`, src);
          const material = variant ?? this.deps.materialForSource(src, mesh);
          mesh.material = material;
          if (material instanceof PBRMaterial && !b.watched.some((w) => w.material === material)) {
            b.watched.push({ material, albedo: material.albedoTexture, bump: material.bumpTexture });
          }
          mesh.receiveShadows = w.receiveShadows;
          mesh.applyFog = !this.deps.fogless(base ?? material);
          mesh.isPickable = false;
          mesh.freezeWorldMatrix(this.matrix.clone());
          b.meshes.push(mesh);
          if (w.castShadows) b.casters.push(mesh);
        }
      }
    }
    this.queue.push(...later);
    return b;
  }
}

/**
 * @internal Editor play mode (ADR 0080): logs, once each, the shader variants a mesh draws with that
 * weren't warmed up, naming the node and its prefab and what differs from a variant that was, so a
 * remaining hitch points at its fix. Quiet for a moment after a warm-up drains or the World starts,
 * while loaded content draws for the first time.
 */
export class VariantReport {
  private readonly known = new WeakSet<Effect>();
  /** A known effect's defines per material name, to say what a new variant changed. */
  private readonly byMaterial = new Map<string, string>();
  private readonly logged = new Set<string>();
  private grew = false;
  private quietUntil = 0;
  private readonly restore: () => void;

  constructor(
    engine: AbstractEngine,
    private readonly scene: Scene,
    private readonly describe: (mesh: AbstractMesh) => string | null,
  ) {
    const effects = (engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects;
    const count = () => Object.keys(effects).length;
    const create = engine.createEffect;
    engine.createEffect = ((...args: Parameters<AbstractEngine["createEffect"]>) => {
      const before = count();
      const effect = create.apply(engine, args);
      if (count() > before) this.grew = true;
      return effect;
    }) as AbstractEngine["createEffect"];
    this.restore = () => {
      engine.createEffect = create;
    };
    this.quiet();
    this.scan(true);
  }

  /** Keep quiet for a moment: content that just loaded draws for the first time. */
  quiet(ms = 1500): void {
    this.quietUntil = Math.max(this.quietUntil, performance.now() + ms);
  }

  /** After a frame: look for meshes drawing with an effect compiled since the last look. */
  afterRender(): void {
    if (!this.grew) return;
    this.grew = false;
    this.scan(performance.now() < this.quietUntil);
  }

  dispose(): void {
    this.restore();
  }

  private scan(silent: boolean): void {
    for (const mesh of this.scene.meshes) {
      const warm = mesh.name.startsWith(WARM_PREFIX);
      for (const sub of mesh.subMeshes ?? []) for (const effect of passEffects(sub)) {
        if (this.known.has(effect)) continue;
        this.known.add(effect);
        const material = sub.getMaterial()?.name.replace(WARM_PREFIX, "").replace(/:blend$/, "") ?? "(no material)";
        const prev = this.byMaterial.get(material);
        this.byMaterial.set(material, effect.defines);
        if (silent || warm) continue;
        const what = this.describe(mesh);
        if (!what) continue; // not a renderer's mesh (editor helpers, particles)
        const change = prev === undefined ? "not warmed up" : definesChange(prev, effect.defines);
        const key = `${material}|${change}`;
        if (this.logged.has(key)) continue;
        this.logged.add(key);
        console.warn(
          `[myco] ${what} drew a shader variant that wasn't warmed up (${material.replace(/^material:/, "")}: ${change}), so its frame waited for the shader to compile. ` +
            `Add its prefab to the scene's settings.preload list, or SceneManager.preload it, or report the rule the warm-up is missing (ADR 0080).`,
        );
      }
    }
  }
}

/**
 * A submesh's effects in every render pass. Babylon keeps one per pass id, and the frame graph's
 * passes have ids of their own, so `subMesh.effect` (the main pass's) is empty under it.
 */
function passEffects(sub: SubMesh): Effect[] {
  const out: Effect[] = [];
  for (const wrapper of (sub as unknown as { _drawWrappers?: ({ effect: Effect | null } | undefined)[] })._drawWrappers ?? []) if (wrapper?.effect) out.push(wrapper.effect);
  return out;
}

/** The defines `next` adds and removes against `prev`, briefly. */
function definesChange(prev: string, next: string): string {
  const lines = (s: string) => new Set(s.split("\n").map((l) => l.replace("#define ", "").trim()).filter(Boolean));
  const a = lines(prev);
  const b = lines(next);
  const added = [...b].filter((x) => !a.has(x)).slice(0, 6);
  const removed = [...a].filter((x) => !b.has(x)).slice(0, 6);
  const parts = [...added.map((x) => `+${x}`), ...removed.map((x) => `-${x}`)];
  return parts.length ? parts.join(" ") : "same defines, new state";
}
