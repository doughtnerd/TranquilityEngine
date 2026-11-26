/**
 * 2D shadow shape sources (ADR 0423). A Component that knows what its node should cast 2D shadows with, apart from its
 * collision (a Tilemap's tiles, whose occluders may differ from their collision), implements `ShadowShapeSource2D`;
 * a ShadowCaster2D in "auto" or "collider" mode on the same node casts from it in preference to the node's collision
 * shapes (`lights2D/casterOutlines.ts`, ADR 0413). Renderer-neutral: no renderer types, local units only.
 */
import type { Component } from "../core/Component";
import type { GameObject } from "../scene/GameObject";

/** Shadow shapes in the source node's local XY. */
export interface ShadowShapes2D {
  /** Closed outlines with the solid on the left of each edge (counter-clockwise outside, clockwise around holes). */
  loops: [number, number][][];
  /** Convex solid polygons, counter-clockwise. */
  polygons: [number, number][][];
}

/** A Component that offers 2D shadow shapes to a ShadowCaster2D on its node. */
export interface ShadowShapeSource2D {
  /** Changes whenever the shapes `shadowShapes` would give change. */
  shadowSignature(): string;
  /** The shapes now, or null while they can't be known yet (an asset still loading). */
  shadowShapes(): ShadowShapes2D | null;
}

/** Whether `c` offers 2D shadow shapes. */
export function isShadowShapeSource2D(c: unknown): c is Component & ShadowShapeSource2D {
  const s = c as Partial<ShadowShapeSource2D> | null;
  return !!s && typeof s.shadowSignature === "function" && typeof s.shadowShapes === "function";
}

/** The first Component on `node` (not its children) that offers 2D shadow shapes, or null. */
export function findShadowShapeSource2D(node: GameObject): (Component & ShadowShapeSource2D) | null {
  for (const c of node.world._componentsOf(node.entity)) if (isShadowShapeSource2D(c)) return c;
  return null;
}
