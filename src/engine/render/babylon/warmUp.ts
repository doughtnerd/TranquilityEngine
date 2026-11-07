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
 *
 * Besides MeshRenderers' meshes it draws what the renderer builds for other content (`WarmCustom`):
 * a particle effect's draws holding one particle each, a world-space UI canvas's plane. Built-in
 * materials are also drawn with the renderer's reflection-probe copies (`probeVariants`).
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
import type { MaterialInstancing } from "../../scene/material";
import "@babylonjs/core/Meshes/instancedMesh.js"; // Mesh.createInstance
import "@babylonjs/core/Meshes/thinInstanceMesh.js"; // Mesh.thinInstance*

/** The most Babylon meshes a warm batch makes when pipelines compile as Babylon makes them: each new one stalls its frame. */
const BATCH = 6;
/** The most a batch takes when pipelines compile asynchronously (`asyncPipelines.ts`): no stall. */
const ASYNC_BATCH = 24;
/** A first batch's size; later ones follow the time their effects took (`EFFECT_BUDGET_MS`). */
const START_BATCH = 4;
/**
 * Milliseconds a batch may spend creating Babylon effects. Each new effect preprocesses Babylon's PBR
 * shader in JavaScript, about 10 ms in the pirates sample: 24 meshes at once made 220 ms frames. Batches
 * grow while their meshes share effects that already exist, and shrink when they don't.
 */
const EFFECT_BUDGET_MS = 12;
/** Frames a batch waits for its materials (textures, shader imports) before it's given up. */
const MAX_FRAMES = 240;
/** Frames a warm mesh whose model is still loading is put back before it's dropped. */
const MAX_RETRIES = 600;
/** How small a warm mesh is drawn, and how far past the near plane: it covers no pixel. */
const WARM_SCALE = 1e-5;
/** Names of warm meshes start with this; the report and editor overlays skip them. */
export const WARM_PREFIX = "myco.warm:";

/** What a custom warm item built: meshes and particle systems to draw this batch, and how to free them. */
export interface WarmParts {
  meshes: Mesh[];
  /** Babylon particle systems (anything with `render()`), drawn by the scene as usual. */
  systems: { render(): number }[];
  /** Whether everything is ready to draw (effects compiled, textures loaded). */
  ready(): boolean;
  dispose(): void;
}

/**
 * Content the renderer builds itself to warm (particle effects, world-space UI): `build` makes it
 * hidden at `at` (the warm meshes' world matrix: a point just past the camera's near plane, scaled to
 * nothing), or returns null while something it needs is still loading (it's asked again later).
 */
export interface WarmCustom {
  /** What it is, for the tier re-warm's bookkeeping and logs. */
  key: string;
  build(at: Matrix, position: Vector3, camera: Camera): WarmParts | null;
}

/** A queued warm item. */
export type WarmItem = WarmMesh | WarmCustom;

const isCustom = (w: WarmItem): w is WarmCustom => typeof (w as WarmCustom).build === "function";

/** What a warm item draws, so warming it again (another load, `rewarm`) is recognised: a custom item's key, a mesh's layout. */
const warmKey = (w: WarmItem): string => (isCustom(w) ? w.key : `mesh|${w.mesh}|${w.material}|${w.castShadows}|${w.receiveShadows}`);

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
  /**
   * How renderers drawing a material asset batch (ADR 0108): warm meshes draw the same way (instanced,
   * thin-instanced or plain), since instancing is part of the shader variant. Without it they draw plain.
   */
  instancing?(path: string | null): MaterialInstancing;
  /**
   * Extra copies of a material in the keyword combinations scripts may switch to (`"variants": "all"`,
   * ADR 0106), drawn too so those variants compile now; each with its dispose.
   */
  keywordVariants?(material: BabylonMaterial): { material: BabylonMaterial; dispose(): void }[];
  /**
   * The renderer's reflection-probe copies of a built-in material, one per captured probe (ADR 0054;
   * box projection changes the shader, ADR 0110), so meshes entering a probe's box don't compile then.
   * They're the renderer's own copies, kept: not disposed with the batch.
   */
  probeVariants?(base: PBRMaterial): PBRMaterial[];
  /** With async pipeline compiles (WebGPU): resolves once the compiles started so far finish. Without, warm draws compile (and stall) as they go. */
  compiling?(): Promise<void>;
  /** Milliseconds spent creating effects so far (`effectClock`), to size the batches; without it batches keep their largest size. */
  effectMs?(): number;
}

/** @internal A running total of the time `engine` spends in `createEffect` (shader preprocessing runs there). */
export function effectClock(engine: AbstractEngine): { ms(): number; dispose(): void } {
  let total = 0;
  const create = engine.createEffect;
  engine.createEffect = ((...args: Parameters<AbstractEngine["createEffect"]>) => {
    const t = performance.now();
    try {
      return create.apply(engine, args);
    } finally {
      total += performance.now() - t;
    }
  }) as AbstractEngine["createEffect"];
  return {
    ms: () => total,
    dispose: () => {
      if (engine.createEffect !== create) engine.createEffect = create;
    },
  };
}

/** @internal The next batch's size from the last one's: double while its effects took under half the budget, else scale to the budget. */
export function nextBatchSize(size: number, effectMs: number, max: number): number {
  if (effectMs < EFFECT_BUDGET_MS / 2) return Math.min(max, size * 2);
  return Math.max(1, Math.min(max, Math.round((size * EFFECT_BUDGET_MS) / effectMs)));
}

interface Batch {
  meshes: Mesh[];
  /** Custom items' parts (particle draws, world canvases). */
  parts: WarmParts[];
  clones: BabylonMaterial[];
  /** Keyword-variant copies (ADR 0106), disposed with the batch. */
  disposers: (() => void)[];
  /** Blend copies and their bases: a base's textures arrive after it's made, and the copy must follow. */
  blends: [PBRMaterial, PBRMaterial][];
  /** The batch's PBR materials and the textures they had last frame: a change means a new variant to draw. */
  watched: { material: PBRMaterial; albedo: unknown; bump: unknown }[];
  casters: AbstractMesh[];
  frames: number;
  readyFrames: number;
  /** `effectMs()` when the batch was built, and how many meshes it was meant to take. */
  effectStart: number;
  size: number;
}

/** @internal Queues meshes to warm and draws a batch of them each frame (ADR 0080). */
export class PipelineWarmer {
  private queue: WarmItem[] = [];
  private batch: Batch | null = null;
  private waiters: (() => void)[] = [];
  private readonly retries = new Map<WarmItem, number>();
  /** True while one of the warmer's own meshes or particle systems is drawing (`AsyncPipelines` skips only those draws). */
  drawing = false;
  private readonly matrix = new Matrix();
  /** Called when the queue drains (the report keeps quiet for a moment after). */
  onDrained: (() => void) | null = null;
  /** The next batch's size (`nextBatchSize`). */
  private size: number;

  constructor(private readonly deps: WarmDeps) {
    this.size = deps.effectMs ? START_BATCH : this.maxBatch;
  }

  private get maxBatch(): number {
    return this.deps.compiling ? ASYNC_BATCH : BATCH;
  }

  /** Whether meshes are queued or being drawn. */
  get busy(): boolean {
    return this.queue.length > 0 || this.batch !== null;
  }

  /** Everything queued so far by key (`warmKey`), to warm again when the passes change (`rewarm`). */
  private readonly history = new Map<string, WarmItem>();

  /** Queue `items` (what's already queued, by `warmKey`, isn't queued twice); resolves when everything queued so far has been drawn. */
  add(items: readonly WarmItem[]): Promise<void> {
    // A blended mesh covers the unblended one (it draws both), not the other way round.
    const covers = (w: WarmItem, had: WarmItem) => !isCustom(w) && w.blended && !(had as WarmMesh).blended;
    for (const w of items) {
      const key = warmKey(w);
      const queued = this.queue.findIndex((q) => warmKey(q) === key);
      if (queued < 0) this.queue.push(w);
      else if (covers(w, this.queue[queued]!)) this.queue[queued] = w;
      const had = this.history.get(key);
      if (!had || covers(w, had)) this.history.set(key, w);
    }
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /**
   * The passes changed (a new quality tier switched shadows, cascades or probes): warm everything warmed
   * so far again, so the new variants compile now rather than as each mesh comes into view (ADR 0080).
   */
  rewarm(): Promise<void> {
    const all = [...this.history.values()].filter((m) => !this.queue.includes(m));
    return all.length ? this.add(all) : Promise.resolve();
  }

  /** Before the frame graph runs: place this frame's batch in front of `camera`, its shadow casters onto `casters`. */
  beforeRender(camera: Camera | null, casters: AbstractMesh[]): void {
    if (!this.batch && this.queue.length && camera) {
      const b = this.build(camera);
      // Everything taken is still loading (put back): nothing to draw this frame.
      if (b.meshes.length || b.parts.length) this.batch = b;
    }
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
    if (!this.deps.loadingTextures() && b.meshes.every((m) => m.isReady(true, m.hasInstances)) && b.parts.every((p) => p.ready())) b.readyFrames++;
    if (b.readyFrames < 2 && b.frames < MAX_FRAMES) return;
    if (this.deps.effectMs) this.size = nextBatchSize(b.size, this.deps.effectMs() - b.effectStart, this.maxBatch);
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
    const finish = () => {
      for (const w of waiters) w();
      this.onDrained?.();
    };
    // With async compiles, the warm draws only started them: done once the pipelines are in the cache.
    const compiling = this.deps.compiling?.();
    if (compiling) void compiling.then(finish);
    else finish();
  }

  private drop(b: Batch): void {
    for (const m of b.meshes) m.dispose();
    for (const c of b.clones) c.dispose();
    for (const d of b.disposers) d();
    for (const p of b.parts) p.dispose();
  }

  /** Mark draws of `target` (a warm mesh's `_draw`, a particle system's `render`) as the warmer's, on the instance. */
  private own<T extends object>(target: T, method: "_draw" | "render"): void {
    const t = target as unknown as Record<string, (...args: unknown[]) => unknown>;
    const original = t[method];
    if (typeof original !== "function") return;
    t[method] = (...args: unknown[]) => {
      const was = this.drawing;
      this.drawing = true;
      try {
        return original.apply(target, args);
      } finally {
        this.drawing = was;
      }
    };
  }

  private build(camera: Camera): Batch {
    const b: Batch = { meshes: [], parts: [], clones: [], disposers: [], blends: [], watched: [], casters: [], frames: 0, readyFrames: 0, effectStart: this.deps.effectMs?.() ?? 0, size: this.size };
    const forward = camera.getDirection(Vector3.Forward(this.deps.scene.useRightHandedSystem));
    const at = camera.globalPosition.add(forward.scale(Math.max(camera.minZ, 0.01) * 4));
    Matrix.ComposeToRef(new Vector3(WARM_SCALE, WARM_SCALE, WARM_SCALE), Quaternion.Identity(), at, this.matrix);
    const later: WarmItem[] = [];
    let taken = 0;
    while (this.queue.length && taken < b.size) {
      const w = this.queue.shift()!;
      const retry = () => {
        // Something it needs is still loading: try again later, for a while.
        const n = (this.retries.get(w) ?? 0) + 1;
        this.retries.set(w, n);
        if (n < MAX_RETRIES) later.push(w);
      };
      if (isCustom(w)) {
        const parts = w.build(this.matrix.clone(), at.clone(), camera);
        if (!parts) {
          retry();
          continue;
        }
        this.retries.delete(w);
        for (const m of parts.meshes) this.own(m, "_draw");
        for (const ps of parts.systems) this.own(ps, "render");
        b.parts.push(parts);
        taken += Math.max(1, parts.meshes.length + parts.systems.length);
        continue;
      }
      const sources = meshesIfLoaded(w.mesh);
      if (sources === null) {
        retry();
        continue;
      }
      this.retries.delete(w);
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
      if (base && this.deps.keywordVariants) {
        for (const v of this.deps.keywordVariants(base)) {
          variants.push(v.material);
          b.disposers.push(v.dispose);
        }
      }
      if (base instanceof PBRMaterial && !this.deps.isGraph(base)) variants.push(...(this.deps.probeVariants?.(base) ?? []));
      const mode = this.deps.instancing ? this.deps.instancing(w.material || null) : "off";
      // Counted in Babylon meshes: a model of many parts, or a blend copy, is several draws and effects.
      taken += variants.length * sources.length;
      const place = (mesh: Mesh, material: BabylonMaterial) => {
        mesh.material = material;
        if (material instanceof PBRMaterial && !b.watched.some((x) => x.material === material)) {
          b.watched.push({ material, albedo: material.albedoTexture, bump: material.bumpTexture });
        }
        mesh.receiveShadows = w.receiveShadows;
        mesh.applyFog = !this.deps.fogless(base ?? material);
        mesh.isPickable = false;
        // Instances and thin instances draw through their source's `_draw` too.
        this.own(mesh, "_draw");
        b.meshes.push(mesh);
        // Drawn as the scene draws it (ADR 0108): an instance of a hidden source, a thin instance, or plain.
        if (mode === "auto") {
          mesh.isVisible = false;
          const instance = mesh.createInstance(`${mesh.name}:instance`);
          instance.isPickable = false;
          instance.freezeWorldMatrix(this.matrix.clone());
          if (w.castShadows) b.casters.push(instance);
        } else if (mode === "thin") {
          mesh.freezeWorldMatrix(Matrix.Identity());
          mesh.thinInstanceSetBuffer("matrix", this.matrix.toArray() as Float32Array, 16, true);
          if (w.castShadows) b.casters.push(mesh);
        } else {
          mesh.freezeWorldMatrix(this.matrix.clone());
          if (w.castShadows) b.casters.push(mesh);
        }
      };
      for (const variant of variants) {
        for (const src of sources) {
          const mesh = meshOf(this.deps.scene, `${WARM_PREFIX}${src.name}`, src);
          const material = variant ?? this.deps.materialForSource(src, mesh);
          place(mesh, material);
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
    /**
     * The node a mesh or particle system draws for (and the prefab it came from), or null for what
     * isn't content (editor helpers). Given a renderer's mesh, a particle draw's mesh or Babylon
     * particle system, or a world canvas's plane.
     */
    private readonly describe: (drawn: AbstractMesh | ParticleSystemLike) => { what: string; prefab?: string } | null,
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
      for (const sub of mesh.subMeshes ?? []) {
        const material = sub.getMaterial()?.name.replaceAll(WARM_PREFIX, "").replace(/:blend(?=:probe$|$)/, "") ?? "(no material)";
        for (const effect of passEffects(sub)) this.check(effect, material, mesh, silent);
      }
    }
    // Babylon particle systems (particle effects' billboards): one effect per pass and blend mode.
    for (const ps of this.scene.particleSystems as unknown as ParticleSystemLike[]) {
      for (const pass of ps._drawWrappers ?? []) for (const wrapper of pass ?? []) if (wrapper?.effect) this.check(wrapper.effect, "(particle system)", ps, silent);
    }
  }

  private check(effect: Effect, material: string, drawn: AbstractMesh | ParticleSystemLike, silent: boolean): void {
    if (this.known.has(effect)) return;
    this.known.add(effect);
    const prev = this.byMaterial.get(material);
    this.byMaterial.set(material, effect.defines);
    if (silent || drawn.name.startsWith(WARM_PREFIX)) return;
    const described = this.describe(drawn);
    if (!described) return; // not content (editor helpers)
    const change = prev === undefined ? "not warmed up" : definesChange(prev, effect.defines);
    const key = `${material}|${change}`;
    if (this.logged.has(key)) return;
    this.logged.add(key);
    console.warn(variantWarning(described.what, material, change, described.prefab));
  }
}

/**
 * @internal The variant report's warning. It names the file to add to the scene's `settings.preload`
 * when there is one (the prefab the node came from, else the material asset), in a fixed phrase the
 * editor's message log finds (`preloadSuggestion`) to offer adding it.
 */
export function variantWarning(what: string, material: string, change: string, prefab?: string): string {
  const name = material.replace(/^material:/, "");
  const asset = prefab ?? (/^(?:asset:)?([^#]+\.material\.json)/.exec(name)?.[1] ?? null);
  const fix = asset ? `Add ${asset.replace(/^asset:/, "")} to the scene's settings.preload list` : "Add its prefab to the scene's settings.preload list";
  return `[myco] ${what} drew a shader variant that wasn't warmed up (${name}: ${change}), so its frame waited for the shader to compile. ${fix}, or SceneManager.preload it, or report the rule the warm-up is missing (ADR 0080).`;
}

/** A Babylon particle system as the report reads it: its effects per render pass and blend mode. */
export interface ParticleSystemLike {
  name: string;
  _drawWrappers?: ({ effect: Effect | null } | undefined)[][];
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
