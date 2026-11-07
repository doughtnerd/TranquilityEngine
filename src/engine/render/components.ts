/**
 * Render components (ADR 0004, 0010, 0014). Engine-native: none of these expose three.js.
 * The render backend mirrors them into three.js objects each frame.
 */
import { Component } from "../core/Component";
import { Color, Quaternion, Ray, Vector2, Vector3 } from "../core/math";
import { AssetRef, PlainObject, component, field } from "../core/registry";
import { World } from "../core/World";
import { pixelPerfectView } from "./pixelPerfect";
import { Material } from "./Material";

/** Draws a textured quad (ADR 0014). */
@component("engine.SpriteRenderer")
export class SpriteRenderer extends Component {
  /** Asset path of the texture. Empty draws a plain colored quad. */
  @field(AssetRef) sprite = "";
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

  override _onDetach(): void {
    this.world.render?.release(this);
  }
}

export type Projection = "orthographic" | "perspective";

/** Renders the scene from its node's position, looking down -Z. */
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

  /** The enabled camera with the lowest depth in the current World (ADR 0032). */
  static get main(): Camera | null {
    const cams = World.require()._componentsOfType(Camera).filter((c) => c.isActiveAndEnabled);
    return cams.sort((a, b) => a.depth - b.depth)[0] ?? null;
  }

  /**
   * The canvas size the camera's maths uses: the render backend's canvas (CSS pixels, like
   * `Input.mousePosition`), or without one (headless) the project's reference resolution (ADR 0073).
   */
  private canvasSize(): { width: number; height: number } {
    const canvas = this.world.render?.canvas;
    if (canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0) return { width: canvas.clientWidth, height: canvas.clientHeight };
    const { width, height } = this.world.settings.display;
    return { width, height };
  }

  /** The camera's rectangle in canvas pixels, origin top-left (ADR 0056). */
  private pixelRect(): { x: number; y: number; width: number; height: number } {
    const { width: cw, height: ch } = this.canvasSize();
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
   * size for the viewport's height in device pixels, else `orthographicSize`.
   * @internal
   */
  _effectiveOrthographicSize(): number {
    if (!this.pixelPerfect || this.projection !== "orthographic") return this.orthographicSize;
    const dpr = typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const heightPx = this.pixelRect().height * dpr;
    return pixelPerfectView(heightPx, this.orthographicSize, this.world.settings.render.pixelsPerUnit).orthographicSize;
  }

  /** The camera's world position and axes (right, up, forward = the node's -Z), ignoring scale. */
  private frame(): { position: Vector3; right: Vector3; up: Vector3; forward: Vector3 } {
    const t = this.node.transform!;
    const q = t.worldRotation;
    return { position: t.worldPosition, right: rotate(q, 1, 0, 0), up: rotate(q, 0, 1, 0), forward: rotate(q, 0, 0, -1) };
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
    this.world.render?.release(this);
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
    this.world.render?.release(this);
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
  @field(AssetRef) mesh = "builtin:cube";
  /**
   * A material asset (`asset:materials/wood.material.json`). Empty: the model's own materials,
   * or the default material (white, lit) for meshes without one.
   */
  @field(AssetRef) material = "";
  /**
   * A material asset per material slot (ADR 0089), drawn in place of `material` for that slot.
   * The slots are the model's own materials, in the order its meshes first use them (a built-in
   * mesh has one); an empty entry, or none, leaves the slot to `material`, then to the model's
   * import settings, then to the model's own material.
   */
  @field([AssetRef]) materials: string[] = [];
  /** Cast shadows from Lights with `castShadows` on. */
  @field(Boolean) castShadows = true;
  /** Show shadows cast onto it. */
  @field(Boolean) receiveShadows = true;

  private readonly materialProperties = new Map<string, MaterialPropertyValue>();
  /** @internal Bumped when the property overrides change, so the render backend applies them. */
  _materialPropertiesVersion = 0;
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
   */
  setMaterialProperty(name: string, value: MaterialPropertyValue): void {
    this.materialProperties.set(name, value instanceof Color || value instanceof Vector2 || value instanceof Vector3 ? value.clone() : Array.isArray(value) ? [...value] : value);
    this._materialPropertiesVersion++;
  }

  /** The value set with `setMaterialProperty`, or undefined when the material's own value is used. */
  getMaterialProperty(name: string): MaterialPropertyValue | undefined {
    return this.materialProperties.get(name);
  }

  /** Go back to the material's own value for one property. */
  clearMaterialProperty(name: string): void {
    if (this.materialProperties.delete(name)) this._materialPropertiesVersion++;
  }

  /** Go back to the material's own values for every property. */
  clearMaterialProperties(): void {
    if (this.materialProperties.size === 0) return;
    this.materialProperties.clear();
    this._materialPropertiesVersion++;
  }

  /** @internal The overrides, by name. */
  get _materialProperties(): ReadonlyMap<string, MaterialPropertyValue> {
    return this.materialProperties;
  }

  override _onDetach(): void {
    this.world.render?.release(this);
  }
}

/** A value for `MeshRenderer.setMaterialProperty`: a number, vector, colour, 2–4 numbers, or a texture's asset path. */
export type MaterialPropertyValue = number | Vector2 | Vector3 | Color | readonly number[] | string;

export type LightType = "directional" | "point" | "spot" | "ambient";

/**
 * A light (ADR 0043). Directional and spot lights shine down their node's -Z axis (like a
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
   * Directional, point and spot: cast shadows from meshes with `castShadows`. A directional
   * light's shadows cover `shadowArea` metres around its node.
   */
  @field(Boolean) castShadows = false;
  @field(Number) shadowArea = 20;

  override _onDetach(): void {
    this.world.render?.release(this);
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
  /** An .hdr, .exr, .png or .jpg equirectangular image. Empty: the built-in studio room. */
  @field(AssetRef) map = "";
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
  @field(String, { choices: ["linear", "exponential"] }) mode: FogMode = "linear";
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
}

export type FogMode = "linear" | "exponential";

export type ProbeRefresh = "onLoad" | "everyFrame";

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
  /** `onLoad` captures once after the scene loads; `everyFrame` recaptures continuously. */
  @field(String, { choices: ["onLoad", "everyFrame"] }) refresh: ProbeRefresh = "onLoad";

  /** @internal Bumped by `capture()`; the render backend recaptures when it changes. */
  _captureRequests = 0;

  /** Recapture the surroundings on the next frame, e.g. after the scene around the probe changed. */
  capture(): void {
    this._captureRequests++;
  }

  override _onDetach(): void {
    this.world.render?.release(this);
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
  @field(AssetRef) effect = "";
  /**
   * @deprecated Effects are assets (ADR 0060); the editor moves embedded effects into asset files.
   * Still played, when `effect` is empty, so scenes saved before then keep working.
   */
  @field(PlainObject) embeddedEffect: Record<string, unknown> | null = null;
  /** This instance's values for the effect's exposed properties, by name (set them with `setProperty`). */
  @field(PlainObject) overrides: Record<string, ParticlePropertyValue> = {};
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
    this.world.render?.release(this);
  }
}
