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
import { DEFAULT_SLOT, materialSlots, type MaterialSlot, type ModelMesh } from "../../scene/models";
import type { GraphValue } from "../../scene/shaderGraph";
import type { KeywordValue } from "../../scene/shaderKeywords";
import type { CompiledShaderGraph } from "../shaderGraph/compile";
import { isRenderTexturePath } from "../renderTexture";
import { Graphics } from "../Graphics";
import { Material as EngineMaterial } from "../Material";
import type { MaterialPropertyValue, MeshRenderer } from "../components";
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
  type MaterialStamp,
  type MaterialWarning,
  type ResolvedMaterial,
  type Sampling,
  type SlotRequest,
  type TextureUse,
} from "../materialResolution";
import { createGraphMaterial, type BabylonGraphMaterial, type GraphShared } from "./graphMaterial";
import { applyBuiltinOverrides, applyBuiltinSettings, applySlotOverrides, builtinTextureSlots, hasLiveTextureTransform, modelBaseMaterial, modelSubMeshes, pbr, tiledTexture, type SlotAdjust } from "./materials";
import { cloneMaterial, onOwnerDisposed } from "./materialClone";
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
  /** The texture paths it loaded (no `asset:`): a render texture among them replaced means a rebuild (ADR 0109). */
  uses: Set<string>;
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

/** One overridden material slot's own copy of the material it draws (ADR 0371, T24). */
interface SlotEntry {
  base: BabylonMaterial;
  material: BabylonMaterial;
  graph?: BabylonGraphMaterial;
  version: number;
  stamp: number;
}

/** Babylon's sampling mode for a sampling. */
function samplingMode(s: Sampling): number {
  if (s.mipmaps === "none") return s.filter === "nearest" ? Texture.NEAREST_SAMPLINGMODE : Texture.BILINEAR_SAMPLINGMODE;
  return s.mipmaps === "nearest" ? Texture.NEAREST_NEAREST_MIPNEAREST : Texture.TRILINEAR_SAMPLINGMODE;
}

const WRAP = { clamp: Texture.CLAMP_ADDRESSMODE, repeat: Texture.WRAP_ADDRESSMODE, mirror: Texture.MIRROR_ADDRESSMODE } as const;

/** @internal Builds and caches a Babylon scene's materials and textures (ADR 0127). */
/** @internal A 2D material's sprite shader graph (`BabylonMaterialLibrary.spriteGraph`, ADR 0415). */
export interface SpriteGraph {
  compiled: CompiledShaderGraph;
  properties: Record<string, GraphValue>;
  keywords: Record<string, KeywordValue>;
  /** Changes whenever the graph or its values do (what 2D draws key their materials on). */
  key: string;
}

export class BabylonMaterialLibrary {
  private defaultMade: PBRMaterial | null = null;
  private readonly shared: GraphShared;
  private readonly read: AssetRead;
  private readonly warned = new Set<string>();
  private readonly assets = new Map<string, AssetEntry>();
  /** 2D materials' sprite graphs (ADR 0415), by material path. */
  private readonly spriteGraphs = new Map<string, { stamp: MaterialStamp; graph: SpriteGraph | null }>();
  /** Graph materials by their Babylon material, for copies sharing the compiled program. */
  private readonly graphs = new WeakMap<BabylonMaterial, BabylonGraphMaterial>();
  private readonly noFog = new WeakSet<BabylonMaterial>();
  private readonly sharedApplied = new WeakMap<BabylonMaterial, number>();
  /** Bumped when script values change a material in place, so renderer copies follow. */
  private readonly stamps = new WeakMap<BabylonMaterial, number>();
  private readonly instances = new Map<EngineMaterial, InstanceEntry>();
  private readonly renderers = new Map<MeshRenderer, RendererEntry>();
  /** The slot copies of a renderer's slot overrides, and the multi-materials made of them. */
  private readonly slotEntries = new Map<MeshRenderer, { slots: Map<number, SlotEntry>; multis: Map<object, Map<string, MultiMaterial>> }>();
  /** The image each built-in copy's `texture` value asks for (null: the base's). */
  private readonly wantedTextures = new WeakMap<PBRMaterial, string | null>();
  private readonly modelMaterials = new WeakMap<object, BabylonMaterial>();
  private readonly slotMultis = new WeakMap<object, Map<string, MultiMaterial>>();
  private readonly probeCopies = new WeakMap<BabylonMaterial, Map<string, PBRMaterial>>();
  /**
   * The blended probe copies a sync made (keyed by weight, so a mesh crossing a blend zone makes one per
   * step), each with whether a renderer drew it this sync: {@link endSync} frees the rest. Copies asked for
   * outside a sync (the warm-up's) aren't here, so they stay.
   */
  private readonly syncedBlends = new Map<PBRMaterial, boolean>();
  private syncing = false;
  /** How to free each clone it made: with the texture copies Babylon's `clone` made for it (`cloneMaterial`). */
  private readonly clones = new WeakMap<BabylonMaterial, () => void>();
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
    const adjust = this.slotAdjust(r, slots);
    return {
      material,
      of: (src) => modelBaseMaterial(this.scene, this.modelMaterials, src, pick, this.slotMultis, variant, adjust) ?? (adjust ? adjust.material(DEFAULT_SLOT, this.defaultMaterial) : this.defaultMaterial),
    };
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
    this.syncing = true;
    for (const e of this.instances.values()) e.seen = false;
    for (const m of this.syncedBlends.keys()) this.syncedBlends.set(m, false);
  }

  /** Free the script Material instances and blended probe copies no renderer drew since {@link beginSync}. */
  endSync(): void {
    this.syncing = false;
    for (const [m, e] of this.instances) if (!e.seen) this.disposeInstance(m);
    for (const [m, seen] of [...this.syncedBlends]) if (!seen) this.disposeClone(m);
  }

  /** A renderer went: free its override copies. */
  release(r: MeshRenderer): void {
    this.releaseOverrides(r);
    this.releaseSlots(r);
  }

  /** A renderer's renderer-wide override copy. */
  private releaseOverrides(r: MeshRenderer): void {
    const e = this.renderers.get(r);
    if (!e) return;
    if (e.graph) e.graph.dispose();
    else if (e.material !== e.base) this.disposeClone(e.material);
    this.renderers.delete(r);
  }

  private disposeSlotEntry(e: SlotEntry): void {
    if (e.graph) e.graph.dispose();
    else e.material.dispose(false, true); // its own clones of the textures too
  }

  /** Every slot copy a renderer holds, and the multi-materials of them. */
  private releaseSlots(r: MeshRenderer): void {
    const held = this.slotEntries.get(r);
    if (!held) return;
    for (const m of held.multis.values()) for (const multi of m.values()) multi.dispose();
    for (const e of held.slots.values()) this.disposeSlotEntry(e);
    this.slotEntries.delete(r);
  }

  /**
   * The renderer's slot overrides (`setMaterialProperty(name, value, slot)`, ADR 0371's `materials[slot].<name>`
   * tracks) as what `modelBaseMaterial` swaps in, or undefined without any: each overridden slot draws its own copy
   * of the material it would draw, set in place when the overrides change (animating them every frame changes
   * uniforms only), freed with the renderer or when its overrides are cleared.
   */
  private slotAdjust(r: MeshRenderer, slots: readonly MaterialSlot[]): SlotAdjust | undefined {
    const overrides = r._slotMaterialProperties;
    let held = this.slotEntries.get(r);
    if (overrides.size === 0) {
      if (held) this.releaseSlots(r);
      return undefined;
    }
    if (!held) this.slotEntries.set(r, (held = { slots: new Map(), multis: new Map() }));
    for (const [i, e] of held.slots) {
      if (overrides.has(i)) continue;
      this.disposeSlotEntry(e);
      held.slots.delete(i);
    }
    const own = held;
    return {
      multis: own.multis,
      material: (surface, m) => {
        const i = slots.findIndex((s) => s.surface === surface);
        const values = i < 0 ? undefined : overrides.get(i);
        return values ? this.slotCopy(r, own.slots, i, m, values) : m;
      },
    };
  }

  /** Slot `slot`'s copy of `base` with `values` applied (made on first use), or `base` for a material that can't be copied. */
  private slotCopy(r: MeshRenderer, copies: Map<number, SlotEntry>, slot: number, base: BabylonMaterial, values: ReadonlyMap<string, MaterialPropertyValue>): BabylonMaterial {
    let e = copies.get(slot);
    if (e && e.base !== base) {
      this.disposeSlotEntry(e);
      copies.delete(slot);
      e = undefined;
    }
    const stamp = this.stamps.get(base) ?? 0;
    if (e && e.version === r._slotMaterialPropertiesVersion && e.stamp === stamp) return e.material;
    const baseGraph = this.graphs.get(base);
    const name = `${base.name}:${r.node.name}:${slot}`;
    if (!e) {
      if (baseGraph) {
        const g = this.graphCopy(baseGraph, name);
        this.graphs.set(g.material, g);
        e = { base, material: g.material, graph: g, version: -1, stamp };
      } else if (base instanceof PBRMaterial) e = { base, material: base.clone(name), version: -1, stamp };
      else return base;
      if (this.noFog.has(base)) this.noFog.add(e.material);
      copies.set(slot, e);
    }
    e.version = r._slotMaterialPropertiesVersion;
    e.stamp = stamp;
    if (e.graph && baseGraph) {
      e.graph.setProperties({ ...baseGraph.properties, ...graphValues(values) });
      e.graph.setKeywords(baseGraph.keywords);
    } else if (e.material instanceof PBRMaterial && base instanceof PBRMaterial) {
      applySlotOverrides(e.material, base, values);
      if (!hasLiveTextureTransform(base) && [...values.keys()].some((k) => k.startsWith("textureTransform."))) {
        this.warn({ key: `slotTransform|${base.name}`, message: `"${r.node.name}" animates the texture transform of slot ${slot}, but its material keeps none live (only a glTF material whose transform an animation drives does); the animation is ignored.` });
      }
    }
    return e.material;
  }

  /**
   * A copy of a built-in material reflecting a probe's map (ADR 0054), one per material, probe and blend
   * (a neighbour's map and the primary's share, ADR 0110), kept for reuse. A blended copy a sync made is
   * freed at the end of the first sync that doesn't draw it, so a mesh moving through a blend zone keeps
   * only the copies drawn now.
   */
  probeCopy(base: PBRMaterial, hit: ProbeHit): PBRMaterial {
    let byProbe = this.probeCopies.get(base);
    if (!byProbe) {
      const copies = (byProbe = new Map<string, PBRMaterial>());
      this.probeCopies.set(base, copies);
      // The base freed (an asset rebuilt, a renderer's or instance's copy released): so are its probe copies.
      base.onDisposeObservable.addOnce(() => {
        if (this.probeCopies.get(base) === copies) this.probeCopies.delete(base);
        for (const c of [...copies.values()]) this.disposeClone(c);
        copies.clear();
      });
    }
    const b = hit.blend;
    const key = b ? `${hit.texture.uniqueId}|${b.texture.uniqueId}|${b.weight}` : `${hit.texture.uniqueId}`;
    let m = byProbe.get(key);
    if (!m) {
      const made = (m = this.clone(base, `${base.name}:probe`));
      made.reflectionTexture = hit.texture;
      if (b) new MycoProbeBlendPlugin(made, { texture: b.texture, weight: b.weight, intensityRatio: 1, box: null });
      byProbe.set(key, made);
      if (this.noFog.has(base)) this.noFog.add(made);
      // A probe's map freed (the probe gone, recaptured at another size, baked): nothing finds this copy again.
      const copies = byProbe;
      made.onDisposeObservable.addOnce(() => {
        this.syncedBlends.delete(made);
        if (copies.get(key) === made) copies.delete(key);
      });
      onOwnerDisposed(made, b ? [hit.texture, b.texture] : [hit.texture], () => this.disposeClone(made));
      if (b && this.syncing) this.syncedBlends.set(made, true);
    } else if (this.syncedBlends.has(m)) {
      if (this.syncing) this.syncedBlends.set(m, true);
      else this.syncedBlends.delete(m); // the warm-up's too now: kept
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
    return cloneMaterial(base, name);
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
  instancing(path: string | null, levelsApplied = false): MaterialInstancing {
    return instancingFor(path ? this.assets.get(path)?.resolved.instancing : undefined, this.opts.editorPicking?.() ?? false, levelsApplied);
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

  /**
   * A texture asset for a use (see {@link TextureUse}) if it has loaded (sampled again if its import settings changed
   * since), else null: it starts loading, and `onReady` runs once with it when it has. A load that fails warns once per
   * path and use (a later call tries again). What 2D draws, decals, lines and the 2D lights ask each frame.
   */
  texture(path: string, use: TextureUse = "color", onReady?: (texture: Texture) => void): Texture | null {
    const have = this.loadedTexture(path, use);
    if (have) return have;
    this.loadTexture(path, use).then(
      (t) => onReady?.(t),
      (err: unknown) => this.warn({ key: `texture|${use}|${path}`, message: `failed to load texture "${path}": ${(err as Error).message}` }),
    );
    return null;
  }

  /** A texture asset for a use (see {@link TextureUse}), loaded once per path and use. Rejects if it can't be read (a later call tries again). */
  loadTexture(path: string, use: TextureUse = "color"): Promise<Texture> {
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
      // A changed format replaces the asset's texture (renderTextures.ts): what samples this one must take the new one.
      rt.onDisposeObservable.addOnce(() => this.renderTextureGone(path, load.key, rt));
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
        invertY: true,
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
   * import settings), or null (none yet: call {@link texture} or {@link loadTexture} to load it).
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
    for (const r of [...this.renderers.keys(), ...this.slotEntries.keys()]) this.release(r);
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

  private readonly loadGraphTexture = (p: string, linear: boolean) => this.loadTexture(p, linear ? "graphData" : "graphColor");

  /** Filtering and wrapping from the image's import settings (ADR 0040). */
  private sample(key: string, path: string, tex: Texture): void {
    this.sampledFrom.set(key, samplingSource(path));
    const s = samplingOf(Assets.importSettings(path));
    tex.updateSamplingMode(samplingMode(s));
    tex.wrapU = tex.wrapV = WRAP[s.wrap];
  }

  /**
   * A render texture handed out was disposed (its asset's format changed, ADR 0109): forget it, so the next
   * ask gets the asset's new texture, and rebuild what sampled it: the material assets that loaded it, and
   * the script instance, renderer and slot copies that set it as a value (made again on their next draw).
   */
  private renderTextureGone(path: string, key: string, rt: Texture): void {
    if (this.textures.get(key) === rt) this.textures.delete(key);
    if (![...this.textures.values()].includes(rt)) this.borrowed.delete(rt);
    const image = path.replace(/^asset:/, "");
    const names = (m: BabylonMaterial, graph: BabylonGraphMaterial | undefined) =>
      graph
        ? Object.values(graph.properties).some((v) => typeof v === "string" && v.replace(/^asset:/, "") === image)
        : m instanceof PBRMaterial && this.wantedTextures.get(m) === image;
    for (const e of this.assets.values()) if (e.uses.has(image) || (e.material && names(e.material, e.graph))) e.rebuild = true;
    for (const [r, e] of [...this.renderers]) if (e.material !== e.base && names(e.material, e.graph)) this.releaseOverrides(r);
    // A slot copy taking it as a slot override only (its base doesn't): the renderer's slot copies go.
    for (const [r, held] of [...this.slotEntries]) if ([...held.slots.values()].some((e) => e.material !== e.base && names(e.material, e.graph))) this.releaseSlots(r);
    for (const [m, e] of [...this.instances]) if (e.material !== e.base && names(e.material, e.graph)) this.disposeInstance(m);
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

  /**
   * @internal A 2D material's sprite shader graph (ADR 0415): the compiled graph and its property and keyword values,
   * when `path` is a material shaded by (or itself is) a graph with a sprite target compiled for this renderer's shader
   * language, else null. Resolved again when stale (a graph edit hot-reloads its 2D draws on their next change).
   */
  spriteGraph(path: string): SpriteGraph | null {
    if (!path) return null;
    const level = Graphics.tier.shaderLevel;
    let cached = this.spriteGraphs.get(path);
    if (!cached || !isStampCurrent(cached.stamp, path, level, this.read)) {
      const resolved = resolveMaterial(path, { shaderLevel: level, target: this.scene.getEngine().isWebGPU ? "wgsl" : "glsl", read: this.read });
      for (const w of resolved.warnings) this.warn(w);
      const c = resolved.kind === "graph" ? resolved.compiled : null;
      const graph = c && c.target.startsWith("sprite-") && !c.noWgsl && this.scene.getEngine().isWebGPU ? { compiled: c, properties: resolved.properties, keywords: resolved.keywords, key: `${c.key}|${JSON.stringify(resolved.properties)}|${JSON.stringify(resolved.keywords)}` } : null;
      this.spriteGraphs.set(path, (cached = { stamp: resolved.stamp, graph }));
    }
    return cached.graph;
  }

  /** @internal A new graph material for a 2D draw (ADR 0415): `graph` with property `overrides` (the draw's textures); the caller disposes it. */
  spriteGraphMaterial(name: string, graph: SpriteGraph, overrides: Record<string, GraphValue>): BabylonGraphMaterial {
    const m = createGraphMaterial(this.scene, name, graph.compiled, { ...graph.properties, ...overrides }, this.shared, (p, linear) => this.loadGraphTexture(p, linear));
    m.setKeywords(graph.keywords);
    return m;
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
    const entry: AssetEntry = { resolved, material: null, owned: [], uses: new Set() };
    this.assets.set(path, entry);
    if (resolved.kind === "graph") {
      const load = (p: string, linear: boolean) => {
        entry.uses.add(p.replace(/^asset:/, ""));
        return this.loadGraphTexture(p, linear);
      };
      const graph = createGraphMaterial(this.scene, `graph:${resolved.graph!.replace(/^asset:/, "")}`, resolved.compiled!, resolved.properties, this.shared, load);
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
      entry.uses.add(image);
      this.loadTexture(image)
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

  /** A clone of a built-in material, freed with its texture copies by {@link disposeClone}. */
  private clone(base: PBRMaterial, name: string): PBRMaterial {
    const made = cloneMaterial(base, name)!; // a PBR material always clones
    this.clones.set(made.material, made.dispose);
    return made.material;
  }

  /** Free a material made by {@link clone}. */
  private disposeClone(m: BabylonMaterial): void {
    const free = this.clones.get(m);
    this.clones.delete(m);
    if (free) free();
    else m.dispose();
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
        e = { base: asset, material: this.clone(asset, `${asset.name}:instance`), version: -1, seen: true };
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
    else if (e.material !== e.base) this.disposeClone(e.material);
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
      if (entry) this.releaseOverrides(r);
      return base;
    }
    if (entry && entry.base !== base) {
      this.releaseOverrides(r);
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
        this.graphs.set(g.material, g); // a graph's copy: no probe copy (Babylon can't clone graph plugins), and it batches as a graph
        if (this.noFog.has(base)) this.noFog.add(g.material);
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
        if (entry.material === base) {
          entry.material = this.clone(base, `${base.name}:${r.node.name}`);
          if (this.noFog.has(base)) this.noFog.add(entry.material);
        }
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
      this.loadTexture(image)
        .then((tex) => {
          // Still wanting this image, and not disposed meanwhile.
          if (this.wantedTextures.get(m) === image && this.scene.materials.includes(m)) m.albedoTexture = tex;
        })
        .catch((err) => console.error(`[myco] failed to load texture "${image}":`, err));
  }
}

