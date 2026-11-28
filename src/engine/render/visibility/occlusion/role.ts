/**
 * A renderer's effective occlusion role (ADR 0460 §3, §6): what its `occlusion` value does this frame, and why an
 * `"auto"` or `"occluder"` renderer only gets tested. One rule shared by the visibility stage (which picks the frame's
 * occluders with it) and the editor's Inspector (which shows it beside the field). Pure: no engine state. Not public API.
 */
import type { OcclusionRole } from "../types";

/** Fewest buffer pixels an `"auto"` occluder's narrowest side must cover on screen (the width test, ADR 0460 §3). */
export const MIN_OCCLUDER_PIXELS = 2;

/**
 * Why a renderer that could occlude doesn't: it has no geometry to occlude with (no stand-in, and over 512 triangles),
 * its material isn't opaque, it is narrower than `MIN_OCCLUDER_PIXELS` on screen (`"auto"` only), or it is skinned.
 */
export type OcclusionRoleReason = "noGeometry" | "transparent" | "narrow" | "skinned";

/** What a renderer does in occlusion: whether it occludes, whether it is tested, and why it doesn't occlude. */
export interface EffectiveOcclusionRole {
  readonly occluder: boolean;
  readonly occludee: boolean;
  /** Null when it occludes, or when its value says it never does (`"occludee"`, `"none"`). */
  readonly reason: OcclusionRoleReason | null;
}

/** What the rule needs to know about a renderer. */
export interface OcclusionRoleFacts {
  /** A skinned renderer: an occludee only (its bounds lag a frame, ADR 0460 §3). */
  readonly skinned?: boolean;
  /** It has occluder geometry (a stand-in, or a mesh of at most 512 triangles). */
  readonly geometry: boolean;
  /** Its material is opaque. */
  readonly opaque: boolean;
  /** Its narrowest side on screen in buffer pixels, or null when unknown (no view yet): then the width test passes. */
  readonly widthPx: number | null;
}

const NONE: EffectiveOcclusionRole = Object.freeze({ occluder: false, occludee: false, reason: null });
const OCCLUDEE: EffectiveOcclusionRole = Object.freeze({ occluder: false, occludee: true, reason: null });
const BOTH: EffectiveOcclusionRole = Object.freeze({ occluder: true, occludee: true, reason: null });
const only = (reason: OcclusionRoleReason): EffectiveOcclusionRole => ({ occluder: false, occludee: true, reason });

/** The effective role of a renderer whose `occlusion` is `role` (an unknown value counts as `"auto"`). */
export function effectiveOcclusionRole(role: OcclusionRole, facts: OcclusionRoleFacts): EffectiveOcclusionRole {
  if (role === "none") return NONE;
  if (role === "occludee") return OCCLUDEE;
  if (facts.skinned) return only("skinned");
  if (!facts.geometry) return only("noGeometry");
  if (!facts.opaque) return only("transparent");
  if (role !== "occluder" && facts.widthPx !== null && !(facts.widthPx >= MIN_OCCLUDER_PIXELS)) return only("narrow");
  return BOTH;
}
