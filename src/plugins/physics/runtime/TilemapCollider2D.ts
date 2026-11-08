import { component, field } from "../../../engine/core/registry";
import { Collider2D } from "./Collider2D";
import type { TileCollisionMode } from "../../../engine/tilemap/collision";
import { Tilemap } from "../../../engine/tilemap/Tilemap";
import type { Dim2 } from "./backend";
import type { TilemapColliderState } from "./core/state";
import type { RigidBody2D } from "./RigidBody2D";

/**
 * Collision for the tiles of a Tilemap on the same node (ADR 0105). Each tile's collision comes from
 * its tileset (`"full"`, `"oneWay"` or a polygon). Whole-cell tiles merge into a few rectangles
 * (`"rectangles"`, solid, the default) or into outlines around each solid region (`"outline"`,
 * hollow: only the edges collide); seams between merged parts don't snag sliding bodies. One-way
 * tiles let bodies pass up through them and land on top. Layers with `collision: false` are skipped.
 * Without a RigidBody2D on the node or an ancestor the colliders are static.
 *
 * Stays in the Physics plugin, reading the core's Tilemap, until ADR 0136 settles how plugins read tile data.
 */
@component("engine.TilemapCollider2D")
export class TilemapCollider2D extends Collider2D {
  @field(String, { choices: ["rectangles", "outline"] }) mode: TileCollisionMode = "rectangles";

  /** @internal */ _tileState: TilemapColliderState<Dim2, RigidBody2D> | null = null;

  /** The Tilemap whose tiles collide: the one on this node. */
  get tilemap(): Tilemap | null {
    return this.node.getBehavior(Tilemap);
  }

  override _shapeSignature(): string {
    return `tilemap:${this.mode}`;
  }
}
