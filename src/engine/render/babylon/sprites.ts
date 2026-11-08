/**
 * The Babylon backend's sprite feature (ADR 0014, 0040, 0108, 0115, 0130): SpriteRenderers drawn as
 * thin-instance batches, or as a mesh each (9-sliced and tiled slices, and the editor's scene view).
 * Shares nothing with the renderer but what `BabylonSpriteHost` hands it.
 */
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Matrix } from "@babylonjs/core/Maths/math.vector.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { Component } from "../../core/Component";
import type { World } from "../../core/World";
import { Assets } from "../../scene/Assets";
import type { GameObject } from "../../scene/GameObject";
import { authoredSize, splitSpriteRef } from "../../scene/importSettings";
import { Camera, SpriteRenderer } from "../components";
import { snapToGrid } from "../pixelPerfect";
import type { RenderFeatureSpec } from "../renderFeatures";
import { MAX_TILE_QUADS, SPRITE_GRID_INDICES, spriteFrame, spriteMeshData, type SpriteFrame } from "../spriteFrame";
import type { EditorSprite } from "./editorContext";
import type { BabylonFeature, FeatureSyncContext } from "./feature";
import { pbr } from "./materials";
import { SpriteBatcher, type SpriteItem } from "./spriteBatches";

/** @internal The sprite feature's spec (ADR 0130). */
export const SPRITES_SPEC: RenderFeatureSpec = { name: "sprites", phase: "content", types: [SpriteRenderer], lazy: false };

/** @internal What the sprite feature needs from the renderer. */
export interface BabylonSpriteHost {
  /** Babylon scene (right-handed, +Y up). */
  readonly scene: Scene;
  /** The project's pixels per unit (`render.pixelsPerUnit`): a slice's default scale, and the pixel snapping step. */
  pixelsPerUnit(): number;
  /** The project's sorting layers, bottom to top (`render.sortingLayers`). */
  sortingLayers(): readonly string[];
  /** Loads a colour texture asset (the material library's `texture(path)`). */
  texture(path: string): Promise<Texture>;
  /** A colour texture asset if already loaded, else null (the material library's `loadedTexture(path)`). */
  loadedTexture(path: string): Texture | null;
  /**
   * `perObject`: a mesh per sprite, for the editor's scene view and editor play mode (picking and
   * outlines use them). `batched`: plain sprites batch (ADR 0108, 0129). Read each sync.
   */
  drawPolicy(): "batched" | "perObject";
  /** Logs a warning once per key. */
  warnOnce(key: string, message: string): void;
}

interface SpriteEntry {
  /** Its own quad and material: the editor's scene view only (picking and outlines); other Worlds batch (ADR 0108). */
  mesh: Mesh | null;
  material: PBRMaterial | null;
  /** What the batcher draws for it (ADR 0108), null while hidden. */
  item: SpriteItem | null;
  spritePath: string | null;
  texture: Texture | null;
  /** The UVs the quad has, as a key ("" for the whole texture). */
  uvKey: string;
  /** The mesh's vertex count (16 for the 9-slice grid; more when tiled). */
  vertexCount: number;
  /** Size in node units (before the node's scale), once the texture has loaded. */
  size: [number, number] | null;
  /** The world matrix the quad is frozen at (Babylon keeps it), or null before the first sync. */
  matrix: Matrix | null;
}

const tmpMatrix = new Matrix();
const tmpSpriteA = new Matrix();
const tmpSpriteB = new Matrix();
const tmpSpriteC = new Matrix();
const tmpColor = new Color3();
const SPRITE_GRID_NORMALS = Array.from({ length: 16 }, () => [0, 0, 1]).flat();
const WHOLE_FRAME: SpriteFrame = { uv: null, size: [1, 1], pivot: [0.5, 0.5], border: null, fill: "stretch", pixelsPerUnit: 1, pixelSize: [1, 1], missingSlice: false };

/** @internal Draws the World's SpriteRenderers. */
export class BabylonSprites implements BabylonFeature {
  private readonly sprites = new Map<SpriteRenderer, SpriteEntry>();
  /** Sprites batched per texture run (ADR 0108); the editor's scene view keeps a mesh per sprite. */
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
      e.mesh?.dispose();
      e.material?.dispose();
      this.sprites.delete(c);
      this.spritesDirty = true;
    }
  }

  /** The nodes with a sprite drawn now (`RenderDiagnostics.drawn.sprites`). */
  drawnNodes(): GameObject[] {
    const nodes = new Set<GameObject>();
    for (const [s, e] of this.sprites) if (e.mesh ? e.mesh.isEnabled() : e.item) nodes.add(s.node);
    return [...nodes];
  }

  dispose(): void {
    for (const e of this.sprites.values()) {
      e.mesh?.dispose();
      e.material?.dispose();
    }
    this.sprites.clear();
    this.batcher.dispose();
  }

  /** The sprites with a mesh of their own, for the editor tools (picking and outlines). */
  *editorSprites(): Iterable<EditorSprite> {
    for (const [component, e] of this.sprites) if (e.mesh) yield { component, mesh: e.mesh, size: e.size, order: this.sortOrder(component.sortingLayer, component.orderInLayer) };
  }

  /** Draw order: `sortingLayer` index × 10000 + `orderInLayer`. */
  sortOrder(layer: string, order: number): number {
    let index = this.host.sortingLayers().indexOf(layer);
    if (index < 0) {
      this.host.warnOnce(`layer|${layer}`, `unknown sorting layer "${layer}"; add it to project settings render.sortingLayers.`);
      index = 0;
    }
    return index * 10000 + order;
  }

  /** The sprite's size in node units once its texture has loaded. */
  spriteSize(s: SpriteRenderer): [number, number] | null {
    if (s.size) return [s.size.x, s.size.y];
    return this.sprites.get(s)?.size ?? null;
  }

  private syncSprite(world: World, s: SpriteRenderer, snap: number): void {
    let entry = this.sprites.get(s);
    if (!entry) {
      entry = { mesh: null, material: null, item: null, spritePath: null, texture: null, uvKey: "", vertexCount: 16, size: null, matrix: null };
      this.sprites.set(s, entry);
      this.spritesDirty = true;
    }
    const { path: image, slice } = splitSpriteRef(s.sprite);
    if (entry.spritePath !== s.sprite) {
      entry.spritePath = s.sprite;
      const tex = image ? this.host.loadedTexture(image) : null;
      entry.texture = tex;
      if (tex) tex.hasAlpha = true; // Babylon reads a texture's alpha only when told it has one
      if (entry.material) entry.material.albedoTexture = tex;
      this.spritesDirty = true;
      if (image && !tex) {
        const requested = s.sprite;
        this.host
          .texture(image)
          .then(() => {
            if (entry!.spritePath === requested) entry!.spritePath = null; // re-resolve next sync
          })
          .catch((err) => console.error(`[myco] failed to load texture "${image}":`, err));
      }
    }
    // A sidecar rewritten since the texture loaded (the editor's import settings): sample it anew.
    if (entry.texture && image) this.host.loadedTexture(image);

    const ready = !s.sprite || !!entry.texture;
    const visible = s.isActiveAndEnabled && ready;
    if (!visible) {
      entry.mesh?.setEnabled(false);
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

    // A mesh of its own with editor tools (picking and outlines), or for a 9-sliced or tiled slice
    // (ADR 0115), whose grid the batcher's quads can't draw; plain sprites batch (ADR 0108).
    const own = this.host.drawPolicy() === "perObject" || !!(frame && (frame.border || frame.fill === "tile"));
    if (own && !entry.mesh) this.makeSpriteMesh(s, entry);
    else if (!own && entry.mesh) {
      entry.mesh.dispose();
      entry.material?.dispose();
      entry.mesh = entry.material = null;
      entry.matrix = null;
    }
    const { mesh, material } = entry;
    if (mesh) {
      mesh.setEnabled(true);
      if (entry.item) this.spritesDirty = true; // drawn by its own mesh now
      entry.item = null;
    }

    const order = this.sortOrder(s.sortingLayer, s.orderInLayer);
    const c = s.color;
    if (material) {
      material.albedoColor.set(c.r, c.g, c.b).toLinearSpaceToRef(material.albedoColor);
      material.alpha = c.a;
      mesh!.alphaIndex = order;
      if (frame && texSize) this.setSpriteGeometry(entry, frame, texSize.width, texSize.height);
    } else {
      const item = (entry.item ??= { texture: null, order, matrix: new Float32Array(16), color: [1, 1, 1, 1], uvRect: [0, 0, 1, 1] });
      // The batch's instance colour multiplies the (white) albedo: linear, like the albedo colour.
      tmpColor.set(c.r, c.g, c.b).toLinearSpaceToRef(tmpColor);
      if (item.color[0] !== tmpColor.r || item.color[1] !== tmpColor.g || item.color[2] !== tmpColor.b || item.color[3] !== c.a || item.order !== order || item.texture !== entry.texture) {
        item.color[0] = tmpColor.r;
        item.color[1] = tmpColor.g;
        item.color[2] = tmpColor.b;
        item.color[3] = c.a;
        item.order = order;
        item.texture = entry.texture;
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
    const e = s.node.entity;
    // Without allocating, and frozen again only when it changed: freezing recomputes the bounds.
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
    if (mesh) mesh.freezeWorldMatrix(entry.matrix);
    else {
      entry.matrix.copyToArray(entry.item!.matrix);
      this.spritesDirty = true;
    }
  }

  /** A sprite's own quad and material: a 4 × 4 vertex grid, so a slice's 9-slice border can move the inner lines (ADR 0115). */
  private makeSpriteMesh(s: SpriteRenderer, entry: SpriteEntry): void {
    const scene = this.host.scene;
    const mesh = new Mesh(`sprite:${s.node.name}`, scene);
    const data = new VertexData();
    const grid = spriteMeshData(WHOLE_FRAME, 1, 1);
    data.positions = grid.positions;
    data.normals = SPRITE_GRID_NORMALS;
    data.uvs = grid.uvs;
    data.indices = SPRITE_GRID_INDICES as number[];
    data.applyToMesh(mesh, true);
    const material = pbr(`sprite:${s.node.name}`, scene);
    material.unlit = true;
    material.backFaceCulling = false; // flipped sprites mirror their quad
    material.disableDepthWrite = true;
    material.depthFunction = Constants.ALWAYS; // sprites draw in layer order, not by depth (ADR 0014)
    material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    material.useAlphaFromAlbedoTexture = true;
    material.albedoTexture = entry.texture;
    mesh.material = material;
    mesh.alwaysSelectAsActiveMesh = true;
    entry.mesh = mesh;
    entry.material = material;
    entry.uvKey = "";
    entry.vertexCount = 16;
    entry.matrix = null;
  }

  /** Draw a slice's part of the texture (9-sliced when it has a border), or the whole texture, on the sprite's own mesh. */
  private setSpriteGeometry(entry: SpriteEntry, frame: SpriteFrame, texWidth: number, texHeight: number): void {
    const mesh = entry.mesh;
    if (!mesh) return;
    const key = frame.uv || frame.border || frame.fill === "tile" ? `${frame.uv?.join(",") ?? ""}|${frame.border?.join(",") ?? ""}|${frame.fill}|${frame.size.join(",")}|${frame.pixelsPerUnit}|${texWidth}x${texHeight}` : "";
    if (key === entry.uvKey) return;
    entry.uvKey = key;
    const grid = spriteMeshData(frame, texWidth, texHeight);
    if (grid.tileCapped) this.host.warnOnce(`tiles|${entry.spritePath}`, `sprite "${entry.spritePath}" would need more than ${MAX_TILE_QUADS} tiles; drawing it stretched. Use a bigger tile or a smaller sprite.`);
    if (grid.indices === SPRITE_GRID_INDICES && entry.vertexCount === 16) {
      mesh.updateVerticesData(VertexBuffer.PositionKind, grid.positions);
      mesh.updateVerticesData(VertexBuffer.UVKind, grid.uvs);
      return;
    }
    // A different vertex count (tiling): replace the buffers and indices.
    const count = grid.positions.length / 3;
    entry.vertexCount = count;
    mesh.setVerticesData(VertexBuffer.PositionKind, grid.positions, true);
    mesh.setVerticesData(VertexBuffer.NormalKind, Array.from({ length: count }, () => [0, 0, 1]).flat());
    mesh.setVerticesData(VertexBuffer.UVKind, grid.uvs, true);
    mesh.setIndices(grid.indices);
  }

  /** After syncing sprites: hand the batcher this frame's sprites when any changed (ADR 0108). */
  private flushSprites(): void {
    if (!this.spritesDirty) return;
    this.spritesDirty = false;
    const items: SpriteItem[] = [];
    for (const e of this.sprites.values()) if (e.item && !e.mesh) items.push(e.item); // sprites with a mesh of their own draw with it
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
