/**
 * `MapObject` (ADR 0422): what an object or entity imported from Tiled or LDtk carries, kept on its node. `type` is the
 * Tiled class or the LDtk entity identifier; `properties` are its custom properties or field instances, as JSON
 * (references to other objects and entities as their node ids, LDtk points in the map's local units).
 *
 * Plain data: nothing in the engine reads it. Game code finds spawn points and triggers by type:
 *
 * ```ts
 * const spawns = GameObject.findObjectsOfType(MapObject).filter((o) => o.type === "Spawn");
 * ```
 */
import { Component } from "../../../engine/core/Component";
import { PlainObject, component, field } from "../../../engine/core/registry";

@component("engine.MapObject")
export class MapObject extends Component {
  /** The Tiled class or LDtk entity identifier ("" when it had none). */
  @field(String) type = "";
  /** The object's custom properties (Tiled) or field instances (LDtk), by name. */
  @field(PlainObject) properties: Record<string, unknown> = {};
}
