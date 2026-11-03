/**
 * Render components (ADR 0004, 0010, 0014). Engine-native: none of these expose three.js.
 * The render backend mirrors them into three.js objects each frame.
 */
import { Component } from "../core/Component";
import { Color, Vector2 } from "../core/math";
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

  override _onDetach(): void {
    this.world.render?.release(this);
  }
}

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
