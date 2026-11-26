/**
 * 2D materials (ADR 0418): the one place a 2D draw on Babylon gets its material. Lone sprites and sprite batches
 * (`sprites.ts`), quad batches (`quadBatches.ts`: tiles, 2D lines, 2D decals, skinned sprites, light volumes) and 2D
 * particles (`particles.ts`) ask it for a material for a texture, a 2D material asset, a sorting layer, a blend and a
 * mask, and get a handle. It owns:
 *
 * - the lit decision (ADR 0399): a draw is lit unless its material is Sprite Unlit (or it asks for none), and only while
 *   its sorting layer is in one of the 2D lighting rig's layer batches;
 * - the normal and mask maps from the texture's import settings (ADR 0414), loaded as data textures;
 * - the graph-or-layered choice (ADR 0415): a material shaded by a sprite graph builds the graph's material (unshared),
 *   anything else the layered quad material (`layeredQuads.ts`);
 * - the sharing key (shared materials are counted and freed with their last handle) and release;
 * - invalidation: it watches the rig's layout itself (`BabylonLights2D.onLayoutChange`) and a map finishing loading, and
 *   refreshes every handle in place (a lit material's plugin can't be taken off, so that is a new material). Callers
 *   read `handle.material` (or pass `onChange`); they never see versions or keys.
 */
import { Constants } from "@babylonjs/core/Engines/constants.js";
import type { Material } from "@babylonjs/core/Materials/material.js";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import type { Observer } from "@babylonjs/core/Misc/observable.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { Assets } from "../../scene/Assets";
import { spriteMaterialGraph, spriteMaterialLit, spriteMaterialProblem } from "../lights2D/spriteMaterial";
import type { QuadBlend, QuadMask } from "../quadBatches";
import type { BabylonGraphMaterial } from "./graphMaterial";
import { batchedSpriteMaterial, layeredQuadMaterial, lightLayeredQuads, QuadMaskPlugin } from "./layeredQuads";
import { lights2DOf, type BabylonLights2D } from "./lights2D";
import type { LitQuadSetup } from "./lights2DMaterial";
import type { BabylonMaterialLibrary, SpriteGraph } from "./materialLibrary";
import { spriteGraphKey, spriteGraphMaterial } from "./spriteGraphMaterial";

/** An sRGB tint and opacity, 0..1. */
export interface Tint2D {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** What a 2D draw asks for (`BabylonMaterials2D.acquire`). */
export interface Material2DRequest {
  /** The image it draws (an asset path, `asset:` allowed), or "" for plain white. */
  readonly texture: string;
  /** Its 2D material asset ("" the default, Sprite Lit; ADR 0399, 0415), or null for a plain unlit draw (a light's volume). */
  readonly material: string | null;
  /** The sorting layer whose 2D light it reads. */
  readonly sortingLayer: string;
  /** How it meets what's below (ADR 0415); default `"alpha"`. */
  readonly blend?: QuadBlend;
  /** A mask (ADR 0395): an unshared material, its map following `uv` in place. */
  readonly mask?: QuadMask | null;
  /** The albedo's tint; default white. A shared material is shared by draws with the same tint; an own one takes it in place. */
  readonly tint?: Tint2D;
  /** A sprite batch's material (ADR 0108): per-instance UV rectangles, the tint the instance colour's. Never graph-shaded. */
  readonly instanced?: boolean;
  /** Never shared (a lone sprite's material): the tint changes in place. */
  readonly own?: boolean;
}

/** @internal A 2D draw's material (`BabylonMaterials2D.acquire`). */
export interface Material2D {
  /** What to draw with now. Replaced in place when the 2D lighting's batching changes, a map loads, or `update` asks for another. */
  readonly material: Material;
  /** Whether a normal map shades it: a deforming mesh then needs a 2D tangent per vertex (`TANGENT_2D_ATTRIBUTE`). */
  readonly normalMapped: boolean;
  /** Ask for another material: kept, changed in place, shared or rebuilt as the request needs. */
  update(request: Material2DRequest): void;
  /** Give it back: an unshared material is disposed, a shared one with its last handle. */
  release(): void;
}

/** What the 2D materials borrow from the renderer: the material library's textures and sprite graphs (ADR 0127). */
export interface Materials2DDeps {
  readonly scene: Scene;
  readonly library: Pick<BabylonMaterialLibrary, "texture"> & Partial<Pick<BabylonMaterialLibrary, "spriteGraph" | "spriteGraphMaterial">>;
  /** Logs a warning once per key (a material 2D draws can't take). */
  warnOnce?(key: string, message: string): void;
}

/** A material and how to free it, with the parts updated in place. */
interface Built {
  material: PBRMaterial;
  dispose(): void;
  mask: QuadMaskPlugin | null;
}

interface Shared {
  built: Built;
  users: number;
}

/** A resolved request: its key, its lit setup and its graph. */
interface Resolved {
  key: string;
  shared: boolean;
  lit: LitQuadSetup | null;
  litKey: string;
  graph: SpriteGraph | null;
}

const WHITE: Tint2D = { r: 1, g: 1, b: 1, a: 1 };
const path = (p: string): string => p.replace(/^asset:/, "");
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** @internal The 2D materials of one Babylon scene (ADR 0418). */
export class BabylonMaterials2D {
  private readonly shared = new Map<string, Shared>();
  private readonly handles = new Set<Handle>();
  /** Lit setups by their key, one object each while the rig's layout holds (2D particles compare them by identity). */
  private readonly setups = new Map<string, LitQuadSetup>();
  /** Maps asked for and loading (one wake-up each). */
  private readonly waiting = new Set<string>();
  private rig: BabylonLights2D | undefined;
  private observer: Observer<void> | null = null;
  private disposed = false;

  constructor(private readonly deps: Materials2DDeps) {}

  /** A material for `request`; `onChange` runs when it's replaced in place (the handle's `material` is the new one). */
  acquire(request: Material2DRequest, onChange?: () => void): Material2D {
    const h = new Handle(this, onChange ?? null);
    this.handles.add(h);
    h.update(request);
    return h;
  }

  /** Whether a lone draw of `material` is shaded by its sprite graph (ADR 0415): a sprite then needs a mesh of its own. */
  shadedByGraph(material: string): boolean {
    return this.graphOf(material) !== null;
  }

  /**
   * The lit setup a draw of `material` on `sortingLayer` gets now (with `image`'s maps), or null when it's unlit: an
   * unlit material, or no 2D light on its layer. The same object while it holds (2D particles rebuild when it changes).
   */
  litSetup(material: string | null, sortingLayer: string, image = ""): LitQuadSetup | null {
    return this.lit(material, sortingLayer, image).lit;
  }

  dispose(): void {
    this.disposed = true;
    for (const h of [...this.handles]) h.release();
    for (const s of this.shared.values()) s.built.dispose();
    this.shared.clear();
    this.observer?.remove();
    this.observer = null;
  }

  // --- for handles --------------------------------------------------------------------------------------------

  /** @internal What `request` resolves to now. */
  resolve(request: Material2DRequest): Resolved {
    const { lit, litKey } = this.lit(request.material, request.sortingLayer, request.texture);
    const blend = request.blend ?? "alpha";
    const graph = !request.mask && !request.instanced && request.material ? this.graphOf(request.material) : null;
    if (graph) return { key: `graph|${spriteGraphKey(graph, request.texture, litKey)}|${blend}`, shared: false, lit, litKey, graph };
    const image = path(request.texture);
    if (request.own || request.mask) return { key: `own|${image}|${request.mask ? path(request.mask.texture) : ""}|${litKey}|${blend}`, shared: false, lit, litKey, graph: null };
    const t = request.tint ?? WHITE;
    return { key: `${request.instanced ? "batch" : "quad"}|${image}|${t.r},${t.g},${t.b},${clamp01(t.a)}|${litKey}|${blend}`, shared: true, lit, litKey, graph: null };
  }

  /** @internal A shared material for a resolved request (counted); `releaseShared` gives it back. */
  acquireShared(r: Resolved, request: Material2DRequest): Built {
    let s = this.shared.get(r.key);
    if (!s) this.shared.set(r.key, (s = { built: this.build(`2d:${r.key}`, r, request), users: 0 }));
    s.users++;
    return s.built;
  }

  /** @internal */
  releaseShared(key: string): void {
    const s = this.shared.get(key);
    if (!s || --s.users > 0) return;
    s.built.dispose();
    this.shared.delete(key);
  }

  /** @internal A new material for a resolved request. */
  build(name: string, r: Resolved, request: Material2DRequest): Built {
    if (r.graph && this.deps.library.spriteGraphMaterial) {
      const library = this.deps.library;
      const g: BabylonGraphMaterial = spriteGraphMaterial((n, graph, overrides) => library.spriteGraphMaterial!(n, graph, overrides), name, r.graph, request.texture, r.lit);
      const m = g.material as PBRMaterial;
      if (request.blend === "additive") m.alphaMode = Constants.ALPHA_ADD;
      tint(m, request.tint);
      return { material: m, dispose: () => g.dispose(), mask: null };
    }
    const m = layeredQuadMaterial(name, this.deps.scene, null);
    if (request.instanced) batchedSpriteMaterial(m);
    if (request.blend === "additive") m.alphaMode = Constants.ALPHA_ADD;
    if (!request.instanced) tint(m, request.tint);
    let gone = false;
    const image = path(request.texture);
    if (image) {
      const apply = (tex: Texture | null): void => {
        if (!tex || gone || m.albedoTexture === tex) return;
        tex.hasAlpha = true; // Babylon reads a texture's alpha only when told it has one
        m.albedoTexture = tex;
      };
      apply(this.deps.library.texture(image, "color", apply));
    }
    let mask: QuadMaskPlugin | null = null;
    if (request.mask) {
      const plugin = (mask = new QuadMaskPlugin(m, { texture: null, uv: Array.from(request.mask.uv) }));
      const applyMask = (tex: Texture | null): void => {
        if (tex && !gone) plugin.mask.texture = tex;
      };
      applyMask(this.deps.library.texture(path(request.mask.texture), "color", applyMask));
    }
    if (r.lit) lightLayeredQuads(m, r.lit);
    return {
      material: m,
      dispose: () => {
        gone = true;
        m.dispose();
      },
      mask,
    };
  }

  /** @internal */
  forget(h: Handle): void {
    this.handles.delete(h);
  }

  // --- internals ----------------------------------------------------------------------------------------------

  /** The sprite graph shading `material` (ADR 0415), or null. */
  private graphOf(material: string): SpriteGraph | null {
    return material && spriteMaterialGraph(material) ? (this.deps.library.spriteGraph?.(material) ?? null) : null;
  }

  /** A draw's lit setup and its key ("" unlit), warning once about a material 2D draws can't take. */
  private lit(material: string | null, sortingLayer: string, image: string): { lit: LitQuadSetup | null; litKey: string } {
    if (material === null) return { lit: null, litKey: "" };
    const problem = spriteMaterialProblem(material);
    if (problem) this.deps.warnOnce?.(`spritematerial|${material}`, problem);
    if (!spriteMaterialLit(material)) return { lit: null, litKey: "" };
    const rig = this.watch();
    const batch = rig?.batchOfLayer(sortingLayer) ?? -1;
    if (!rig || batch < 0) return { lit: null, litKey: "" };
    const file = path(image);
    const settings = file && Assets.has(file) ? Assets.importSettings(file) : null;
    const normalPath = path(settings?.secondaryTextures.normalMap ?? "");
    const maskPath = path(settings?.secondaryTextures.maskMap ?? "");
    const normal = normalPath ? this.dataTexture(normalPath) : null;
    const mask = maskPath ? this.dataTexture(maskPath) : null;
    const greenDown = settings?.normalMapGreen === "down";
    const litKey = `lit${batch}|${normal ? normalPath : ""}|${mask ? maskPath : ""}|${greenDown}`;
    let lit = this.setups.get(litKey);
    if (!lit) this.setups.set(litKey, (lit = { batch, normal, mask, greenDown }));
    return { lit, litKey };
  }

  /** A normal or mask map (read linear, ADR 0414), or null while it loads: every handle is refreshed once it has. */
  private dataTexture(p: string): Texture | null {
    const ready = this.waiting.has(p) ? undefined : () => {
      this.waiting.delete(p);
      this.refresh();
    };
    const t = this.deps.library.texture(p, "graphData", ready);
    if (!t && ready) this.waiting.add(p);
    return t;
  }

  /** The scene's 2D lighting rig, watched: a new layout refreshes every handle. */
  private watch(): BabylonLights2D | undefined {
    const rig = lights2DOf(this.deps.scene);
    if (rig !== this.rig) {
      this.observer?.remove();
      this.rig = rig;
      this.observer = rig ? rig.onLayoutChange.add(() => this.refresh()) : null;
    }
    return rig;
  }

  /** The rig's layout changed or a map loaded: setups are made again, and every handle picks its material again. */
  private refresh(): void {
    if (this.disposed) return;
    this.setups.clear();
    for (const h of [...this.handles]) h.refresh();
  }
}

/** The albedo tint, sRGB to linear (what the PBR albedo multiplies). */
function tint(m: PBRMaterial, t: Tint2D | undefined): void {
  const c = t ?? WHITE;
  m.albedoColor.set(c.r, c.g, c.b).toLinearSpaceToRef(m.albedoColor);
  m.alpha = clamp01(c.a);
}

class Handle implements Material2D {
  material!: Material;
  normalMapped = false;
  private request: Material2DRequest | null = null;
  private key = "";
  private sharedKey: string | null = null;
  private own: Built | null = null;
  private released = false;

  constructor(
    private readonly owner: BabylonMaterials2D,
    private readonly onChange: (() => void) | null,
  ) {}

  update(request: Material2DRequest): void {
    if (this.released) return;
    this.request = request;
    const r = this.owner.resolve(request);
    this.normalMapped = !!r.lit?.normal;
    if (r.key === this.key) {
      if (this.own) {
        tint(this.own.material, request.tint);
        if (this.own.mask && request.mask) this.own.mask.mask.uv = Array.from(request.mask.uv);
      }
      return;
    }
    const before = this.material as Material | undefined;
    const oldShared = this.sharedKey, oldOwn = this.own;
    this.key = r.key;
    if (r.shared) {
      this.material = this.owner.acquireShared(r, request).material;
      this.sharedKey = r.key;
      this.own = null;
    } else {
      this.own = this.owner.build(`2d:${r.key}`, r, request);
      this.material = this.own.material;
      this.sharedKey = null;
    }
    // After acquiring, so an unchanged shared key keeps its material alive.
    if (oldShared !== null) this.owner.releaseShared(oldShared);
    oldOwn?.dispose();
    if (before !== undefined && before !== this.material) this.onChange?.();
  }

  /** Pick the material again for the same request (the rig's layout changed, or a map loaded). */
  refresh(): void {
    if (this.request) this.update(this.request);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.sharedKey !== null) this.owner.releaseShared(this.sharedKey);
    this.own?.dispose();
    this.sharedKey = null;
    this.own = null;
    this.owner.forget(this);
  }
}
