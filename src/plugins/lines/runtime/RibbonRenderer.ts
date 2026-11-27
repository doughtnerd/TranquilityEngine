/**
 * What line and trail renderers share (ADR 0396): how wide and what colour the ribbon is along its length, how its
 * joins and ends are rounded, how it faces the camera, how its texture runs, and how it draws (3D: depth-tested with a
 * material asset; 2D: layered 2D quads in a sorting layer). Abstract and unregistered: `LineRenderer` and
 * `TrailRenderer` are the Components.
 */
import { Component } from "../../../engine/core/Component";
import type { Curve } from "../../../engine/core/curve";
import { whiteGradient, type Gradient } from "../../../engine/core/gradient";
import { Color, Vector2 } from "../../../engine/core/math";
import { AssetRef, PlainObject, field } from "../../../engine/core/registry";

/** How a ribbon draws: depth-tested in the 3D scene, or as layered 2D content in a sorting layer (ADR 0186). */
export type RibbonMode = "3d" | "2d";
/** Which way a 3D ribbon faces: the camera drawing it, or its node's +Z axis. */
export type RibbonAlignment = "view" | "transformZ";
/**
 * How the texture runs along the ribbon: once over its length (`stretch`), repeating every `textureScale.x` world
 * units (`tile`), once over its points by index (`distributePerSegment`), or once per segment (`repeatPerSegment`).
 */
export type RibbonTextureMode = "stretch" | "tile" | "distributePerSegment" | "repeatPerSegment";

/** The shared base of `LineRenderer` and `TrailRenderer` (ADR 0396). Not exported from `"myco"` on its own, but kept in the published declarations: its fields are the two components' public API. */
export abstract class RibbonRenderer extends Component {
  @field(String, { choices: ["3d", "2d"], description: "3D: depth-tested in the scene, with a material. 2D: layered with sprites in a sorting layer, lying in the node's XY plane." })
  mode: RibbonMode = "3d";
  @field(Number, { description: "The ribbon's width in world units where the width curve is 1." })
  width = 0.1;
  @field(PlainObject, { hidden: true, description: "The width multiplier along the ribbon: x from 0 at its start (a trail's head) to 1 at its end." })
  widthCurve: Curve = [[0, 1]];
  @field(Color, { description: "Multiplies the colour gradient." })
  color = Color.white;
  @field(PlainObject, { hidden: true, description: "The colour and alpha along the ribbon: t from 0 at its start (a trail's head) to 1 at its end." })
  colorGradient: Gradient = whiteGradient();
  @field(Number, { description: "Extra vertices rounding each join. 0 mitres the joins." })
  cornerVertices = 0;
  @field(Number, { description: "Extra vertices rounding each end. 0 ends it square." })
  capVertices = 0;
  @field(String, { choices: ["view", "transformZ"], description: "3D: face the camera drawing it, or the node's +Z axis." })
  alignment: RibbonAlignment = "view";
  @field(String, { choices: ["stretch", "tile", "distributePerSegment", "repeatPerSegment"], description: "How the texture runs along the ribbon." })
  textureMode: RibbonTextureMode = "stretch";
  @field(Vector2, { description: "x: how often the texture repeats along the ribbon; y: across it." })
  textureScale = new Vector2(1, 1);
  @field(AssetRef, { kind: "material", description: "3D: a material asset or shader graph. Empty: the built-in unlit line material showing the texture." })
  material = "";
  @field(AssetRef, { kind: "texture", description: "The built-in line material's texture in 3D, and the texture in 2D." })
  texture = "";
  @field(Boolean, { description: "3D: casts shadows (ribbons facing the node's +Z only; camera-facing ribbons don't)." })
  castShadows = false;
  @field(Boolean, { description: "3D: receives shadows (lit materials only)." })
  receiveShadows = true;
  @field(String, { choices: (s) => s.render.sortingLayers, description: "2D: the sorting layer it draws in." })
  sortingLayer = "Default";
  @field(Number, { description: "2D: its order within the sorting layer." })
  orderInLayer = 0;

  override _onDetach(): void {
    this._world.render?.release(this);
  }
}
