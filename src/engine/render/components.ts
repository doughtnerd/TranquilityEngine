/**
 * Render components (ADR 0004, 0010, 0014). Engine-native: none of these expose the renderer.
 * The render backend mirrors them into Babylon.js objects each frame (ADR 0075, 0081).
 */
import { Component } from "../core/Component";
import { Color, Quaternion, Ray, Vector2, Vector3 } from "../core/math";
import { AssetRef, PlainObject, component, field } from "../core/registry";
import { World } from "../core/World";
import { pixelCenterOffset, pixelPerfectView } from "./pixelPerfect";
import type { PixelGrid } from "./RenderSurface";
import { Material } from "./Material";
import { modelVariantsIfLoaded } from "../scene/models";
import { sampleLights2D } from "./lights2D/sample";

/** Draws a textured quad (ADR 0014). */
@component("engine.SpriteRenderer")
export class SpriteRenderer extends Component {
  /** Asset path of the texture. Empty draws a plain colored quad. */
  @field(AssetRef, { kind: "sprite" }) sprite = "";
  @field(Color) color = Color.white;
  /** Size in world units. When null, the texture's pixel size / pixelsPerUnit is used. */
  @field(Vector2) size: Vector2 | null = null;
  /** Overrides the project's pixels-per-unit when > 0. */
  @field(Number) pixelsPerUnit = 0;
  @field(Boolean) flipX = false;
  @field(Boolean) flipY = false;
  /** Sorting layer name from project settings (back to front). */
  @field(String, { choices: (s) => s.render.sortingLayers }) sortingLayer = "Default";
  @field(Number) orderInLayer = 0;
  /**
   * A sprite material asset (ADR 0399: shader `"sprite-lit"` or `"sprite-unlit"`). Empty: the default, Sprite Lit, which
   * draws unlit while the World has no 2D lights.
   */
  @field(AssetRef, { kind: "material", description: "A Sprite Lit or Sprite Unlit material asset. Empty: Sprite Lit, lit by 2D lights when the World has any." }) material = "";

  override _onDetach(): void {
    this._world.render?.release(this);
  }
}

export type Light2DType = "global" | "point" | "freeform" | "sprite";
/** How a 2D light lights normal maps (ADR 0415): not at all, by its batch's averaged direction, or per light (point lights, high tier). */
export type Light2DNormals = "off" | "fast" | "accurate";
/** How a 2D light meets the light below it in its light texture (ADR 0415, Unity's overlap operation). */
export type Light2DOverlap = "additive" | "alphaBlend";

/**
 * A 2D light (ADR 0399): lights the layered 2D draws (sprites, tiles, 2D decals, 2D lines, skinned sprites) whose
 * material is Sprite Lit, on its target sorting layers, through one of the project's light blend styles. Global lights
 * fill their layers with a flat colour; point lights (a spot when their angles are under 360°) fall off between two
 * radii; freeform lights fill a polygon with a falloff band outside it; sprite lights are shaped and coloured by a
 * sprite. A 2D light lights no mesh, and a 3D `Light` no 2D draw.
 */
@component("engine.Light2D")
export class Light2D extends Component {
  @field(String, { choices: ["global", "point", "freeform", "sprite"] }) type: Light2DType = "point";
  @field(Color) color = Color.white;
  @field(Number, { description: "How bright the light is (no upper limit: light textures are HDR)." }) intensity = 1;
  @field(String, { choices: (s) => s.lighting2D.blendStyles.map((b) => b.name), description: "Which of the project's blend styles it lights through." }) blendStyle = "Multiply";
  @field([String], { choices: (s) => s.render.sortingLayers, description: "The sorting layers it lights. Empty: every sorting layer." }) targetSortingLayers: string[] = [];
  /** Point: full brightness inside this radius, in world units. */
  @field(Number) innerRadius = 0;
  /** Point: no light past this radius, in world units. */
  @field(Number) outerRadius = 3;
  /** Point: the full-brightness cone's full angle in degrees, along the node's +Y (360: all round). */
  @field(Number) innerAngle = 360;
  /** Point: the cone's full angle in degrees, past which there's no light (360: all round). */
  @field(Number) outerAngle = 360;
  /** Point: the falloff's shape, 0 (linear) to 1 (sharp, most light near the inner radius). */
  @field(Number) falloff = 0.5;
  /** Freeform: the lit polygon, in the node's local XY. */
  @field([Vector2]) shape: Vector2[] = [new Vector2(-1, -1), new Vector2(1, -1), new Vector2(1, 1), new Vector2(-1, 1)];
  /** Freeform: how far the light fades out past the polygon, in world units. */
  @field(Number) falloffSize = 0.5;
  /** Sprite: the sprite whose colour and alpha shape the light, at its size (like a SpriteRenderer's). */
  @field(AssetRef, { kind: "sprite" }) sprite = "";
  /**
   * How it lights lit sprites' normal maps (their sidecar's `normalMap`, ADR 0414). Off: flat. Fast: by the direction of
   * its layer batch's lights, averaged. Accurate (ADR 0415): per light, for point lights on tiers that allow it (high);
   * elsewhere as fast.
   */
  @field(String, { choices: ["off", "fast", "accurate"] }) normalMaps: Light2DNormals = "off";
  /** With `normalMaps`: the light's height above the sprites' plane, in world units (low: grazing light). */
  @field(Number) height = 1;
  /**
   * How it meets the lights below it (ADR 0415): added to them, or blended over them by its own falloff (an alpha blend
   * light replaces what's under its core). Lights in a texture draw additive first, then alpha blend in scene order.
   */
  @field(String, { choices: ["additive", "alphaBlend"] }) overlap: Light2DOverlap = "additive";
  /**
   * A visible glow of the light itself (ADR 0415; 0: none): its shape drawn additively over its target layers' sprites,
   * at this share of its intensity. Not for global lights; unshadowed.
   */
  @field(Number) volumeIntensity = 0;
  /** Shadows from ShadowCaster2Ds (ADR 0413). */
  @field(Boolean) shadows = false;
  /** How dark its shadows are, 0 (none) to 1 (no light). */
  @field(Number) shadowStrength = 1;
  @field([String], { choices: (s) => s.lighting2D.shadowLayers, description: "The shadow layers whose casters shadow it (ADR 0415). Empty: every caster." }) shadowMask: string[] = [];
  /** How soft its shadows' edges are, 0 (hard) to 1, on qualities with soft shadows (ADR 0400). */
  @field(Number) shadowSoftness = 0.3;

  /**
   * The light the current World's 2D lights give at `point` (world units) on sorting layer `sortingLayer`, through blend
   * style `blendStyle` (default the first), as linear RGB: every enabled light's colour × intensity × falloff, shadows
   * included, without normal maps (flat). For gameplay, such as how visible a character is; computed on the CPU from
   * the lights' fields, the same rule the light pass draws by. A sprite light counts as its rectangle.
   */
  static sampleAt(point: Vector2 | Vector3, sortingLayer = "Default", blendStyle?: string): Color {
    return sampleLights2D(World.require(), point.x, point.y, sortingLayer, blendStyle);
  }

  override _onDetach(): void {
    this._world.render?.release(this);
  }
}

export type ShadowCaster2DShape = "auto" | "collider" | "sprite" | "custom";

/**
 * Casts shadows from 2D lights with `shadows` on (ADR 0413). Its outline comes from the node's 2D collision shapes (a
 * Tilemap's merged solid tiles, its 2D colliders), its SpriteRenderer's slice outline (ADR 0414) or a custom path.
 */
@component("engine.ShadowCaster2D")
export class ShadowCaster2D extends Component {
  /** `auto`: collision shapes on the node if any, else the sprite's outline, else its rectangle. */
  @field(String, { choices: ["auto", "collider", "sprite", "custom"] }) shape: ShadowCaster2DShape = "auto";
  /** Custom: a closed outline in the node's local XY. */
  @field([Vector2]) path: Vector2[] = [];
  @field(Boolean) castShadows = true;
  /** Shadow its own interior too. Off: what lies behind it is dark and its own face stays lit. */
  @field(Boolean) selfShadows = false;
  @field([String], { choices: (s) => s.lighting2D.shadowLayers, description: "The shadow layers it's on (ADR 0415): it shadows lights whose mask shares one. Empty: every light." }) shadowMask: string[] = [];
  @field([String], { choices: (s) => s.render.sortingLayers, description: "The sorting layers whose lighting it shadows. Empty: every sorting layer." }) targetSortingLayers: string[] = [];

  override _onDetach(): void {
    this._world.render?.release(this);
  }
}

/**
 * Merges the ShadowCaster2Ds on its node and below it into one caster (ADR 0415, Unity's Composite Shadow Caster 2D):
 * their outlines cast together with these settings (their own are ignored), and edges inside another member's outline
 * don't cast, so a wall built of many pieces shadows as one.
 */
@component("engine.CompositeShadowCaster2D")
export class CompositeShadowCaster2D extends Component {
  @field(Boolean) castShadows = true;
  /** Shadow the members' interiors too. Off: what lies behind is dark and their faces stay lit. */
  @field(Boolean) selfShadows = false;
  @field([String], { choices: (s) => s.render.sortingLayers, description: "The sorting layers whose lighting it shadows. Empty: every sorting layer." }) targetSortingLayers: string[] = [];
  @field([String], { choices: (s) => s.lighting2D.shadowLayers, description: "The shadow layers it's on (ADR 0415). Empty: every light." }) shadowMask: string[] = [];
}

export type Projection = "orthographic" | "perspective";

/** Renders the scene from its node's position, looking along +Z (left-handed, ADR 0164). */
@component("engine.Camera")
export class Camera extends Component {
  @field(String, { choices: ["orthographic", "perspective"] }) projection: Projection = "orthographic";
  /** Half the vertical view size in world units (orthographic). */
  @field(Number) orthographicSize = 5;
  /** Vertical field of view in degrees (perspective). */
  @field(Number) fieldOfView = 60;
  @field(Number) near = 0.1;
  @field(Number) far = 1000;
  /** Cameras render in ascending depth order. */
  @field(Number) depth = 0;
  /** Clear color; null uses the project's display background color. */
  @field(Color) backgroundColor: Color | null = null;
  /**
   * The camera's rectangle on the canvas: the bottom-left corner as fractions of the canvas, like
   * Unity's Viewport Rect (ADR 0056). The default 0,0 / 1,1 covers the whole canvas.
   */
  @field(Vector2) viewportPosition = new Vector2(0, 0);
  /** The camera's rectangle on the canvas: its width and height as fractions of the canvas (ADR 0056). */
  @field(Vector2) viewportSize = new Vector2(1, 1);
  /**
   * Orthographic only. Zooms the view by a whole number so each sprite texel covers an integer
   * number of screen (device) pixels, and snaps the camera's position to that pixel grid (ADR 0014).
   * `orthographicSize` becomes the minimum half-height wanted.
   */
  @field(Boolean) pixelPerfect = false;
  /** With `pixelPerfect` on, sprites' world positions snap to the texel grid (1 / pixelsPerUnit units) when drawn. */
  @field(Boolean) pixelSnapping = true;
  /**
   * A render texture asset (`*.rendertexture.json`, ADR 0109) to draw into instead of the canvas.
   * Materials, sprites and UI images that name the same asset show what the camera sees (a frame
   * later: cameras drawing into textures draw after the ones on the canvas). Empty: the canvas.
   */
  @field(AssetRef, { kind: "rendertexture" }) targetTexture = "";

  /** The enabled camera with the lowest depth in the current World (ADR 0032). */
  static get main(): Camera | null {
    const cams = World.require()._componentsOfType(Camera).filter((c) => c.isActiveAndEnabled);
    return cams.sort((a, b) => a.depth - b.depth)[0] ?? null;
  }

  /**
   * The device-pixel grid the camera's maths uses (ADR 0154): the render surface's (the canvas's CSS
   * size, like `Input.mousePosition`, and the pixel ratio the surface applied), or without one
   * (headless) the project's reference resolution at ratio 1 (ADR 0073). The surface keeps the size up
   * to date, so this doesn't force a layout each call.
   */
  private pixelGrid(): PixelGrid {
    const render = this._world.render;
    if (render) {
      const grid = render.pixelGrid ? render.pixelGrid() : render.canvas ? { width: render.canvas.clientWidth, height: render.canvas.clientHeight, pixelRatio: 1 } : null;
      if (grid && grid.width > 0 && grid.height > 0) return grid;
    }
    const { width, height } = this._world.settings.display;
    return { width, height, pixelRatio: 1 };
  }

  /** The camera's rectangle in canvas pixels, origin top-left (ADR 0056). */
  private pixelRect(grid: PixelGrid = this.pixelGrid()): { x: number; y: number; width: number; height: number } {
    const { width: cw, height: ch } = grid;
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    const x = clamp(this.viewportPosition.x), y = clamp(this.viewportPosition.y);
    const w = Math.max(0.001, Math.min(clamp(this.viewportSize.x), 1 - x)), h = Math.max(0.001, Math.min(clamp(this.viewportSize.y), 1 - y));
    return { x: x * cw, y: (1 - y - h) * ch, width: w * cw, height: h * ch };
  }

  /** Width / height of the camera's viewport rectangle on the canvas (ADR 0073). */
  get aspect(): number {
    const r = this.pixelRect();
    return r.width / r.height;
  }

  /**
   * The half-height the camera's maths uses: with `pixelPerfect` on (orthographic) the integer-zoom
   * size for a view `heightPx` device pixels tall (by default its viewport's height on the view's grid;
   * the editor's camera preview passes the inset's), else `orthographicSize`.
   * @internal
   */
  _effectiveOrthographicSize(heightPx?: number): number {
    if (!this.pixelPerfect || this.projection !== "orthographic") return this.orthographicSize;
    return pixelPerfectView(heightPx ?? this._devicePixelSize().height, this.orthographicSize, this._world.settings.render.pixelsPerUnit).orthographicSize;
  }

  /**
   * The camera's rectangle in whole device pixels of the view's grid (ADR 0154: its CSS size times the
   * pixel ratio the surface applied, render scale included): what pixel-perfect zoom and snapping count.
   * @internal
   */
  _devicePixelSize(): { width: number; height: number } {
    const grid = this.pixelGrid();
    const r = this.pixelRect(grid);
    return { width: Math.round(r.width * grid.pixelRatio), height: Math.round(r.height * grid.pixelRatio) };
  }

  /**
   * Where a pixel-perfect orthographic camera's position snaps (ADR 0108, 0154): world units per device
   * pixel, and the half-pixel offsets that keep texel edges on pixel edges for an odd pixel width or
   * height. Null when it doesn't snap.
   * @internal
   */
  _pixelSnap(): { unit: number; offsetX: number; offsetY: number } | null {
    if (!this.pixelPerfect || this.projection !== "orthographic") return null;
    const px = this._devicePixelSize();
    const unit = (2 * this._effectiveOrthographicSize()) / Math.max(1, px.height);
    return { unit, offsetX: pixelCenterOffset(px.width, unit), offsetY: pixelCenterOffset(px.height, unit) };
  }

  /** The camera's world position and axes (right, up, forward = the node's +Z), ignoring scale. */
  private frame(): { position: Vector3; right: Vector3; up: Vector3; forward: Vector3 } {
    const t = this.node.transform!;
    const q = t.worldRotation;
    return { position: t.worldPosition, right: rotate(q, 1, 0, 0), up: rotate(q, 0, 1, 0), forward: rotate(q, 0, 0, 1) };
  }

  /** The ray through normalized device coordinates (-1..1, +y up) of this camera's viewport. */
  private ndcRay(nx: number, ny: number): Ray {
    const { position, right, up, forward } = this.frame();
    const aspect = this.aspect;
    if (this.projection === "orthographic") {
      const s = this._effectiveOrthographicSize();
      const origin = position.clone().addScaled(right, nx * s * aspect).addScaled(up, ny * s);
      return new Ray(origin, forward);
    }
    const tan = Math.tan((this.fieldOfView * Math.PI) / 360);
    const dir = forward.clone().addScaled(right, nx * tan * aspect).addScaled(up, ny * tan);
    return new Ray(position, dir);
  }

  /**
   * The world ray through a canvas point in pixels, origin top-left, as `Input.mousePosition`
   * (ADR 0073). Perspective rays start at the camera; orthographic rays are parallel to its view
   * direction and start on the camera's plane.
   */
  screenPointToRay(point: Vector2): Ray {
    const r = this.pixelRect();
    return this.ndcRay(((point.x - r.x) / r.width) * 2 - 1, 1 - ((point.y - r.y) / r.height) * 2);
  }

  /** Like `screenPointToRay`, from viewport coordinates 0 to 1 with the origin bottom-left, as in Unity. */
  viewportPointToRay(point: Vector2): Ray {
    return this.ndcRay(point.x * 2 - 1, point.y * 2 - 1);
  }

  /**
   * A world point's place on the canvas: x and y in pixels (origin top-left, like
   * `Input.mousePosition`), z the distance in front of the camera along its view direction (negative
   * means behind it, where x and y are mirrored and not meaningful) (ADR 0073).
   */
  worldToScreenPoint(p: Vector3): Vector3 {
    const { position, right, up, forward } = this.frame();
    const d = Vector3.sub(p, position);
    const x = Vector3.dot(d, right), y = Vector3.dot(d, up), depth = Vector3.dot(d, forward);
    const aspect = this.aspect;
    let nx: number, ny: number;
    if (this.projection === "orthographic") {
      const s = this._effectiveOrthographicSize();
      nx = x / (s * aspect);
      ny = y / s;
    } else {
      const tan = Math.tan((this.fieldOfView * Math.PI) / 360);
      const w = Math.abs(depth) < 1e-9 ? 1e-9 : depth;
      nx = x / (w * tan * aspect);
      ny = y / (w * tan);
    }
    const r = this.pixelRect();
    return new Vector3(r.x + (nx * 0.5 + 0.5) * r.width, r.y + (0.5 - ny * 0.5) * r.height, depth);
  }

  override _onDetach(): void {
    this._world.render?.release(this);
  }
}

/** Rotate the vector (x, y, z) by `q`. */
function rotate(q: Quaternion, x: number, y: number, z: number): Vector3 {
  const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
  return new Vector3(x + q.w * tx + (q.y * tz - q.z * ty), y + q.w * ty + (q.z * tx - q.x * tz), z + q.w * tz + (q.x * ty - q.y * tx));
}

export type Anchor = "top-left" | "top" | "top-right" | "left" | "center" | "right" | "bottom-left" | "bottom" | "bottom-right";

/**
 * Screen-space text, rendered inside the canvas (ADR 0020). Positioned by `anchor` and an
 * `offset` in reference-resolution pixels (+x right, +y down).
 *
 * Interim implementation: drawn to a canvas texture. ADR 0020 calls for pmndrs uikit; this
 * component keeps the same engine-facing shape so it can be re-backed without game changes.
 */
@component("engine.Text")
export class Text extends Component {
  @field(String) text = "";
  /** Font size in reference-resolution pixels. */
  @field(Number) fontSize = 32;
  @field(String) fontFamily = "system-ui, sans-serif";
  @field(String) fontWeight = "700";
  @field(Color) color = Color.white;
  @field(Color) outlineColor: Color | null = null;
  @field(Number) outlineWidth = 0;
  @field(String, { choices: ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"] }) anchor: Anchor = "center";
  @field(Vector2) offset = new Vector2(0, 0);
  @field(String, { choices: ["left", "center", "right"] }) align: "left" | "center" | "right" = "center";
  @field(Number) lineHeight = 1.2;

  override _onDetach(): void {
    this._world.render?.release(this);
  }
}

/**
 * Draws a mesh with a material (ADR 0043, 0044). `mesh` is a model asset (`asset:models/robot.fbx`
 * draws all its meshes, `asset:models/robot.fbx#Body` one of them) or a built-in mesh
 * (`builtin:cube`, `sphere`, `capsule`, `cylinder`, `plane`, `quad`). Meshes are lit by the
 * World's Lights; a World with no Light gets a default sun and ambient light.
 */
@component("engine.MeshRenderer")
export class MeshRenderer extends Component {
  @field(AssetRef, { kind: "mesh" }) mesh = "builtin:cube";
  /**
   * A material asset (`asset:materials/wood.material.json`). Empty: the model's own materials,
   * or the default material (white, lit) for meshes without one.
   */
  @field(AssetRef, { kind: "material" }) material = "";
  /**
   * A material asset per material slot (ADR 0089), drawn in place of `material` for that slot.
   * The slots are the model's own materials, in the order its meshes first use them (a built-in
   * mesh has one); an empty entry, or none, leaves the slot to `material`, then to the model's
   * import settings, then to the model's own material.
   */
  @field([AssetRef], { kind: "material" }) materials: string[] = [];
  /** Cast shadows from Lights with `castShadows` on. */
  @field(Boolean) castShadows = true;
  /** Show shadows cast onto it. */
  @field(Boolean) receiveShadows = true;
  /**
   * The model's material variant to draw (glTF `KHR_materials_variants`, ADR 0118), by name; empty
   * draws the file's default materials. It changes only slots drawing the model's own material: a
   * slot with a material asset keeps it. The choices are `variants`.
   */
  @field(String) variant = "";

  /** The names of the material variants the model offers (ADR 0118): empty until it has loaded, or for a model without variants. */
  get variants(): readonly string[] {
    return modelVariantsIfLoaded(this.mesh);
  }

  private readonly materialProperties = new Map<string, MaterialPropertyValue>();
  /** @internal Bumped when the property overrides change, so the render backend applies them. */
  _materialPropertiesVersion = 0;
  private readonly slotProperties = new Map<number, Map<string, MaterialPropertyValue>>();
  /** @internal Bumped when a slot's property overrides change. */
  _slotMaterialPropertiesVersion = 0;
  /** Materials assigned through `setSharedMaterial` or made by `getMaterialInstance`, by slot (ADR 0107), and the slot's path they were for. */
  private readonly assigned = new Map<number, { material: Material; path: string; owned: boolean }>();
  /**
   * The material asset a slot draws (ADR 0089, 0107): `materials[slot]` when the renderer has material
   * slots and that entry is set, else `material`, the whole renderer's.
   */
  private slotPath(slot: number): string {
    return this.materials[slot] || this.material;
  }

  /** Set the material asset a slot draws: slot 0 is `material` unless `materials[0]` is set; other slots are `materials[slot]`. */
  private setSlotPath(slot: number, path: string): void {
    if (slot === 0 && !this.materials[0]) {
      this.material = path;
      return;
    }
    while (this.materials.length <= slot) this.materials.push("");
    this.materials[slot] = path;
  }

  /**
   * The Material slot `slot` draws (ADR 0107): its material asset's shared Material (changing it
   * changes every renderer drawing that asset), or a Material assigned to the slot. Null when the slot
   * has no material asset (the model's own material).
   */
  getSharedMaterial(slot = 0): Material | null {
    const a = this.currentAssigned(slot);
    if (a) return a.material;
    const path = this.slotPath(slot);
    return path ? Material.shared(path) : null;
  }

  /** Draw `m` in slot `slot`: a shared Material sets the slot's asset path; an instance is drawn as it is (renderers may share one). Null clears the slot. */
  setSharedMaterial(slot: number, m: Material | null): void {
    this.assigned.delete(slot);
    this.setSlotPath(slot, m ? m.asset : "");
    if (m?.isInstance) this.assigned.set(slot, { material: m, path: this.slotPath(slot), owned: false });
  }

  /**
   * Slot `slot`'s own Material (Unity's `renderer.materials[i]`, ADR 0107): made on first access as a
   * copy of the slot's shared Material (its values at that moment), then kept. It draws apart from the
   * instanced batch of its mesh. A slot without a material asset gets an instance of the default lit material.
   */
  getMaterialInstance(slot = 0): Material {
    const a = this.currentAssigned(slot);
    if (a?.owned) return a.material;
    const path = this.slotPath(slot);
    const m = (a?.material ?? (path ? Material.shared(path) : new Material(""))).clone();
    this.assigned.set(slot, { material: m, path, owned: true });
    return m;
  }

  /** The Material slot 0 draws (`getSharedMaterial(0)`); assigning sets slot 0 (`setSharedMaterial(0, m)`). A renderer without material slots has only slot 0, drawn by every mesh. */
  get sharedMaterial(): Material | null {
    return this.getSharedMaterial(0);
  }

  set sharedMaterial(m: Material | null) {
    this.setSharedMaterial(0, m);
  }

  /** Slot 0's own Material (Unity's `renderer.material`; `getMaterialInstance(0)`). */
  get materialInstance(): Material {
    return this.getMaterialInstance(0);
  }

  /**
   * Every slot's Material (Unity's `sharedMaterials`): slot 0, then the slots `materials` lists or
   * Materials were assigned to. The model decides how many slots it has (ADR 0089); a slot past the
   * list draws `material`.
   */
  get sharedMaterials(): (Material | null)[] {
    const n = Math.max(1, this.materials.length, ...[...this.assigned.keys()].map((k) => k + 1));
    return Array.from({ length: n }, (_, i) => this.getSharedMaterial(i));
  }

  set sharedMaterials(ms: readonly (Material | null)[]) {
    ms.forEach((m, i) => this.setSharedMaterial(i, m));
  }

  /** @internal The Material the render backend draws in a slot: an assigned one, the slot asset's shared one if made, or null to draw the asset as it is. */
  _drawMaterial(slot = 0): Material | null {
    const a = this.currentAssigned(slot);
    if (a) return a.material;
    const path = this.slotPath(slot);
    return path ? (Material._sharedIfAny(path) ?? null) : null;
  }

  /** A slot's assigned Material, dropped once the slot's path was changed since. */
  private currentAssigned(slot: number): { material: Material; owned: boolean } | null {
    const a = this.assigned.get(slot);
    if (a && a.path !== this.slotPath(slot)) {
      this.assigned.delete(slot);
      return null;
    }
    return a ?? null;
  }

  /**
   * Override one of the material's properties for this renderer only (ADR 0049), like Unity's
   * MaterialPropertyBlock: the material asset and other renderers are unchanged. Names are a
   * shader graph's property names, or `color`, `emission`, `metalness`, `roughness` and
   * `texture` for the built-in lit and unlit materials. A texture is an asset path.
   *
   * With `slot` (ADR 0371: an animation's `materials[slot].<name>` track), the override is for that material slot
   * only, whatever draws it (the model's own material included), and the built-in names also take the glTF
   * ones: `alphaCutoff`, `normalScale`, `occlusionStrength`, `clearcoatNormalScale`, `dispersion`,
   * `attenuationColor`, `attenuationDistance`, `iridescenceThicknessMinimum`, `iridescenceThicknessMaximum` and
   * `textureTransform.offset`, `.scale` and `.rotation`. A slot's colours are **linear** (as a model surface holds
   * them), not sRGB.
   */
  setMaterialProperty(name: string, value: MaterialPropertyValue, slot?: number): void {
    const v = value instanceof Color || value instanceof Vector2 || value instanceof Vector3 ? value.clone() : Array.isArray(value) ? [...value] : value;
    if (slot === undefined) {
      this.materialProperties.set(name, v);
      this._materialPropertiesVersion++;
      return;
    }
    let own = this.slotProperties.get(slot);
    if (!own) this.slotProperties.set(slot, (own = new Map()));
    own.set(name, v);
    this._slotMaterialPropertiesVersion++;
  }

  /** The value set with `setMaterialProperty`, or undefined when the material's own value is used. */
  getMaterialProperty(name: string, slot?: number): MaterialPropertyValue | undefined {
    return slot === undefined ? this.materialProperties.get(name) : this.slotProperties.get(slot)?.get(name);
  }

  /** Go back to the material's own value for one property. */
  clearMaterialProperty(name: string, slot?: number): void {
    if (slot === undefined) {
      if (this.materialProperties.delete(name)) this._materialPropertiesVersion++;
      return;
    }
    const own = this.slotProperties.get(slot);
    if (!own?.delete(name)) return;
    if (own.size === 0) this.slotProperties.delete(slot);
    this._slotMaterialPropertiesVersion++;
  }

  /** Go back to the material's own values for every property (of the slot `slot`, or, without it, the whole renderer's). */
  clearMaterialProperties(slot?: number): void {
    if (slot === undefined) {
      if (this.materialProperties.size === 0) return;
      this.materialProperties.clear();
      this._materialPropertiesVersion++;
      return;
    }
    if (!this.slotProperties.delete(slot)) return;
    this._slotMaterialPropertiesVersion++;
  }

  /** @internal The overrides, by name. */
  get _materialProperties(): ReadonlyMap<string, MaterialPropertyValue> {
    return this.materialProperties;
  }

  /** @internal The slot overrides, by slot, then name. */
  get _slotMaterialProperties(): ReadonlyMap<number, ReadonlyMap<string, MaterialPropertyValue>> {
    return this.slotProperties;
  }

  override _onDetach(): void {
    this._world.render?.release(this);
  }
}

/** A value for `MeshRenderer.setMaterialProperty`: a number, vector, colour, 2–4 numbers, or a texture's asset path. */
export type MaterialPropertyValue = number | Vector2 | Vector3 | Color | readonly number[] | string;

export type LightType = "directional" | "point" | "spot" | "ambient";

/**
 * A light (ADR 0043). Directional and spot lights shine along their node's +Z axis (like a
 * Camera); point lights shine every way; ambient light lights everything evenly. Intensity is
 * physical: 1 is full brightness for a directional light, and point and spot lights fade with the
 * square of distance (1 = full brightness at 1 m), reaching nothing beyond `range`.
 */
@component("engine.Light")
export class Light extends Component {
  @field(String, { choices: ["directional", "point", "spot", "ambient"] }) type: LightType = "directional";
  @field(Color) color = Color.white;
  @field(Number) intensity = 1;
  /** Point and spot: how far the light reaches, in metres (0 = no limit). */
  @field(Number) range = 10;
  /** Spot: the cone's full angle in degrees. */
  @field(Number) spotAngle = 30;
  /** Spot: how soft the cone's edge is, 0 (hard) to 1. */
  @field(Number) spotSoftness = 0.2;
  /**
   * Directional: this is the World's sun (ADR 0393), the light a sky drives and shader graphs' Main Light
   * nodes read. Without one flagged, the brightest directional light is the sun; with several, the
   * brightest of them.
   */
  @field(Boolean, { description: "The World's sun: the directional light the sky drives and shader graphs' Main Light reads. Unflagged: the brightest directional light." })
  sun = false;
  /**
   * Directional, point and spot: cast shadows from meshes with `castShadows`. A directional
   * light's shadows cover `shadowArea` metres around its node.
   */
  @field(Boolean) castShadows = false;
  @field(Number) shadowArea = 20;

  override _onDetach(): void {
    this._world.render?.release(this);
  }
}

export type ToneMapping = "none" | "aces" | "agx" | "neutral";

/**
 * Post-processing for the camera on the same node (ADR 0051). Effects run when this component
 * asks for them and the graphics quality tier allows them. The main (lowest-depth) camera gets
 * them in this version; other cameras draw without effects.
 */
@component("engine.PostProcessing")
export class PostProcessing extends Component {
  /** Tone mapping curve applied to the HDR scene. */
  @field(String, { choices: ["none", "aces", "agx", "neutral"] }) toneMapping: ToneMapping = "agx";
  /** Exposure multiplier applied before tone mapping (1 = unchanged). */
  @field(Number) exposure = 1;

  /** Bloom glow around bright areas. */
  @field(Boolean) bloom = false;
  /** Strength of the bloom glow (1 = default). */
  @field(Number) bloomIntensity = 1;
  /** Brightness above which pixels bloom, 0 to 1 (luminance). */
  @field(Number) bloomThreshold = 0.9;
  /** Spread of the bloom glow, 0 to 1. */
  @field(Number) bloomRadius = 0.85;

  /** Ambient occlusion: darkens creases and contact points. */
  @field(Boolean) ambientOcclusion = false;
  /** Strength of the ambient occlusion (2 = default). */
  @field(Number) aoIntensity = 2;
  /** Radius of the occlusion search, in metres. */
  @field(Number) aoRadius = 1;

  /** Brightness offset, -1 to 1 (0 = unchanged). */
  @field(Number) brightness = 0;
  /** Contrast, -1 to 1 (0 = unchanged). */
  @field(Number) contrast = 0;
  /** Saturation, -1 (greyscale) to 1 (0 = unchanged). */
  @field(Number) saturation = 0;
  /** Hue rotation in degrees (0 = unchanged). */
  @field(Number) hue = 0;
  /**
   * A colour lookup table (`.cube`, ADR 0111) applied to the final, tone-mapped image, as exported by
   * grading tools (DaVinci Resolve, Photoshop). Empty: none.
   */
  @field(AssetRef, { kind: "lut" }) lut = "";
  /** How much of the lookup table's look to apply, 0 to 1. */
  @field(Number) lutIntensity = 1;

  /** Darkens the edges of the screen. */
  @field(Boolean) vignette = false;
  /** How dark the vignette gets, 0 to 1. */
  @field(Number) vignetteDarkness = 0.5;
  /** How far in from the edges the vignette starts, 0 to 1. */
  @field(Number) vignetteOffset = 0.5;

  /** Blurs what is out of focus. */
  @field(Boolean) depthOfField = false;
  /** Distance to the focused plane, in metres. */
  @field(Number) focusDistance = 10;
  /** Depth range around the focus distance that stays sharp, in metres. */
  @field(Number) focusRange = 5;
  /** Size of the out-of-focus blur (bokeh) shapes. */
  @field(Number) bokehScale = 2;

  /** Splits red, green and blue at the screen edges. */
  @field(Boolean) chromaticAberration = false;
  /** Offset of the colour split, as a fraction of the screen (0.002 = default). */
  @field(Number) chromaticAberrationAmount = 0.002;
}

/**
 * The scene environment (ADR 0053): image-based lighting and the skybox. One per World; the first
 * active one wins. Without one, lit materials reflect the built-in studio room.
 */
@component("engine.Environment")
export class Environment extends Component {
  /** An .hdr, .exr, .png or .jpg equirectangular image, an .env/.dds cube or a .cubemap.json (ADR 0113), or a .sky.json procedural sky (ADR 0112). Empty: the built-in studio room. */
  @field(AssetRef, { kind: "environment" }) map = "";
  /** Strength of the environment lighting (1 = unchanged). */
  @field(Number) intensity = 1;
  /** Draw the map as the background. Off keeps the camera's background colour. */
  @field(Boolean) skybox = true;
  /** Brightness of the skybox (1 = unchanged). */
  @field(Number) skyboxIntensity = 1;
  /** Blur of the skybox, 0 to 1. */
  @field(Number) skyboxBlur = 0;
  /** Rotation of the environment around the Y axis, in degrees. */
  @field(Number) rotation = 0;
}

/**
 * Distance fog for the World (ADR 0071): the first enabled one applies to every material that
 * takes fog. Every field can change each frame (a storm fading in) without recompiling materials.
 */
@component("engine.Fog")
export class Fog extends Component {
  /** Distance fog's curve, or `none` for height fog alone (ADR 0110). */
  @field(String, { choices: ["linear", "exponential", "none"] }) mode: FogMode = "linear";
  @field(Color) color = new Color(0.7, 0.75, 0.8, 1);
  /** Distance where linear fog starts, in metres. */
  @field(Number) near = 10;
  /** Distance where linear fog is total, in metres. */
  @field(Number) far = 100;
  /** Thickness of exponential fog (about 1 / the distance it fades out over). */
  @field(Number) density = 0.02;
  /** Fade the sky to the fog colour too, by `skyboxFog`. */
  @field(Boolean) affectsSkybox = false;
  /** How far the sky fades to the fog colour when `affectsSkybox` is on, 0 to 1. */
  @field(Number) skyboxFog = 1;
  /** Height fog (ADR 0110): thick near `heightFogBase` and thinning above it, on top of distance fog. */
  @field(Boolean) heightFog = false;
  /** Height fog's thickness at `heightFogBase` (about 1 / the distance it fades out over there). */
  @field(Number) heightFogDensity = 0.05;
  /** The height, in metres, where height fog has `heightFogDensity`; it's thicker below and thinner above. */
  @field(Number) heightFogBase = 0;
  /** How fast height fog thins with height: it falls to about a third every 1 / falloff metres up. */
  @field(Number) heightFogFalloff = 0.2;
}

export type FogMode = "linear" | "exponential" | "none";

export type ProbeRefresh = "onLoad" | "everyFrame" | "baked";

/**
 * Captures the scene around its node into a local environment map (ADR 0054). Lit and physical
 * meshes whose bounds centre lies inside the probe's box reflect it instead of the global
 * Environment; where boxes overlap, the smallest wins.
 */
@component("engine.ReflectionProbe")
export class ReflectionProbe extends Component {
  /** The box of influence in metres, centred on the node. */
  @field(Vector3) size = new Vector3(10, 10, 10);
  /** Strength of the reflections. */
  @field(Number) intensity = 1;
  /**
   * `onLoad` captures once after the scene loads; `everyFrame` recaptures continuously; `baked` uses
   * `bakedMap`, captured ahead of time in the editor (ADR 0110), and captures on load without one.
   */
  @field(String, { choices: ["onLoad", "everyFrame", "baked"] }) refresh: ProbeRefresh = "onLoad";
  /**
   * Box projection (ADR 0110): reflections are corrected as if the surroundings were the probe's box,
   * so they line up with a room's walls near them. For rooms and interiors; off suits open spaces.
   */
  @field(Boolean) boxProjection = false;
  /**
   * Where meshes start blending towards this probe from a neighbour, in metres inside its box's
   * faces (ADR 0110). 0: no blending, the probe takes over at its box's edge.
   */
  @field(Number) blendDistance = 1;
  /** A capture baked in the editor (a prefiltered `.env` cube map), used when `refresh` is `baked`. */
  @field(AssetRef, { kind: "envmap" }) bakedMap = "";

  /** @internal Bumped by `capture()`; the render backend recaptures when it changes. */
  _captureRequests = 0;

  /** Recapture the surroundings on the next frame, e.g. after the scene around the probe changed. */
  capture(): void {
    this._captureRequests++;
  }

  override _onDetach(): void {
    this._world.render?.release(this);
  }
}

/** A ParticleSystem command, run by the render backend on its next frame. */
export type ParticleCommand = { op: "play" | "pause" | "restart" | "clear" } | { op: "stop"; clear: boolean } | { op: "emit"; count: number } | { op: "event"; name: string };

/** A value for an effect's exposed property (ADR 0060): a number, a vector or colour as numbers, a `#rrggbb[aa]` colour, or a curve, gradient or texture value as in the effect file. */
export type ParticlePropertyValue = number | readonly number[] | string | boolean | Record<string, unknown>;

/**
 * Plays a particle effect asset at its node (ADR 0057, 0060): a `*.particles.json` graph authored
 * in the Particle Graph. Particles follow the World's time, so pausing time pauses them, and they
 * are cosmetic: never replicated, simulated on each client.
 */
@component("engine.ParticleSystem")
export class ParticleSystem extends Component {
  /** The particle effect asset (`asset:effects/sparks.particles.json`). */
  @field(AssetRef, { kind: "particles" }) effect = "";
  /**
   * @deprecated Effects are assets (ADR 0060); the editor moves embedded effects into asset files.
   * Still played, when `effect` is empty, so scenes saved before then keep working.
   */
  @field(PlainObject, { hidden: true }) embeddedEffect: Record<string, unknown> | null = null;
  /** This instance's values for the effect's exposed properties, by name (set them with `setProperty`). */
  @field(PlainObject, { hidden: true }) overrides: Record<string, ParticlePropertyValue> = {};
  /** Start playing when the node is created. Off: wait for `play()`. */
  @field(Boolean) playOnAwake = true;
  /** Simulation speed (1 = normal), on top of the World's time scale. */
  @field(Number) timeScale = 1;
  /** Multiplies the particles' start colours. */
  @field(Color) tint = Color.white;
  /** Multiplies emission rates, bursts and the particle limit. */
  @field(Number) emissionScale = 1;
  /** Destroy the node once a non-looping effect has finished and its last particle is gone. */
  @field(Boolean) destroyOnFinish = false;
  /**
   * Random seed. 0 = a new random sequence every play; any other integer = the same particles every
   * play and restart, for replays, tests and lockstep.
   */
  @field(Number) seed = 0;
  /**
   * 2D (ADR 0415): the sorting layer its particles draw on, among sprites and tiles, at `orderInLayer`; and with a lit
   * 2D `material`, lit by 2D lights like them (each output's flat light: no normal maps). Empty: drawn as 3D particles,
   * ordered by their outputs' render order.
   */
  @field(String, { choices: (s) => ["", ...s.render.sortingLayers], description: "The sorting layer its particles draw on as 2D content (lit by 2D lights). Empty: 3D particles." }) sortingLayer = "";
  /** With a `sortingLayer`: the order within it (higher draws on top), as a SpriteRenderer's. */
  @field(Number) orderInLayer = 0;
  /**
   * With a `sortingLayer`: a 2D material asset (`"sprite-lit"`, the default when empty, or `"sprite-unlit"`) saying
   * whether 2D lights light the particles. Their colours and textures stay their outputs'.
   */
  @field(AssetRef, { kind: "material", description: "With a sorting layer: Sprite Lit (default) or Sprite Unlit, whether 2D lights light the particles." }) material = "";

  /** @internal Commands for the render backend, in order. */
  _commands: ParticleCommand[] = [];
  /** @internal Written by the render backend each frame. */
  _state = { playing: false, paused: false, time: 0, count: 0, alive: false };

  /** Start, or resume after `pause()`. */
  play(): void {
    this._commands.push({ op: "play" });
  }

  /** Freeze the effect where it is; `play()` resumes it. */
  pause(): void {
    this._commands.push({ op: "pause" });
  }

  /** Stop emitting. Particles already out live out their lives, unless `clear` removes them at once. */
  stop(options: { clear?: boolean } = {}): void {
    this._commands.push({ op: "stop", clear: !!options.clear });
  }

  /** Start again from the beginning, removing the particles already out. */
  restart(): void {
    this._commands.push({ op: "restart" });
  }

  /** Remove every particle, without stopping. */
  clear(): void {
    this._commands.push({ op: "clear" });
  }

  /** Emit `count` particles at once from every emitter (sub-emitters aside). */
  emit(count: number): void {
    this._commands.push({ op: "emit", count: Math.max(0, Math.floor(count)) });
  }

  /** Set one of the effect's exposed properties for this instance; it applies on the next frame. */
  setProperty(name: string, value: ParticlePropertyValue): void {
    this.overrides = { ...this.overrides, [name]: value };
  }

  /** This instance's value of an exposed property, or undefined if it uses the effect's own value. */
  getProperty(name: string): ParticlePropertyValue | undefined {
    return this.overrides[name];
  }

  /** Send a custom event (an Event node named `name` in the graph), which starts or stops the systems it's wired to. */
  sendEvent(name: string): void {
    this._commands.push({ op: "event", name });
  }

  /** True while emitting (not paused or stopped). */
  get isPlaying(): boolean {
    return this._state.playing;
  }

  /** True while emitting or any particle is still alive. */
  get isAlive(): boolean {
    return this._state.alive;
  }

  /** Seconds since the effect started (or restarted). */
  get playTime(): number {
    return this._state.time;
  }

  /** Particles alive now, across every emitter. */
  get particleCount(): number {
    return this._state.count;
  }

  override _onDetach(): void {
    this._world.render?.release(this);
  }
}
