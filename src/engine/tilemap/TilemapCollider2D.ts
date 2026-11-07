import { component, field } from "../core/registry";
import { Collider2D } from "../physics/Collider2D";
import type { TileCollisionMode } from "./collision";
import { Tilemap } from "./Tilemap";

/** @internal What the physics backend keeps for a TilemapCollider2D (Rapier colliders are typed loosely here so Rapier stays out of this module). */
export interface TilemapColliderState {
  colliders: { handle: number }[];
  /** The tilemap and settings the colliders were built from. */
  signature: string;
  syncedVersion: number;
  body: import("../physics/RigidBody2D").RigidBody2D | null;
  active: boolean;
}

/**
 * Collision for the tiles of a Tilemap on the same node (ADR 0105). Each tile's collision comes from
 * its tileset (`"full"`, `"oneWay"` or a polygon). Whole-cell tiles merge into a few rectangles
 * (`"rectangles"`, solid, the default) or into outlines around each solid region (`"outline"`,
 * hollow: only the edges collide); seams between merged parts don't snag sliding bodies. One-way
 * tiles let bodies pass up through them and land on top. Layers with `collision: false` are skipped.
 * Without a RigidBody2D on the node or an ancestor the colliders are static.
 */
@component("engine.TilemapCollider2D")
export class TilemapCollider2D extends Collider2D {
  @field(String, { choices: ["rectangles", "outline"] }) mode: TileCollisionMode = "rectangles";

  /** @internal */ _tileState: TilemapColliderState | null = null;

  /** The Tilemap whose tiles collide: the one on this node. */
  get tilemap(): Tilemap | null {
    return this.node.getBehavior(Tilemap);
  }

  override _shapeSignature(): string {
    return `tilemap:${this.mode}`;
  }
}
