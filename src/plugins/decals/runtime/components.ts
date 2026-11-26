/**
 * The Decals plugin's Components (ADR 0395): `DecalProjector`, a box projecting a material onto the opaque 3D surfaces
 * inside it (Unity's `DecalProjector`), and `Decal2D`, a sprite stamped onto a sorting layer that can clip itself to the
 * sprite of the node it sits on.
 */
import { Component } from "../../../engine/core/Component";
import { Color, Vector2, Vector3 } from "../../../engine/core/math";
import { AssetRef, component, field } from "../../../engine/core/registry";
import type { DecalBlend } from "../../../engine/render/decals";

export type { DecalBlend } from "../../../engine/render/decals";

/** Where a 2D decal draws: everywhere its quad covers, or only where the parent node's sprite is opaque. */
export type Decal2DClip = "none" | "parentSprite";

/**
 * A box that projects a material along its node's +Z (forward) onto whatever opaque, depth-tested surface is inside it:
 * meshes and models, moving and skinned ones too. Layered 2D content, water, particles and other transparent meshes
 * never receive it.
 */
@component("engine.DecalProjector")
export class DecalProjector extends Component {
  @field(AssetRef, { kind: "material", description: "A material asset or shader graph. Empty: the built-in decal material (lit, rough) showing the texture." })
  material = "";
  @field(AssetRef, { kind: "texture", description: "The built-in decal material's texture (its colour and alpha). Ignored with a material." })
  texture = "";
  @field(Color, { description: "Multiplies the material's colour and alpha." })
  color = Color.white;
  @field(Number, { description: "0 to 1: how strongly it shows (Unity's fade factor)." })
  opacity = 1;
  @field(Vector3, { description: "The box in node units: width, height, and how deep it projects." })
  size = new Vector3(1, 1, 1);
  @field(Vector3, { description: "The box's centre from the node. In node units, not scaled by size (as Unity's): the default puts the node on the back face of a box 1 deep." })
  pivot = new Vector3(0, 0, 0.5);
  @field(Vector2, { description: "How many times the texture repeats across the box." })
  uvScale = new Vector2(1, 1);
  @field(Vector2, { description: "Where the texture starts across the box (UV units)." })
  uvOffset = new Vector2(0, 0);
  @field(String, { choices: ["alpha", "multiply", "additive"], description: "alpha: over the surface, lit by the scene. multiply: darkens the surface (unlit). additive: adds light (unlit)." })
  blend: DecalBlend = "alpha";
  @field(Number, { description: "Among overlapping decals, higher draws on top." })
  order = 0;
  @field(Number, { description: "Metres from the camera beyond which it isn't drawn." })
  drawDistance = 1000;
  @field(Number, { description: "Metres before the draw distance over which it fades out." })
  fadeRange = 10;
  @field(Vector2, { description: "Radians between the surface's normal and the projection: full strength below x, gone past y." })
  angleFade = new Vector2(Math.PI / 3, Math.PI / 2);

  override _onDetach(): void {
    this._world.render?.release(this);
  }
}

/** A sprite stamped onto a sorting layer, sorted with sprites, tiles and 2D lines (ADR 0186); it can stop at its parent sprite's edge. */
@component("engine.Decal2D")
export class Decal2D extends Component {
  @field(AssetRef, { kind: "sprite", description: "The image (or a slice of it) to stamp." })
  sprite = "";
  @field(Color, { description: "Multiplies the sprite's colour and alpha." })
  color = Color.white;
  @field(Number, { description: "0 to 1: how strongly it shows." })
  opacity = 1;
  @field(Vector2, { description: "Its size in node units. Empty: the sprite's pixel size over pixels per unit." })
  size: Vector2 | null = null;
  @field(String, { choices: (s) => s.render.sortingLayers, description: "The sorting layer it draws in." })
  sortingLayer = "Default";
  @field(Number, { description: "Its order within the sorting layer." })
  orderInLayer = 0;
  @field(AssetRef, { kind: "material", description: "A Sprite Lit or Sprite Unlit material asset (ADR 0399). Empty: Sprite Lit, lit by 2D lights when the World has any." })
  material = "";
  @field(String, { choices: ["none", "parentSprite"], description: "parentSprite: drawn only where the parent node's sprite is opaque. none: everywhere." })
  clip: Decal2DClip = "parentSprite";

  override _onDetach(): void {
    this._world.render?.release(this);
  }
}
