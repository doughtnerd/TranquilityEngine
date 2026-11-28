/**
 * The renderer component types an `LODGroup` controls (ADR 0459 §2). Core registers `MeshRenderer`; a plugin registers
 * its own (the animation plugin's `SkinnedMeshRenderer`), so the visibility stage in core never imports a plugin
 * (ADR 0135, 0140). Not public API.
 */
import type { Component } from "../../core/Component";
import type { LodMember } from "./types";

/** A Component class whose instances are `LodMember`s. */
export type LodMemberType = abstract new () => Component & LodMember;

const types: LodMemberType[] = [];

/**
 * Add a member type; the visibility stage finds its enabled instances in every World from the next frame. Returns the
 * function that removes it again. Registering a type twice is a no-op (the first removal removes it).
 */
export function registerLodMemberType(type: LodMemberType): () => void {
  if (!types.includes(type)) types.push(type);
  return () => {
    const i = types.indexOf(type);
    if (i >= 0) types.splice(i, 1);
  };
}

/** The registered member types, in registration order. */
export function lodMemberTypes(): readonly LodMemberType[] {
  return types;
}
