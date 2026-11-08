/**
 * @internal Babylon's material library (ADR 0127): one per Babylon scene, it builds and caches the Babylon
 * materials and textures that `materialResolution.ts` describes, and is the only place that does. The
 * World renderer, the warm-up, particles, tilemaps, UI and the editor's previews (on their own scenes)
 * all ask it: the material for a path or for a MeshRenderer's slots, a texture for a path and use, the
 * variants warm-up draws, and whether anything is still loading.
 *
 * What it builds: material assets as PBR materials (ADR 0043, 0052), shader graphs and shader assets as
 * graph materials (ADR 0047, 0106), script Material copies (ADR 0107), per-renderer override copies
 * (ADR 0049), reflection-probe copies (ADR 0054, 0110), shared slot multi-materials (ADR 0089), unshared
 * copies for particles (ADR 0126), and textures sampled by their import settings (ADR 0040). The policy
 * (which material, which values, when a build is stale) is the neutral module's; this is the adapter.
 */
import { Material as BabylonMaterial } from "@babylonjs/core/Materials/material.js";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { Assets } from "../../scene/Assets";
import type { MaterialInstancing, MaterialSettings } from "../../scene/material";
import { materialSlots, type MaterialSlot, type ModelMesh } from "../../scene/models";
import type { GraphValue } from "../../scene/shaderGraph";
import { isRenderTexturePath } from "../renderTexture";
import { Graphics } from "../Graphics";
import { Material as EngineMaterial } from "../Material";
import type { MeshRenderer } from "../components";
import {
  graphValues,
  instancingFor,
  isStampCurrent,
  overrideWarnings,
  pickSlot,
  readAsset,
  resolveMaterial,
  samplingOf,
  samplingSource,
  scriptValues,
  sharedAction,
  slotSources,
  textureLoad,
  textureValue,
  warmVariantKeywords,
  type AssetRead,
  type MaterialWarning,
  type ResolvedMaterial,
  type Sampling,
  type SlotRequest,
  type TextureUse,
} from "../materialResolution";
import { createGraphMaterial, type BabylonGraphMaterial, type GraphShared } from "./graphMaterial";
import { applyBuiltinOverrides, applyBuiltinSettings, builtinTextureSlots, modelBaseMaterial, modelSubMeshes, pbr, tiledTexture } from "./materials";
import { MycoProbeBlendPlugin } from "./probeBlend";
import type { ProbeHit } from "./probes";
import { WARM_PREFIX } from "./warmUp";

/** An unshared material and how to free it. */
export interface OwnedMaterial {
  material: BabylonMaterial;
  dispose(): void;
}

export interface MaterialLibraryOptions {
  /** Time, drawing-buffer size and main light for graph materials; the owner updates it each frame. */
  shared?: GraphShared;
  /** A render texture asset's texture (ADR 0109), or null; without it render texture paths fail to load. */
  renderTexture?(path: string): Texture | null;
  /** Whether editor picking is on (thin batches then draw as instances, ADR 0108). */
  editorPicking?(): boolean;
  /** Shows a warning once per key; default `console.warn` once per library. */
  warn?(key: string, message: string): void;
  /** Reads project files; default `Assets`. */
  read?: AssetRead;
  /** Whether assets' shared script Materials apply (ADR 0107); default true. The editor's previews show assets as saved. */
  scriptMaterials?: boolean;
}

/** What a MeshRenderer's model meshes draw with this sync. */
export interface MeshMaterials {
  /** The renderer-wide material (slot 0's script instance or `material`, with overrides), or null. */
  material: BabylonMaterial | null;
  /** What a model mesh draws: one material, or a multi-material shared by renderers with the same slots (ADR 0089, 0108). */
  of(src: ModelMesh): BabylonMaterial;
}

interface AssetEntry {
  resolved: ResolvedMaterial;
  material: BabylonMaterial | null;
  graph?: BabylonGraphMaterial;
  /** Tiled texture copies it owns. */
  owned: Texture[];
  /** A shared Material's texture value was taken back: rebuild next time (ADR 0107). */
  rebuild?: boolean;
}

/** A script Material instance's own Babylon material (ADR 0107). */
interface InstanceEntry {
  base: BabylonMaterial;
  material: BabylonMaterial;
  graph?: BabylonGraphMaterial;
  version: number;
  seen: boolean;
}

/** A renderer's own material holding its property overrides (ADR 0049). */
interface RendererEntry {
  base: BabylonMaterial;
  material: BabylonMaterial;
  graph?: BabylonGraphMaterial;
  version: number;
  /** The base's stamp when the overrides were applied: script values changed it since. */
  stamp: number;
}

/** Babylon's sampling mode for a sampling. */
function samplingMode(s: Sampling): number {
  if (s.mipmaps === "none") return s.filter === "nearest" ? Texture.NEAREST_SAMPLINGMODE : Texture.BILINEAR_SAMPLINGMODE;
  return s.mipmaps === "nearest" ? Texture.NEAREST_NEAREST_MIPNEAREST : Texture.TRILINEAR_SAMPLINGMODE;
}

const WRAP = { clamp: Texture.CLAMP_ADDRESSMODE, repeat: Texture.WRAP_ADDRESSMODE, mirror: Texture.MIRROR_ADDRESSMODE } as const;

/** @internal Builds and caches a Babylon scene's materials and textures (ADR 0127). */
export class BabylonMaterialLibrary {
  private defaultMade: PBRMaterial | null = null;
  private readonly shared: GraphShared;
  private readonly read: AssetRead;
  private readonly warned = new Set<string>();
  private readonly assets = new Map<string, AssetEntry>();
  /** Graph materials by their Babylon material, for copies sharing the compiled program. */
  private readonly graphs = new WeakMap<BabylonMaterial, BabylonGraphMaterial>();
  private readonly noFog = new WeakSet<BabylonMaterial>();
  private readonly sharedApplied = new WeakMap<BabylonMaterial, number>();
  /** Bumped when script values change a material in place, so renderer copies follow. */
  private readonly stamps = new WeakMap<BabylonMaterial, number>();
  private readonly instances = new Map<EngineMaterial, InstanceEntry>();
  private readonly renderers = new Map<MeshRenderer, RendererEntry>();
  /** The image each built-in copy's `texture` value asks for (null: the base's). */
  private readonly wantedTextures = new WeakMap<PBRMaterial, string | null>();
  private readonly modelMaterials = new WeakMap<object, BabylonMaterial>();
  private readonly slotMultis = new WeakMap<object, Map<string, MultiMaterial>>();
  private readonly probeCopies = new WeakMap<BabylonMaterial, Map<string, PBRMaterial>>();
  private readonly textures = new Map<string, Texture>();
  private readonly pending = new Map<string, Promise<Texture>>();
  /** The sidecar each texture was sampled from, so a rewritten one is applied again. */
  private readonly sampledFrom = new Map<string, object | undefined>();
  /** Render textures handed out: not ours to dispose. */
  private readonly borrowed = new Set<Texture>();

  constructor(
    readonly scene: Scene,
    private readonly opts: MaterialLibraryOptions = {},
  ) {
    this.shared = opts.shared ?? { time: 0, resolution: [1, 1] };
    this.read = opts.read ?? readAsset;
  }

  /** What meshes without a material draw: white, lit, half rough (made on first use). */
  get defaultMaterial(): PBRMaterial {
    if (!this.defaultMade) {
      const m = (this.defaultMade = pbr("myco.default", this.scene));
      m.albedoColor = new Color3(1, 1, 1);
      m.metallic = 0;
      m.roughness = 0.5;
    }
    return this.defaultMade;
  }

  // --- Materials ------------------------------------------------------------------------------------

  /**
   * The Babylon material for a material asset (or a shader graph or shader asset named directly), or
   * null (empty, missing, or not a material: warned once). Shared by everything drawing it, with the
   * asset's shared script Material applied in place; rebuilt when it goes stale.
   */
  material(path: string): BabylonMaterial | null {
    const m = this.asset(path);
    const shared = m && path && this.opts.scriptMaterials !== false ? EngineMaterial._sharedIfAny(path) : undefined;
    if (m && shared) this.applyShared(path, m, shared);
    return m;
  }

  /**
   * What each of a MeshRenderer's model meshes draws (ADR 0089, 0107, 0049): a slot with its own
   * `materials[i]` draws it (its script Material's copy, or the asset with shared values); the others draw
   * the renderer-wide material (slot 0's script instance when slot 0 has no entry of its own, with
   * overrides), then the model's import settings, then the model's own material.
   */
  meshMaterials(r: MeshRenderer, slots: readonly MaterialSlot[], variant?: string): MeshMaterials {
    const slot0 = r.materials[0] ? null : r._drawMaterial(0);
    const material = this.rendererMaterial(r, slot0?.isInstance ? this.instanceMaterial(slot0) : this.material(r.material));
    const pick = this.slotPicker(r, slots, (slot) => this.slotMaterial(r, slot), material);
    return { material, of: (src) => modelBaseMaterial(this.scene, this.modelMaterials, src, pick, this.slotMultis, variant) ?? this.defaultMaterial };
  }

  /**
   * What a warm-up mesh's model meshes draw (ADR 0080): slots resolved as {@link meshMaterials} resolves
   * a renderer's, from material assets only (script instances come later), sharing its multi-materials.
   */
  slotMaterials(w: SlotRequest, sources: readonly ModelMesh[]): (src: ModelMesh, mesh: Mesh) => BabylonMaterial {
    const material = w.material ? this.material(w.material) : null;
    const pick = this.slotPicker(w, materialSlots(sources), (slot) => this.material(w.materials![slot]!), material);
    return (src, mesh) => {
      const m = modelBaseMaterial(this.scene, this.modelMaterials, src, pick, this.slotMultis) ?? this.defaultMaterial;
      if (m instanceof MultiMaterial) modelSubMeshes(src, mesh);
      return m;
    };
  }

  /** Start a sync of a World's renderers: script instances not drawn by its end are freed ({@link endSync}). */
  beginSync(): void {
    for (const e of this.instances.values()) e.seen = false;
  }

  /** Free the script Material instances no renderer drew since {@link beginSync}. */
  endSync(): void {
    for (const [m, e] of this.instances) if (!e.seen) this.disposeInstance(m);
  }

  /** A renderer went: free its override copy. */
  release(r: MeshRenderer): void {
    const e = this.renderers.get(r);
    if (!e) return;
    if (e.graph) e.graph.dispose();
    else if (e.material !== e.base) e.material.dispose();
    this.renderers.delete(r);
  }

  /**
   * A copy of a built-in material reflecting a probe's map (ADR 0054), one per material, probe and blend
   * (a neighbour's map and the primary's share, ADR 0110), kept for reuse.
   */
  probeCopy(base: PBRMaterial, hit: ProbeHit): PBRMaterial {
    let byProbe = this.probeCopies.get(base);
    if (!byProbe) this.probeCopies.set(base, (byProbe = new Map()));
    const b = hit.blend;
    const key = b ? `${hit.texture.uniqueId}|${b.texture.uniqueId}|${b.weight}` : `${hit.texture.uniqueId}`;
    let m = byProbe.get(key);
    if (!m) {
      m = base.clone(`${base.name}:probe`);
      m.reflectionTexture = hit.texture;
      if (b) new MycoProbeBlendPlugin(m, { texture: b.texture, weight: b.weight, intensityRatio: 1, box: null });
      byProbe.set(key, m);
      if (this.noFog.has(base)) this.noFog.add(m);
    }
    m.environmentIntensity = hit.intensity;
    if (b) {
      const plugin = m.pluginManager?.getPlugin<MycoProbeBlendPlugin>("MycoProbeBlend");
      if (plugin) {
        plugin.state.intensityRatio = hit.intensity > 0 ? b.intensity / hit.intensity : 0;
        plugin.state.box = b.box;
      }
    }
    return m;
  }

  /**
   * An unshared copy of a material asset, freed by the caller (particles that change it, ADR 0126): a
   * graph's is a new graph material with the asset's properties and keywords (Babylon can't clone graph
   * plugins), others a clone. Null when the asset isn't there.
   */
  copy(path: string, name: string): OwnedMaterial | null {
    const base = this.material(path);
    if (!base) return null;
    const g = this.graphs.get(base);
    if (g) {
      const made = this.graphCopy(g, name);
      return { material: made.material, dispose: () => made.dispose() };
    }
    const copy = base.clone(name);
    return copy ? { material: copy, dispose: () => copy.dispose(false, false) } : null;
  }

  /** Whether a material is a shader graph's or shader asset's (no probe or blend copies). */
  isGraph(m: BabylonMaterial): boolean {
    return this.graphs.has(m);
  }

  /** Whether a material opts out of the World's fog (ADR 0071), which changes its shader. */
  fogless(m: BabylonMaterial): boolean {
    return this.noFog.has(m);
  }

  /** How renderers drawing a material asset batch (ADR 0108). */
  instancing(path: string | null): MaterialInstancing {
    return instancingFor(path ? this.assets.get(path)?.resolved.instancing : undefined, this.opts.editorPicking?.() ?? false);
  }

  /**
   * The copies warm-up draws a material in beyond its own (ADR 0106): a graph's `"variants": "all"`
   * keyword combinations, sharing its compiled program, so a script's keyword switch finds its variant
   * compiled. Freed by the caller.
   */
  warmVariants(m: BabylonMaterial): OwnedMaterial[] {
    const g = this.graphs.get(m);
    if (!g) return [];
    const { variants, warning } = warmVariantKeywords(g.compiled, g.keywords, m.name);
    if (warning) this.warn(warning);
    return variants.map((kw) => {
      const copy = createGraphMaterial(this.scene, `${WARM_PREFIX}${m.name}:variant`, g.compiled, { ...g.properties }, this.shared, this.loadGraphTexture);
      copy.setKeywords(kw);
      if (this.noFog.has(m)) this.noFog.add(copy.material);
      return { material: copy.material, dispose: () => copy.dispose() };
    });
  }

  // --- Textures -------------------------------------------------------------------------------------

  /** A texture asset for a use (see {@link TextureUse}), loaded once per path and use. Rejects if it can't be read (a later call tries again). */
  texture(path: string, use: TextureUse = "color"): Promise<Texture> {
    const load = textureLoad(path, use);
    const have = this.textures.get(load.key);
    if (have) return Promise.resolve(have);
    let p = this.pending.get(load.key);
    if (p) return p;
    if (isRenderTexturePath(path)) {
      // A render texture asset (ADR 0109): the texture a camera draws into, shared by everything naming it.
      const rt = this.opts.renderTexture?.(path) ?? null;
      if (!rt) return Promise.reject(new Error(`render texture "${path}" isn't in the project`));
      this.borrowed.add(rt);
      this.textures.set(load.key, rt);
      this.sampledFrom.set(load.key, samplingSource(path)); // sampled from the asset's own settings, not a sidecar
      return Promise.resolve(rt);
    }
    // Resolved before the promise exists: a missing asset must not leave an entry in `pending` (the executor
    // runs before `pending.set`, so deleting there did nothing, and `settled()` then spun forever).
    let url: string;
    try {
      url = Assets.url(path);
    } catch (err) {
      return Promise.reject(err);
    }
    p = new Promise<Texture>((resolve, reject) => {
      const sampling = samplingOf(Assets.importSettings(path));
      const tex: Texture = new Texture(url, this.scene, {
        noMipmap: sampling.mipmaps === "none",
        invertY: load.flipY,
        samplingMode: samplingMode(sampling),
        ...(load.decode !== "shader" ? { useSRGBBuffer: load.decode === "srgb", gammaSpace: false } : {}),
        onLoad: () => {
          this.sample(load.key, path, tex);
          this.textures.set(load.key, tex);
          this.pending.delete(load.key);
          resolve(tex);
        },
        onError: (message) => {
          this.pending.delete(load.key);
          tex.dispose();
          reject(new Error(message ?? `couldn't load ${path}`));
        },
      });
    });
    this.pending.set(load.key, p);
    return p;
  }

  /**
   * A texture already loaded for a use, sampled again if its import settings changed since (the editor's
   * import settings), or null (none yet: call {@link texture} to load it).
   */
  loadedTexture(path: string, use: TextureUse = "color"): Texture | null {
    const key = textureLoad(path, use).key;
    const t = this.textures.get(key) ?? null;
    if (t && !this.borrowed.has(t) && this.sampledFrom.get(key) !== samplingSource(path)) this.sample(key, path, t);
    return t;
  }

  /** Whether textures are still loading (a material's texture changes its shader; a held first frame waits). */
  loading(): boolean {
    return this.pending.size > 0;
  }

  /** Resolves once nothing is loading (previews draw then); failed loads count as done. */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending.values()]);
    await Promise.resolve(); // the slots are set as their promises settle: give them a turn
  }

  /** Free everything it built (its scene's other materials and textures are left alone). */
  dispose(): void {
    for (const r of [...this.renderers.keys()]) this.release(r);
    for (const m of [...this.instances.keys()]) this.disposeInstance(m);
    for (const e of this.assets.values()) this.disposeAsset(e);
    this.assets.clear();
    for (const t of this.textures.values()) if (!this.borrowed.has(t)) t.dispose();
    this.textures.clear();
    this.defaultMade?.dispose();
    this.defaultMade = null;
  }

  // --- Internals ------------------------------------------------------------------------------------

  private warn(w: MaterialWarning): void {
    if (this.opts.warn) return this.opts.warn(w.key, w.message);
    if (this.warned.has(w.key)) return;
    this.warned.add(w.key);
    console.warn(`[myco] ${w.message}`);
  }

  private readonly loadGraphTexture = (p: string, linear: boolean) => this.texture(p, linear ? "graphData" : "graphColor");

  /** Filtering and wrapping from the image's import settings (ADR 0040). */
  private sample(key: string, path: string, tex: Texture): void {
    this.sampledFrom.set(key, samplingSource(path));
    const s = samplingOf(Assets.importSettings(path));
    tex.updateSamplingMode(samplingMode(s));
    tex.wrapU = tex.wrapV = WRAP[s.wrap];
  }

  /** A slot picker for `modelBaseMaterial`: each slot's sources in order, then null (the model's own). */
  private slotPicker(req: SlotRequest, slots: readonly MaterialSlot[], own: (slot: number) => BabylonMaterial | null, renderer: BabylonMaterial | null) {
    const sources = slotSources(req, slots.map((s) => s.surface.name));
    const bySurface = new Map(slots.map((slot, i) => [slot.surface, pickSlot(sources[i], (s) => (s.from === "slot" ? own(s.slot) : s.from === "renderer" ? renderer : this.material(s.path)))]));
    return (surface: MaterialSlot["surface"]) => bySurface.get(surface) ?? null;
  }

  /** What a renderer's slot draws: its script Material instance's copy, or its asset's (with shared values). */
  private slotMaterial(r: MeshRenderer, slot: number): BabylonMaterial | null {
    const m = r._drawMaterial(slot);
    if (m?.isInstance) return this.instanceMaterial(m);
    return this.material(r.materials[slot] || r.material);
  }

  /** A material asset's build, without the shared Material: rebuilt when stale. */
  private asset(path: string): BabylonMaterial | null {
    if (!path) return null;
    const level = Graphics.tier.shaderLevel;
    const cached = this.assets.get(path);
    if (cached && !cached.rebuild && isStampCurrent(cached.resolved.stamp, path, level, this.read)) return cached.material;
    if (cached) this.disposeAsset(cached);
    const resolved = resolveMaterial(path, { shaderLevel: level, target: this.scene.getEngine().isWebGPU ? "wgsl" : "glsl", read: this.read });
    for (const w of resolved.warnings) this.warn(w);
    const entry: AssetEntry = { resolved, material: null, owned: [] };
    this.assets.set(path, entry);
    if (resolved.kind === "graph") {
      const graph = createGraphMaterial(this.scene, `graph:${resolved.graph!.replace(/^asset:/, "")}`, resolved.compiled!, resolved.properties, this.shared, this.loadGraphTexture);
      graph.setKeywords(resolved.keywords);
      this.graphs.set(graph.material, graph);
      entry.graph = graph;
      entry.material = graph.material;
    } else if (resolved.kind === "builtin") {
      entry.material = this.builtin(path, resolved.settings!, entry);
    }
    if (entry.material && !resolved.fog) this.noFog.add(entry.material);
    return entry.material;
  }

  private disposeAsset(e: AssetEntry): void {
    if (e.graph) e.graph.dispose();
    else e.material?.dispose();
    for (const t of e.owned) t.dispose();
  }

  /** A lit, unlit or physical material asset (ADR 0043, 0052) as a PBR material; its textures arrive as they load. */
  private builtin(path: string, settings: MaterialSettings, entry: AssetEntry): PBRMaterial {
    const m = pbr(`material:${path}`, this.scene);
    applyBuiltinSettings(m, settings);
    for (const slot of builtinTextureSlots(m, settings)) {
      const image = slot.image.replace(/^asset:/, "");
      if (!image) continue;
      this.texture(image)
        .then((shared) => {
          if (this.assets.get(path) !== entry) return; // replaced meanwhile
          const { texture, owned } = tiledTexture(shared, settings.tiling);
          if (owned) entry.owned.push(texture);
          slot.apply(texture);
        })
        .catch((err) => console.error(`[myco] failed to load texture "${image}" for ${path}:`, err));
    }
    return m;
  }

  private graphCopy(g: BabylonGraphMaterial, name: string, properties: Record<string, GraphValue> = g.properties): BabylonGraphMaterial {
    const made = createGraphMaterial(this.scene, name, g.compiled, { ...properties }, this.shared, this.loadGraphTexture);
    made.setKeywords(g.keywords); // a variant of the base's (ADR 0106)
    return made;
  }

  private bump(m: BabylonMaterial): void {
    this.stamps.set(m, (this.stamps.get(m) ?? 0) + 1);
  }

  /** A script Material's values and keywords on a material built from `path` ("" the default), in place (ADR 0107). */
  private applyValues(path: string, target: BabylonMaterial, m: EngineMaterial, graph: BabylonGraphMaterial | undefined): void {
    const resolved = path ? (this.assets.get(path)?.resolved ?? null) : null;
    const v = scriptValues(resolved, m);
    for (const w of v.warnings) this.warn(w);
    if (graph) {
      graph.setProperties(v.properties);
      graph.setKeywords(v.keywords);
    } else if (target instanceof PBRMaterial && v.settings) {
      target.alpha = 1; // applyBuiltinSettings only sets these for see-through colours
      target.transparencyMode = null;
      applyBuiltinSettings(target, v.settings);
      applyBuiltinOverrides(target, target, v.values);
      if (typeof v.values.texture === "string") this.overrideTexture(target, target, v.values);
    }
    this.bump(target);
  }

  /** The asset's shared Material on its material, when its version changed. */
  private applyShared(path: string, material: BabylonMaterial, shared: EngineMaterial): void {
    const applied = this.sharedApplied.get(material);
    const action = sharedAction(applied, shared, material instanceof PBRMaterial && !!this.wantedTextures.get(material));
    if (action === "none") return;
    this.sharedApplied.set(material, shared._version);
    const entry = this.assets.get(path);
    if (action === "rebuild" && entry) entry.rebuild = true; // its own texture loads onto a new build
    else this.applyValues(path, material, shared, this.graphs.get(material));
  }

  /** A script Material instance's own material: a copy of its asset's (a graph copy shares the compiled program). */
  private instanceMaterial(m: EngineMaterial): BabylonMaterial | null {
    const asset = m.asset ? this.asset(m.asset) : this.defaultMaterial;
    if (!asset) return null;
    let e = this.instances.get(m);
    if (e && e.base !== asset) {
      this.disposeInstance(m);
      e = undefined;
    }
    if (!e) {
      const g = this.graphs.get(asset);
      if (g) {
        const made = this.graphCopy(g, `${asset.name}:instance`);
        this.graphs.set(made.material, made);
        e = { base: asset, material: made.material, graph: made, version: -1, seen: true };
      } else if (asset instanceof PBRMaterial) {
        e = { base: asset, material: asset.clone(`${asset.name}:instance`), version: -1, seen: true };
      } else e = { base: asset, material: asset, version: m._version, seen: true };
      if (this.noFog.has(asset)) this.noFog.add(e.material);
      this.instances.set(m, e);
    }
    e.seen = true;
    if (e.version !== m._version) {
      e.version = m._version;
      if (e.material !== e.base) this.applyValues(m.asset, e.material, m, e.graph);
    }
    // A copy taken before its asset's textures loaded follows them, unless it sets its own.
    if (e.material instanceof PBRMaterial && e.base instanceof PBRMaterial && !this.wantedTextures.get(e.material)) {
      if (e.material.albedoTexture !== e.base.albedoTexture) e.material.albedoTexture = e.base.albedoTexture;
      if (e.material.bumpTexture !== e.base.bumpTexture) e.material.bumpTexture = e.base.bumpTexture;
    }
    return e.material;
  }

  private disposeInstance(m: EngineMaterial): void {
    const e = this.instances.get(m);
    if (!e) return;
    if (e.graph) e.graph.dispose();
    else if (e.material !== e.base) e.material.dispose();
    this.instances.delete(m);
  }

  /**
   * What a renderer draws instead of `base` (ADR 0049): `base` without property overrides, else its own
   * copy with them applied, updated in place (a graph copy shares the compiled program).
   */
  private rendererMaterial(r: MeshRenderer, base: BabylonMaterial | null): BabylonMaterial | null {
    const overrides = r._materialProperties;
    let entry = this.renderers.get(r);
    if (!base || overrides.size === 0) {
      if (entry) this.release(r);
      return base;
    }
    if (entry && entry.base !== base) {
      this.release(r);
      entry = undefined;
    }
    const stamp = this.stamps.get(base) ?? 0;
    if (entry && entry.version === r._materialPropertiesVersion && entry.stamp === stamp) {
      // A copy taken before its base's textures loaded (they arrive after the material is made) follows them.
      const m = entry.material;
      if (m !== base && m instanceof PBRMaterial && base instanceof PBRMaterial) {
        if (this.wantedTextures.get(m) === null && m.albedoTexture !== base.albedoTexture) m.albedoTexture = base.albedoTexture;
        if (m.bumpTexture !== base.bumpTexture) m.bumpTexture = base.bumpTexture;
      }
      return m; // unchanged
    }
    const values = graphValues(overrides);
    const baseGraph = this.graphs.get(base);
    if (!entry) {
      if (baseGraph) {
        const g = this.graphCopy(baseGraph, `${base.name}:${r.node.name}`, { ...baseGraph.properties, ...values });
        entry = { base, material: g.material, graph: g, version: r._materialPropertiesVersion, stamp };
      } else {
        entry = { base, material: base, version: -1, stamp };
      }
      this.renderers.set(r, entry);
      for (const w of overrideWarnings(r.material, r.node.name, overrides.keys(), baseGraph?.compiled ?? null)) this.warn(w);
    }
    if (entry.version !== r._materialPropertiesVersion || entry.stamp !== stamp) {
      entry.version = r._materialPropertiesVersion;
      entry.stamp = stamp;
      if (entry.graph && baseGraph) {
        entry.graph.setProperties({ ...baseGraph.properties, ...values });
        entry.graph.setKeywords(baseGraph.keywords);
      } else if (base instanceof PBRMaterial) {
        // One copy per renderer, updated in place: a new copy per change rebuilt the renderer's meshes
        // and compiled its shaders again (a splash fading its colour every frame did both).
        if (entry.material === base) entry.material = base.clone(`${base.name}:${r.node.name}`);
        const m = entry.material as PBRMaterial;
        applyBuiltinOverrides(m, base, values);
        this.overrideTexture(m, base, values);
      }
    }
    return entry.material;
  }

  /** A `texture` value on a copy of a built-in material (ADR 0049, 0107); the base's texture without one. */
  private overrideTexture(m: PBRMaterial, base: PBRMaterial, values: Record<string, GraphValue>): void {
    const image = textureValue(values);
    this.wantedTextures.set(m, image);
    if (image === null) m.albedoTexture = base.albedoTexture;
    else if (!image) m.albedoTexture = null;
    else
      this.texture(image)
        .then((tex) => {
          // Still wanting this image, and not disposed meanwhile.
          if (this.wantedTextures.get(m) === image && this.scene.materials.includes(m)) m.albedoTexture = tex;
        })
        .catch((err) => console.error(`[myco] failed to load texture "${image}":`, err));
  }
}

