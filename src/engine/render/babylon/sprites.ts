/**
 * The Babylon backend's sprite feature (ADR 0014, 0040, 0108, 0115, 0130): SpriteRenderers drawn as
 * thin-instance batches, or each as a quad batch of its own (ADR 0450: 9-sliced and tiled slices, graph-shaded sprites
 * and the editor's scene view). Shares nothing with the renderer but what `BabylonSpriteHost` hands it; materials, lit
 * or not, are the 2D materials' (`materials2D.ts`, ADR 0418), and every sprite's place is the quad host's (`place`), the
 * one rule 2D draws sort, pick and warn about unknown layers by (ADR 0440, 0445, 0450).
 */
import type { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { Component } from "../../core/Component";
import type { World } from "../../core/World";
import { Assets } from "../../scene/Assets";
import { authoredSize, splitSpriteRef } from "../../scene/importSettings";
import { Camera, SpriteRenderer } from "../components";
import { snapToGrid } from "../pixelPerfect";
import type { QuadBatch } from "../quadBatches";
import { spriteClaimed } from "../spriteClaims";
import { MAX_TILE_QUADS, SPRITE_GRID_INDICES, spriteFrame, spriteMeshData, type SpriteFrame } from "../spriteFrame";
import type { BabylonFeature, DrawnNode, FeatureSyncContext } from "./feature";
import { SpriteBatcher, type SpriteItem } from "./layeredQuads";
import type { BabylonMaterials2D, Material2D } from "./materials2D";
import type { BabylonQuadBatches } from "./quadBatches";

/** @internal What the sprite feature needs from the renderer. */
export interface BabylonSpriteHost {
  /** Babylon scene (left-handed, +Y up, +Z forward). */
  readonly scene: Scene;
  /** The project's pixels per unit (`render.pixelsPerUnit`): a slice's default scale, and the pixel snapping step. */
  pixelsPerUnit(): number;
  /**
   * The renderer's quad batches (ADR 0136, 0450): a lone sprite's batch, and every sprite's place (`place`, `ySorted`:
   * the project's sorting layers, y-sorted layers and the one unknown-layer warning).
   */
  readonly quads: Pick<BabylonQuadBatches, "createBatch" | "meshOf" | "place" | "ySorted">;
  /**
   * A colour texture asset if loaded (sampled again if its import settings changed), else null: it starts loading and
   * `onReady` runs once it has (the material library's `texture`).
   */
  texture(path: string, onReady?: () => void): Texture | null;
  /** The 2D materials (ADR 0418): every batched sprite's material, and whether a material is graph-shaded. */
  readonly materials2D: BabylonMaterials2D;
  /**
   * `perObject`: a quad batch per sprite, for the editor's scene view and editor play mode (picking and
   * outlines use them). `batched`: plain sprites batch (ADR 0108, 0129). Read each sync.
   */
  drawPolicy(): "batched" | "perObject";
  /** Logs a warning once per key. */
  warnOnce(key: string, message: string): void;
}

interface SpriteEntry {
  /** Its own quad batch (ADR 0450): the editor's scene view, sliced and tiled slices and graph-shaded sprites; other sprites batch (ADR 0108). */
  batch: QuadBatch | null;
  /** The batched sprite's material (ADR 0418, the batcher's); null while it has a batch of its own or wasn't shown yet. */
  look: Material2D | null;
  /** What the batcher draws for it (ADR 0108), null while hidden. */
  item: SpriteItem | null;
  spritePath: string | null;
  texture: Texture | null;
  /** What its own batch's geometry was made from, as a key (null: not made yet). */
  geometry: string | null;
  /** Size in node units (before the node's scale), once the texture has loaded. */
  size: [number, number] | null;
  /** The world matrix the quad was last given, or null before the first sync. */
  matrix: Matrix | null;
  /** Its place (the quad host's `place`: the draw order, plus its height in a y-sorted layer, ADR 0440), as last drawn. */
  order: number;
}

const tmpMatrix = new Matrix();
const tmpSpriteA = new Matrix();
const tmpSpriteB = new Matrix();
const tmpSpriteC = new Matrix();
const tmpColor = new Color3();
/** The 4 × 4 grid's indices as a batch takes them: one array, so a 9-slice that changes moves its vertices in place. */
const GRID_INDICES = Uint32Array.from(SPRITE_GRID_INDICES);
const WHOLE_FRAME: SpriteFrame = { uv: null, size: [1, 1], pivot: [0.5, 0.5], border: null, fill: "stretch", pixelsPerUnit: 1, pixelSize: [1, 1], missingSlice: false };

/** @internal Draws the World's SpriteRenderers (the Sprites plugin's feature, ADR 0140). */
export class BabylonSprites implements BabylonFeature {
  private readonly sprites = new Map<SpriteRenderer, SpriteEntry>();
  /** Sprites batched per texture run (ADR 0108); the editor's scene view keeps a quad batch per sprite. */
  private readonly batcher: SpriteBatcher;
  /** A sprite changed since the batcher was last given them. */
  private spritesDirty = true;

  constructor(private readonly host: BabylonSpriteHost) {
    this.batcher = new SpriteBatcher(host.scene);
  }

  /** Step 8: mirror the World's sprites into Babylon. */
  sync(world: World, _ctx?: FeatureSyncContext): void {
    const snap = this.spriteSnap(world);
    for (const s of world._componentsOfType(SpriteRenderer)) this.syncSprite(world, s, snap);
    this.flushSprites();
  }

  release(c: Component): void {
    if (!(c instanceof SpriteRenderer)) return;
    const e = this.sprites.get(c);
    if (e) {
      e.batch?.dispose();
      e.look?.release();
      this.sprites.delete(c);
      this.spritesDirty = true;
    }
  }

  /**
   * ADR 0276: the sprites drawn now: a sprite with a batch of its own (the editor's scene view, sliced and
   * tiled ones) as its quad, a batched one with no shape; each at its place, with its size once known.
   */
  *drawn(): Iterable<DrawnNode> {
    for (const [component, e] of this.sprites) {
      const mesh = e.batch ? this.host.quads.meshOf(e.batch) : null;
      const shown = e.batch ? !!mesh?.isEnabled() : e.item !== null;
      if (!shown) continue;
      yield { component, shape: mesh ? { kind: "quad", mesh } : null, order: e.order, size: e.size };
    }
  }

  dispose(): void {
    for (const e of this.sprites.values()) {
      e.batch?.dispose();
      e.look?.release();
    }
    this.sprites.clear();
    this.batcher.dispose();
  }

  private syncSprite(world: World, s: SpriteRenderer, snap: number): void {
    let entry = this.sprites.get(s);
    if (!entry) {
      entry = { batch: null, look: null, item: null, spritePath: null, texture: null, geometry: null, size: null, matrix: null, order: 0 };
      this.sprites.set(s, entry);
      this.spritesDirty = true;
    }
    const { path: image, slice } = splitSpriteRef(s.sprite);
    if (entry.spritePath !== s.sprite) {
      entry.spritePath = s.sprite;
      const requested = s.sprite;
      const tex = image
        ? this.host.texture(image, () => {
            if (entry!.spritePath === requested) entry!.spritePath = null; // re-resolve next sync
          })
        : null;
      entry.texture = tex;
      if (tex) tex.hasAlpha = true; // Babylon reads a texture's alpha only when told it has one
      this.spritesDirty = true;
    }
    // A sidecar rewritten since the texture loaded (the editor's import settings): sample it anew.
    if (entry.texture && image) this.host.texture(image);

    const ready = !s.sprite || !!entry.texture;
    // A skinned slice under a Skeleton2D is another feature's to draw (ADR 0371, `spriteClaims.ts`).
    const visible = s.isActiveAndEnabled && ready && !spriteClaimed(s);
    if (!visible) {
      entry.batch?.setVisible(false);
      if (entry.item) this.spritesDirty = true;
      entry.item = null;
      return;
    }

    let w = 1, h = 1, px = 0.5, py = 0.5;
    let frame: SpriteFrame | null = null;
    let texSize: { width: number; height: number } | null = null;
    if (entry.texture) {
      const base = entry.texture.getBaseSize();
      const settings = Assets.importSettings(image);
      const [aw, ah] = authoredSize(settings, base.width, base.height); // a build may have shrunk the image (ADR 0119)
      texSize = { width: aw, height: ah };
      frame = spriteFrame(settings, slice, texSize.width, texSize.height, { component: s.pixelsPerUnit, project: this.host.pixelsPerUnit() }, s.size);
      [w, h] = frame.size;
      [px, py] = frame.pivot;
      if (frame.missingSlice) this.host.warnOnce(`slice|${s.sprite}`, `${image} has no slice named "${slice}" (in ${image}.meta.json); drawing the whole image.`);
    } else if (s.size) {
      w = s.size.x;
      h = s.size.y;
    }
    entry.size = entry.texture || s.size ? [w, h] : null;

    // A quad batch of its own with editor tools (picking and outlines), or for a 9-sliced or tiled slice
    // (ADR 0115), whose grid the batcher's quads can't draw; plain sprites batch (ADR 0108).
    // A sprite shaded by a sprite graph (ADR 0415) draws on its own too: the batcher's material is the plain one.
    const own = this.host.drawPolicy() === "perObject" || this.host.materials2D.shadedByGraph(s.material) || !!(frame && (frame.border || frame.fill === "tile"));
    if (own && !entry.batch) {
      entry.batch = this.host.quads.createBatch(`sprite:${s.node.name}`, { own: true });
      entry.geometry = null;
      entry.matrix = null;
      entry.look?.release(); // the batch has its own material
      entry.look = null;
    } else if (!own && entry.batch) {
      entry.batch.dispose();
      entry.batch = null;
      entry.matrix = null;
    }

    // Its sort point is the node's world position (the pivot), Unity's default (ADR 0440).
    const e = s.node.entity;
    const y = world.worldMatrix(e)[e * 16 + 13];
    const c = s.color;
    const batch = entry.batch;
    if (batch) {
      if (entry.item) this.spritesDirty = true; // drawn by its own batch now
      entry.item = null;
      batch.setOrder(s.sortingLayer, s.orderInLayer, { y });
      entry.order = batch.place;
      batch.setMaterial(s.material); // asked again each sync: a material or graph edited since takes effect
      batch.setTint(c, c.a); // its own material takes the tint in place
      this.setSpriteGeometry(entry, batch, image, frame ?? WHOLE_FRAME, texSize?.width ?? 1, texSize?.height ?? 1);
      batch.setVisible(true);
    } else {
      const order = (entry.order = this.host.quads.place(s.sortingLayer, s.orderInLayer, { y }));
      const ySorted = this.host.quads.ySorted(s.sortingLayer);
      // A batch's material is white, tinted by the instance colour.
      const request = { texture: image, material: s.material, sortingLayer: s.sortingLayer, instanced: true };
      if (entry.look) entry.look.update(request);
      else entry.look = this.host.materials2D.acquire(request);
      const material = entry.look.material;
      const item = (entry.item ??= { material, order, ySorted, matrix: new Float32Array(16), color: [1, 1, 1, 1], uvRect: [0, 0, 1, 1] });
      // The batch's instance colour multiplies the (white) albedo: linear, like the albedo colour.
      tmpColor.set(c.r, c.g, c.b).toLinearSpaceToRef(tmpColor);
      if (item.color[0] !== tmpColor.r || item.color[1] !== tmpColor.g || item.color[2] !== tmpColor.b || item.color[3] !== c.a || item.order !== order || item.ySorted !== ySorted || item.material !== material) {
        item.color[0] = tmpColor.r;
        item.color[1] = tmpColor.g;
        item.color[2] = tmpColor.b;
        item.color[3] = c.a;
        item.order = order;
        item.ySorted = ySorted;
        item.material = material;
        this.spritesDirty = true;
      }
      const [u0, v0, u1, v1] = frame?.uv ?? [0, 0, 1, 1];
      const r = item.uvRect;
      if (r[0] !== u0 || r[1] !== v0 || r[2] !== u1 - u0 || r[3] !== v1 - v0) {
        r[0] = u0;
        r[1] = v0;
        r[2] = u1 - u0;
        r[3] = v1 - v0;
        this.spritesDirty = true;
      }
    }

    // Scale the unit quad to size with the pivot at the node's origin (flips mirror about it).
    // Without allocating, and given again only when it changed: freezing recomputes the bounds.
    Matrix.TranslationToRef(0.5 - px, 0.5 - py, 0, tmpSpriteA);
    Matrix.ScalingToRef(s.flipX ? -w : w, s.flipY ? -h : h, 1, tmpSpriteB);
    tmpSpriteA.multiplyToRef(tmpSpriteB, tmpSpriteC);
    Matrix.FromArrayToRef(world.worldMatrix(e) as unknown as number[], e * 16, tmpMatrix);
    if (snap > 0) {
      // A pixel-perfect camera's pixel snapping (ADR 0108): the node's position on the texel grid.
      const m = tmpMatrix.m as unknown as number[];
      tmpMatrix.setTranslationFromFloats(snapToGrid(m[12], snap), snapToGrid(m[13], snap), m[14]);
    }
    tmpSpriteC.multiplyToRef(tmpMatrix, tmpSpriteA);
    if (entry.matrix?.equals(tmpSpriteA)) return;
    entry.matrix ??= new Matrix();
    entry.matrix.copyFrom(tmpSpriteA);
    if (batch) batch.setMatrix(entry.matrix.m);
    else {
      entry.matrix.copyToArray(entry.item!.matrix);
      this.spritesDirty = true;
    }
  }

  /**
   * A lone sprite's quad (ADR 0115, 0450): a 4 × 4 vertex grid in the unit quad, so a slice's 9-slice border can move the
   * inner lines (or its tiles), drawing `image`; given to its batch again only when what it's made from changed.
   */
  private setSpriteGeometry(entry: SpriteEntry, batch: QuadBatch, image: string, frame: SpriteFrame, texWidth: number, texHeight: number): void {
    const key = `${image}|${frame.uv?.join(",") ?? ""}|${frame.border?.join(",") ?? ""}|${frame.fill}|${frame.size.join(",")}|${frame.pixelsPerUnit}|${texWidth}x${texHeight}`;
    if (key === entry.geometry) return;
    entry.geometry = key;
    const grid = spriteMeshData(frame, texWidth, texHeight);
    if (grid.tileCapped) this.host.warnOnce(`tiles|${entry.spritePath}`, `sprite "${entry.spritePath}" would need more than ${MAX_TILE_QUADS} tiles; drawing it stretched. Use a bigger tile or a smaller sprite.`);
    const indices = grid.indices === SPRITE_GRID_INDICES ? GRID_INDICES : Uint32Array.from(grid.indices);
    batch.setQuads(image, Float32Array.from(grid.positions), Float32Array.from(grid.uvs), indices);
  }

  /** After syncing sprites: hand the batcher this frame's sprites when any changed (ADR 0108). */
  private flushSprites(): void {
    if (!this.spritesDirty) return;
    this.spritesDirty = false;
    const items: SpriteItem[] = [];
    for (const e of this.sprites.values()) if (e.item && !e.batch) items.push(e.item); // sprites with a batch of their own draw with it
    this.batcher.update(items);
  }

  /** The texel step sprites snap to this frame: a pixel-perfect view camera with pixel snapping, else 0. */
  private spriteSnap(world: World): number {
    // As `viewCameras` picks, without needing the camera synced yet (sprites sync first).
    const view = world._componentsOfType(Camera).filter((c) => c.isActiveAndEnabled && !world.inEditMode(c.node.entity)).sort((a, b) => a.depth - b.depth)[0];
    if (!view || !view.pixelPerfect || !view.pixelSnapping || view.projection !== "orthographic") return 0;
    const ppu = this.host.pixelsPerUnit();
    return ppu > 0 ? 1 / ppu : 0;
  }
}
