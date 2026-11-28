/**
 * MeshRenderer drawing for the Babylon backend (ADR 0108, 0130; the Meshes plugin registers it, ADR 0140): one `BabylonFeature` that mirrors the
 * World's MeshRenderers into Babylon meshes, batched for GPU instancing. It takes what it shares with
 * the renderer (the material library, the probe lookup, the reflection counter) as `BabylonMeshHost`.
 *
 * **Levels per view (ADR 0459 §3).** While the World runs the visibility stage (it has an `LODGroup`), the renderer
 * calls `prepareViews` each frame with every view's visibility result, and each view draws exactly the drawables
 * chosen for it: per renderer mesh, the drawable of the level its result gives (none when hidden or LOD-culled),
 * acquired on first use. A level's derived `ModelMesh` is its batch key, so batches split per level; thin batches
 * draw through per-pass sources (`meshBatches.ts`), and so do auto batches outside the editor's picking (ADR 0461:
 * no Babylon object per renderer). The pooling of per-renderer instances below serves the editor. Shadow casters follow the main view's `casterLevels`. A drawable
 * is kept while a view drew it (or, off-screen, would draw it) in the last `POOL_FRAMES` frames, and batches left
 * empty a few seconds more, so a moving camera doesn't make and dispose Babylon meshes on every switch. Without the visibility stage (or before
 * its first frame, or in a thumbnail, which only syncs) every renderer draws LOD0 as it always did.
 *
 * **Crossfades (ADR 0459 §4).** While a view's result fades a renderer (its `fade` value isn't 0), the view draws both
 * levels in fade batches (`DrawKey.fade`): the incoming level with the result's value, the outgoing one with its
 * complement. Fade drawables are kept per view, as each instance carries that view's value, and pooled like levels.
 * A renderer whose material can't fade (or that draws `off`) shows whichever level shows more instead. Renderers in a
 * crossfading group reserve their fade batches ahead of the first fade, so it doesn't make Babylon meshes.
 */
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import type { Material as BabylonMaterial } from "@babylonjs/core/Materials/material.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { Component } from "../../core/Component";
import type { World } from "../../core/World";
import type { MaterialInstancing } from "../../scene/material";
import { beginMeshLookups, drawnVariant, endMeshLookups, materialSlots, meshesIfLoaded, type MaterialSlot, type ModelMesh } from "../../scene/models";
import { MeshRenderer } from "../components";
import type { DrawnMaterial } from "../RenderSurface";
import { visibilityService } from "../visibility/service";
import { outgoingOf } from "../visibility/select";
import { LOD_CULLED, type VisibilityResult, type VisibilityStats } from "../visibility/types";
import { canFade } from "./lodFade";
import { PICK_ORDER, type BabylonFeature, type DrawnDescription, type DrawnNode, type FeatureSyncContext, type FeatureView, type ViewDrawing } from "./feature";
import type { BabylonMaterialLibrary } from "./materialLibrary";
import { matrixChanged } from "../changeDetection";
import { CASTERS_PASS, MeshBatches, sameDraw, type DrawKey, type Drawable } from "./meshBatches";
import type { ProbeHit } from "./probes";

/** @internal What the mesh feature takes from the renderer. */
export interface BabylonMeshHost {
  /** Babylon scene (right-handed, +Y up). */
  readonly scene: Scene;
  /**
   * Materials and textures (ADR 0127), shared with the renderer; its `editorPicking` option decides
   * whether thin batches draw as instances (ADR 0108, 0129 `drawPolicy`).
   */
  readonly materials: Pick<BabylonMaterialLibrary, "beginSync" | "endSync" | "release" | "meshMaterials" | "probeCopy" | "isGraph" | "fogless" | "instancing">;
  /** Reflection probes (ADR 0054): whether any exist, and the one a world position lies in. */
  readonly probes: { readonly any: boolean; lookup(x: number, y: number, z: number): ProbeHit | null };
  /** A mesh drew with a probe's reflection this frame (the renderer counts them for diagnostics). Optional. */
  reflected?(): void;
}

/** Seconds a level's drawable is kept after the last view drew it (ADR 0459 §3). */
/**
 * Frames a drawable no view drew is kept before it's given back (to its batch, which hands the instance to the next
 * renderer switching into it, `FREE_FRAMES`). Counted in frames, not seconds: a disabled Babylon instance still costs
 * every frame (the scene walks all its meshes), and a fast camera leaves many behind each frame.
 */
export const POOL_FRAMES = 4;
/** Frames between sweeps for pooled drawables to give back. */
const EXPIRE_EVERY = 5;

/** One drawable of a renderer mesh at one level. */
interface LevelDrawable {
  readonly d: Drawable;
  /** When a view (or the casters) last drew it, in the feature's seconds. */
  used: number;
  /** The `prepareViews` frame it was last drawn in. */
  frame: number;
}

interface MeshEntry {
  /**
   * The renderer's own Babylon meshes drawn now (instances, or whole meshes with instancing off; none in a thin
   * batch): LOD0's, or with levels per view those the first view draws.
   */
  meshes: AbstractMesh[];
  /** The drawables `meshes` and the materials report come from. */
  shown: Drawable[];
  /** Per model mesh, its drawables by level (ADR 0108, 0459). */
  levels: (LevelDrawable | undefined)[][];
  /** Per view key, per model mesh, its fade drawables by level (ADR 0459 §4). */
  fades: Map<string, (LevelDrawable | undefined)[][]>;
  /** The fade batches it reserved (every level of every model mesh), while its group crossfades. */
  reserved: DrawKey[];
  /** Per model mesh, the batch it wants at LOD0 (a copy; a level's swaps in the level's mesh). */
  keys: DrawKey[];
  sources: readonly ModelMesh[] | null;
  material: BabylonMaterial | null;
  /** Its meshes' material slots (ADR 0089). */
  slotList: MaterialSlot[];
  /** The world matrix its meshes were last frozen with (null: freeze next sync). */
  matrix: Float32Array | null;
}

const tmpMatrix = new Matrix();
/** The batch a renderer mesh wants this frame, refilled per mesh (ADR 0108). */
const wantedKey: DrawKey = { src: null as unknown as ModelMesh, material: null as unknown as BabylonMaterial, receiveShadows: true, castShadows: true, mode: "auto", applyFog: true };

/** A Babylon material in the engine's material terms (diagnostics, ADR 0128). */
function drawnMaterial(m: BabylonMaterial): DrawnMaterial {
  if (m instanceof PBRMaterial) return { unlit: m.unlit, clearcoat: m.clearCoat.isEnabled ? m.clearCoat.intensity : 0, transmission: m.subSurface.isRefractionEnabled ? m.subSurface.refractionIntensity : 0 };
  const lit = m as { unlit?: boolean; disableLighting?: boolean };
  return { unlit: !!(lit.unlit ?? lit.disableLighting), clearcoat: 0, transmission: 0 };
}

/** The level a model mesh draws for a group level: min(level, its last), 0 without levels (ADR 0459 §2). */
function meshLevel(src: ModelMesh, level: number): number {
  const n = src.lods?.levels.length ?? 1;
  return level < n ? level : n - 1;
}

/** Whether a renderer mesh's batch can crossfade: an instanced batch (auto or thin) of a material the fade plugin takes (ADR 0459 §4). */
function fadeable(key: DrawKey | undefined): boolean {
  return !!key && key.mode !== "off" && canFade(key.material);
}

/** Every drawable a renderer entry holds: its levels' and its fade drawables in every view. */
function* allDrawables(e: MeshEntry): Iterable<LevelDrawable> {
  for (const part of e.levels) for (const ld of part) if (ld) yield ld;
  for (const perView of e.fades.values()) for (const part of perView) for (const ld of part ?? []) if (ld) yield ld;
}

/** @internal Draws every MeshRenderer, batched for GPU instancing (ADR 0108), with levels chosen per view (ADR 0459). */
export class BabylonMeshes implements BabylonFeature {
  private readonly meshRenderers = new Map<MeshRenderer, MeshEntry>();
  /** MeshRenderer meshes batched for GPU instancing (ADR 0108). */
  private readonly batches: MeshBatches;
  private world: World | null = null;
  /** The feature's clock in seconds: the World's real time, or a 60th of a second per sync where it stands still. */
  private now = 0;
  private lastRealtime = -1;
  /** The sync `expire` last swept at. */
  private expiredAt = -Infinity;
  /** Syncs so far, and the sync count when `prepareViews` last ran (levels per view while it ran since the last sync). */
  private syncs = 0;
  private preparedAt = -1;
  /** Levels per view this frame (`prepareViews` ran since the previous sync). */
  private perView = false;
  /** What each view drew at the last `prepareViews`, and the casters. */
  private readonly viewLists: AbstractMesh[][] = [];
  private readonly casterMeshes: AbstractMesh[] = [];
  /** The first view's visibility statistics at the last `prepareViews` (the `lod` diagnostics). */
  private stats: VisibilityStats | null = null;
  private readonly drawing: ViewDrawing;

  constructor(private readonly host: BabylonMeshHost) {
    this.batches = new MeshBatches(host.scene);
    this.drawing = {
      owns: (mesh) => this.batches.owns(mesh),
      meshes: (i, out) => {
        const list = this.viewLists[i];
        if (list) for (const m of list) out.push(m);
      },
      cascades: this.batches,
    };
  }

  /** Every MeshRenderer, then the script Material instances no renderer drew any more (ADR 0107). */
  sync(world: World, _ctx?: FeatureSyncContext): void {
    this.world = world;
    this.tick(world);
    this.perView = this.preparedAt === this.syncs;
    this.syncs++;
    this.batches.setPassMode(this.perView);
    if (!this.perView) this.stats = null;
    this.host.materials.beginSync();
    beginMeshLookups();
    try {
      for (const m of world._componentsOfType(MeshRenderer)) this.syncMesh(world, m);
    } finally {
      endMeshLookups();
    }
    this.host.materials.endSync();
    this.expire();
    this.batches.flush();
  }

  /**
   * ADR 0459 §3: each view's drawables from its visibility result, the casters from `casters`' `casterLevels`. Null
   * (every view lists the scene's meshes, LOD0 as always) when the World runs no visibility stage.
   */
  prepareViews(views: readonly FeatureView[], casters: VisibilityResult | null): ViewDrawing | null {
    const service = this.world ? visibilityService(this.world) : null;
    if (!service || !views.some((v) => v.result)) return null;
    const frame = this.syncs;
    this.preparedAt = frame;
    this.perView = true;
    this.batches.setPassMode(true);
    this.batches.beginPasses();
    const lists = this.viewLists;
    lists.length = views.length;
    for (let k = 0; k < views.length; k++) (lists[k] ??= []).length = 0;
    const casterMeshes = this.casterMeshes;
    casterMeshes.length = 0;
    const touch = (ld: LevelDrawable): Drawable => {
      ld.used = this.now;
      ld.frame = frame;
      return ld.d;
    };
    const use = (r: MeshRenderer, e: MeshEntry, i: number, level: number): Drawable => touch(this.levelDrawable(r, e, i, meshLevel(e.sources![i], level)));
    // Each view's outgoing levels during fades (ADR 0459 §4).
    const fadeFrom = views.map((v) => (v.result ? service.fadeLevels(v.result) : null));
    for (const [r, e] of this.meshRenderers) {
      e.shown.length = 0;
      const n = e.sources?.length ?? 0;
      if (!n || !r.isActiveAndEnabled) {
        this.sweep(r, e, frame);
        continue;
      }
      const slot = service.slotOf(r);
      this.reserveFades(e, slot >= 0 && service.crossfades(r));
      for (let k = 0; k < views.length; k++) {
        const result = views[k].result;
        const pass = views[k].visibility.key;
        let level = 0, from = LOD_CULLED, f = 0;
        if (result && slot >= 0 && slot < result.levels.length) {
          if (result.hidden[slot]) {
            // Off this view: its drawable at its level, if it has one, stays enabled (unlisted) and pooled, as without
            // levels per view, so turning the camera doesn't toggle and remake Babylon instances.
            const kept = result.levels[slot];
            if (kept !== LOD_CULLED) for (let i = 0; i < n; i++) {
              const ld = e.levels[i]?.[meshLevel(e.sources![i], kept)];
              if (ld) touch(ld);
            }
            continue;
          }
          level = result.levels[slot];
          f = result.fade[slot];
          const outgoing = fadeFrom[k];
          if (f !== 0 && outgoing && slot < outgoing.length) from = outgoing[slot];
          else f = 0;
        }
        if (f === 0 && level === LOD_CULLED) continue;
        const list = lists[k];
        for (let i = 0; i < n; i++) {
          const src = e.sources![i];
          if (f === 0) {
            const d = use(r, e, i, level);
            this.batches.add(d, pass, list);
            if (k === 0) e.shown.push(d);
            continue;
          }
          const show = (d: Drawable) => {
            this.batches.add(d, pass, list);
            if (k === 0) e.shown.push(d);
          };
          // Fading: each level this mesh draws for the incoming and the outgoing group level (-1: none).
          const into = level === LOD_CULLED ? -1 : meshLevel(src, level);
          const out = from === LOD_CULLED ? -1 : meshLevel(src, from);
          if (into === out || !fadeable(e.keys[i])) {
            // The same mesh both ways draws whole; a mesh that can't fade shows the level showing more.
            const shown = into === out ? into : outgoingOf(f) < 0.5 ? out : into;
            if (shown >= 0) show(touch(this.levelDrawable(r, e, i, shown)));
            continue;
          }
          if (into >= 0) {
            const d = touch(this.fadeDrawable(r, e, i, into, pass));
            d.setFade(f);
            show(d);
          }
          if (out >= 0) {
            const d = touch(this.fadeDrawable(r, e, i, out, pass));
            d.setFade(outgoingOf(f));
            show(d);
          }
        }
      }
      // Casters: the main view's caster levels (LOD-culled groups cast at their coarsest level within the tier's
      // shadow distance; hidden ones still cast); a renderer without a slot casts LOD0, as its views draw it.
      let casterLevel = r.castShadows ? 0 : LOD_CULLED;
      if (casters && slot >= 0 && slot < casters.casterLevels.length) casterLevel = casters.casterLevels[slot];
      if (casterLevel !== LOD_CULLED) for (let i = 0; i < n; i++) this.batches.add(use(r, e, i, casterLevel), CASTERS_PASS, casterMeshes);
      this.sweep(r, e, frame);
    }
    this.batches.endPasses();
    views.forEach((v, k) => this.batches.passMeshes(v.visibility.key, lists[k]));
    this.batches.passMeshes(CASTERS_PASS, casterMeshes);
    const first = views[0]?.visibility.key;
    this.stats = first !== undefined ? service.stats(first) : null;
    return this.drawing;
  }

  /**
   * After a renderer's passes: every drawable a pass drew (or kept) this frame stays enabled (a cull task drops disabled
   * meshes); the rest of its pool is disabled, so nothing that draws the scene's meshes as a whole draws them.
   */
  private sweep(r: MeshRenderer, e: MeshEntry, frame: number): void {
    const active = r.isActiveAndEnabled;
    for (const part of e.levels) for (let l = 0; l < part.length; l++) {
      const ld = part[l];
      if (ld) ld.d.setEnabled(active && ld.frame === frame);
    }
    if (e.fades.size) for (const perView of e.fades.values()) for (const part of perView) for (const ld of part ?? []) ld?.d.setEnabled(active && ld.frame === frame);
    e.meshes.length = 0;
    for (const d of e.shown) if (d.mesh) e.meshes.push(d.mesh);
  }

  release(c: Component): void {
    if (!(c instanceof MeshRenderer)) return;
    const e = this.meshRenderers.get(c);
    if (e) {
      this.releaseAll(e);
      this.meshRenderers.delete(c);
    }
    this.host.materials.release(c);
  }

  dispose(): void {
    this.batches.dispose();
    this.meshRenderers.clear();
  }

  /**
   * ADR 0276: appends the meshes that cast shadows: enabled renderers' with castShadows, and thin batches' sources;
   * with levels per view, the casters `prepareViews` chose (ADR 0459 §3).
   */
  casters(out: AbstractMesh[]): void {
    if (this.perView) {
      for (const m of this.casterMeshes) out.push(m);
      return;
    }
    for (const [r, e] of this.meshRenderers) if (r.castShadows && r.isActiveAndEnabled) out.push(...e.meshes);
    for (const m of this.batches.thinCasters()) out.push(m);
  }

  /** ADR 0276: whether every renderer's model has loaded (the material library's own loading is the renderer's to check). */
  loaded(): boolean {
    for (const m of this.meshRenderers.values()) if (m.sources === null) return false;
    return true;
  }

  /** ADR 0154, 0459 §3: the main view's level statistics while levels are applied per view, else nothing. */
  diagnostics(): unknown {
    const s = this.stats;
    if (!s) return undefined;
    return { lod: { groups: s.groups, perLevel: [...s.perLevel], culled: s.lodCulled, fading: s.fading }, ...(s.occlusion ? { occlusion: { ...s.occlusion } } : {}) };
  }

  /** The renderer that owns a drawn mesh or batch source (`describe`, for the variant report), or null. */
  private ownerOf(drawn: unknown): MeshRenderer | null {
    const batch = this.batches.keyOf(drawn as AbstractMesh);
    for (const [r, e] of this.meshRenderers) {
      if (e.meshes.includes(drawn as AbstractMesh)) return r;
      for (const ld of allDrawables(e)) if (ld.d.source === drawn || ld.d.mesh === drawn || ld.d.key === batch) return r;
    }
    return null;
  }

  /** ADR 0154: a drawn mesh's node, for the variant report. */
  describe(drawn: object): DrawnDescription | null {
    const owner = this.ownerOf(drawn);
    return owner ? { node: owner.node, what: `"${owner.node.name}"` } : null;
  }

  /**
   * ADR 0276: each renderer drawn now (an enabled drawable): its own meshes (none in a thin batch, which
   * draws instances of a shared source), depth-tested, with its drawn materials (the diagnostics, ADR 0128).
   * With levels per view, what the first view drew (the editor's scene view, the game's main camera).
   */
  *drawn(): Iterable<DrawnNode> {
    for (const [component, e] of this.meshRenderers) {
      const shown = e.shown.filter((d) => d.enabled);
      if (!shown.length) continue;
      yield { component, shape: { kind: "meshes", meshes: e.meshes }, order: PICK_ORDER.depthTested, materials: shown.map((d) => drawnMaterial(d.draw.material)) };
    }
  }

  /** Advance the clock: by the World's real time, or a 60th of a second where it doesn't advance (an edit-mode World). */
  private tick(world: World): void {
    const real = world.time.realtimeSinceStartup;
    const delta = this.lastRealtime >= 0 ? real - this.lastRealtime : 0;
    this.lastRealtime = real;
    this.now += delta > 0 ? delta : 1 / 60;
    this.batches.setTime(this.now);
  }

  /**
   * Give back the drawables no view drew for `POOL_FRAMES` frames; their batches are kept a little longer. A disabled Babylon
   * instance still costs every frame (the scene walks all its meshes), so the pool stays short.
   * Swept a few times a second, not every frame: a level is given back up to `EXPIRE_EVERY` seconds late.
   */
  private expire(): void {
    if (this.syncs - this.expiredAt < EXPIRE_EVERY) return;
    this.expiredAt = this.syncs;
    for (const e of this.meshRenderers.values()) {
      for (const part of e.levels) {
        // Level 0 too: with levels per view a renderer drawn at a coarser level (or not at all) gives its LOD0 back.
        // Without levels per view every sync draws (and so keeps) it.
        for (let level = 0; level < part.length; level++) {
          const ld = part[level];
          if (!ld || !this.expired(ld)) continue;
          this.batches.release(ld.d, true);
          part[level] = undefined;
        }
      }
      // Fade drawables of every level, per view (a view gone takes its fade drawables with it).
      for (const [view, perView] of e.fades) {
        let any = false;
        for (const part of perView) {
          for (let level = 0; level < (part?.length ?? 0); level++) {
            const ld = part![level];
            if (!ld) continue;
            if (!this.expired(ld)) {
              any = true;
              continue;
            }
            this.batches.release(ld.d, true);
            part![level] = undefined;
          }
        }
        if (!any) e.fades.delete(view);
      }
    }
  }

  /** Whether a pooled drawable has gone undrawn for `POOL_FRAMES` frames. */
  private expired(ld: LevelDrawable): boolean {
    return this.syncs - ld.frame > POOL_FRAMES;
  }

  /** Reserve a renderer's fade batches while its group crossfades (and its levels can fade), and give them back after. */
  private reserveFades(e: MeshEntry, crossfades: boolean): void {
    if (crossfades && !e.reserved.length) {
      (e.sources ?? []).forEach((src, i) => {
        const levels = src.lods?.levels.length ?? 1;
        if (levels < 2 || !fadeable(e.keys[i])) return;
        for (let level = 0; level < levels; level++) {
          const key: DrawKey = { ...e.keys[i], fade: true };
          if (level > 0) key.src = src.lods!.levels[level].mesh;
          this.batches.reserve(key);
          e.reserved.push(key);
        }
      });
    } else if (!crossfades && e.reserved.length) this.unreserveFades(e);
  }

  private unreserveFades(e: MeshEntry): void {
    for (const key of e.reserved) this.batches.unreserve(key);
    e.reserved = [];
  }

  /** Give back a model mesh's fade drawables in every view. */
  private releaseFades(e: MeshEntry, i: number): void {
    for (const perView of e.fades.values()) {
      for (const ld of perView[i] ?? []) if (ld) this.batches.release(ld.d, true);
      perView[i] = [];
    }
  }

  private releaseAll(e: MeshEntry): void {
    for (const part of e.levels) for (const ld of part) if (ld) this.batches.release(ld.d);
    for (const perView of e.fades.values()) for (const part of perView) for (const ld of part ?? []) if (ld) this.batches.release(ld.d);
    e.fades.clear();
    this.unreserveFades(e);
    e.levels = [];
    e.keys = [];
    e.shown = [];
    e.meshes = [];
  }

  /** A renderer mesh's drawable at `level` (of its model mesh), acquired on first use at its matrix. */
  private levelDrawable(r: MeshRenderer, e: MeshEntry, i: number, level: number): LevelDrawable {
    const part = (e.levels[i] ??= []);
    let ld = part[level];
    if (ld) return ld;
    const src = e.sources![i];
    const key = { ...e.keys[i] };
    if (level > 0) key.src = src.lods!.levels[level].mesh;
    if (e.matrix) Matrix.FromArrayToRef(e.matrix as unknown as number[], 0, tmpMatrix);
    const d = this.batches.acquire(key, level > 0 ? `${r.node.name}:${src.name}:lod${level}` : `${r.node.name}:${src.name}`, e.matrix ? tmpMatrix : undefined);
    part[level] = ld = { d, used: this.now, frame: -1 };
    return ld;
  }

  /** A renderer mesh's fade drawable at `level` (of its model mesh) for view `view`, acquired on first use at its matrix. */
  private fadeDrawable(r: MeshRenderer, e: MeshEntry, i: number, level: number, view: string): LevelDrawable {
    let perView = e.fades.get(view);
    if (!perView) e.fades.set(view, (perView = []));
    const part = (perView[i] ??= []);
    let ld = part[level];
    if (ld) return ld;
    const src = e.sources![i];
    const key: DrawKey = { ...e.keys[i], fade: true };
    if (level > 0) key.src = src.lods!.levels[level].mesh;
    if (e.matrix) Matrix.FromArrayToRef(e.matrix as unknown as number[], 0, tmpMatrix);
    const d = this.batches.acquire(key, `${r.node.name}:${src.name}:lod${level}:fade`, e.matrix ? tmpMatrix : undefined);
    part[level] = ld = { d, used: this.now, frame: -1 };
    return ld;
  }

  private syncMesh(world: World, r: MeshRenderer): void {
    const { materials, probes } = this.host;
    let entry = this.meshRenderers.get(r);
    if (!entry) {
      entry = { meshes: [], shown: [], levels: [], fades: new Map(), reserved: [], keys: [], sources: null, material: null, slotList: [], matrix: null };
      this.meshRenderers.set(r, entry);
    }
    const sources = meshesIfLoaded(r.mesh); // null while the model loads
    const same = entry.sources !== null && sources !== null && entry.sources.length === sources.length && entry.sources.every((m, i) => m === sources[i]);
    const slots = same ? entry.slotList : sources ? materialSlots(sources) : [];
    const variant = sources?.length ? drawnVariant(r.mesh, r.variant) : undefined; // ADR 0118
    // Material slots, script Materials and overrides (ADR 0089, 0107, 0049), resolved by the library.
    const drawnBy = materials.meshMaterials(r, slots, variant);
    const material = drawnBy.material;
    if (!same) {
      this.releaseAll(entry);
      entry.sources = sources;
      entry.slotList = slots;
      entry.matrix = null;
    }
    entry.material = material;
    const visible = r.isActiveAndEnabled;
    const e = r.node.entity;
    const world16 = world.worldMatrix(e);
    // Refill the drawables' matrices only when the node moved: freezing recomputes their bounds.
    const moved = visible && (sources?.length ?? 0) > 0 && matrixChanged(entry, world16, e * 16);
    const mode = this.instancingFor(r);
    let changed = !same;
    (sources ?? []).forEach((src, i) => {
      // One material, or a multi-material shared by every renderer with the same slot materials, so they batch (ADR 0108).
      const base = drawnBy.of(src);
      // A reflection probe (ADR 0054) for built-in materials; graph materials keep the scene's environment.
      const probe = visible && probes.any && base instanceof PBRMaterial && !materials.isGraph(base) ? probes.lookup(world16[e * 16 + 12], world16[e * 16 + 13], world16[e * 16 + 14]) : null;
      const drawn = probe ? materials.probeCopy(base as PBRMaterial, probe) : base;
      if (probe) this.host.reflected?.();
      // The batch it draws in (ADR 0108): same geometry, material and shadow settings draw instanced.
      const key = wantedKey;
      key.src = src;
      key.material = drawn;
      key.receiveShadows = r.receiveShadows;
      key.castShadows = r.castShadows;
      key.mode = mode;
      key.applyFog = !materials.fogless(base);
      const had = entry!.keys[i];
      if (!had || !sameDraw(had, key)) {
        // Another batch: every level's drawable goes, and comes back on first use in it.
        for (const ld of entry!.levels[i] ?? []) if (ld) this.batches.release(ld.d);
        entry!.levels[i] = [];
        this.releaseFades(entry!, i);
        this.unreserveFades(entry!); // reserved again for the new batches by the next `prepareViews`
        entry!.keys[i] = { ...key };
        changed = true;
      }
      const part = entry!.levels[i]!;
      const fades: LevelDrawable[] = [];
      for (const perView of entry!.fades.values()) for (const ld of perView[i] ?? []) if (ld) fades.push(ld);
      if (moved && entry!.matrix) {
        Matrix.FromArrayToRef(entry!.matrix as unknown as number[], 0, tmpMatrix);
        for (const ld of part) ld?.d.setMatrix(tmpMatrix);
        for (const ld of fades) ld.d.setMatrix(tmpMatrix);
      }
      if (this.perView) {
        // Views enable what they draw (`prepareViews`); a renderer turned off draws in none.
        if (!visible) {
          for (const ld of part) ld?.d.setEnabled(false);
          for (const ld of fades) ld.d.setEnabled(false);
        }
        return;
      }
      // Without levels per view nothing fades: fade drawables wait, disabled, to be given back.
      for (const ld of fades) ld.d.setEnabled(false);
      // LOD0 for every view, as without levels; any other level's drawable waits, disabled, to be given back.
      const ld0 = this.levelDrawable(r, entry!, i, 0);
      ld0.used = this.now;
      ld0.frame = this.syncs;
      ld0.d.setEnabled(visible);
      for (let level = 1; level < part.length; level++) part[level]?.d.setEnabled(false);
    });
    if (!this.perView && (changed || entry.shown.length !== (sources?.length ?? 0) || entry.shown.some((d, i) => entry!.levels[i]?.[0]?.d !== d))) {
      entry.shown = entry.levels.map((part) => part[0]!.d);
      entry.meshes = entry.shown.flatMap((d) => (d.mesh ? [d.mesh] : []));
    }
  }

  /**
   * How a renderer's meshes batch (ADR 0108): its slot 0 material asset's `instancing`; auto draws thin while levels
   * are applied per view, outside the editor's picking (ADR 0461).
   */
  private instancingFor(r: MeshRenderer): MaterialInstancing {
    return this.host.materials.instancing(r.materials[0] || r.material, this.perView);
  }
}
