/**
 * Render components (ADR 0004, 0010, 0014). Engine-native: none of these expose three.js.
 * The render backend mirrors them into three.js objects each frame.
 */
import { Component } from "../core/Component";
import { Color, Vector2, Vector3 } from "../core/math";
import { AssetRef, component, field } from "../core/registry";
import { World } from "../core/World";

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

  /** The enabled camera with the lowest depth in the current World (ADR 0032). */
  static get main(): Camera | null {
    const cams = World.require()._componentsOfType(Camera).filter((c) => c.isActiveAndEnabled);
    return cams.sort((a, b) => a.depth - b.depth)[0] ?? null;
  }

  override _onDetach(): void {
    this.world.render?.release(this);
  }
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
  /** Cast shadows from Lights with `castShadows` on. */
  @field(Boolean) castShadows = true;
  /** Show shadows cast onto it. */
  @field(Boolean) receiveShadows = true;

  private readonly materialProperties = new Map<string, MaterialPropertyValue>();
  /** @internal Bumped when the property overrides change, so the render backend applies them. */
  _materialPropertiesVersion = 0;

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
