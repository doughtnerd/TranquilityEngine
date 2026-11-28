// The Meshes plugin's occlusion read-outs (ADR 0460 §6), without the DOM: the words beside `MeshRenderer.occlusion` in
// the Inspector for its effective role, and the Play Stats panel's Occlusion table from the render diagnostics.
import type { PlayStatsRow } from "../../../editor/sdk";
import type { EffectiveOcclusionRole, OcclusionRoleReason } from "../../../engine/render/visibility/occlusion/role";

const WHY: Record<OcclusionRoleReason, string> = {
  noGeometry: "it has no occluder geometry (no generated levels to occlude with, and over 512 triangles)",
  transparent: "its material isn't opaque",
  narrow: "it is too narrow on screen (under 2 buffer pixels)",
  skinned: "skinned meshes only get tested",
};

/** The badge beside the field: a short label and a sentence saying what the renderer does in occlusion, and why. */
export function occlusionRoleText(role: EffectiveOcclusionRole): { label: string; title: string } {
  if (role.occluder) return { label: "Occluder + occludee", title: "Hides what is behind it, and is hidden when something covers it." };
  if (!role.occludee) return { label: "Never culled", title: "Always drawn: occlusion neither hides it nor uses it to hide others." };
  if (!role.reason) return { label: "Occludee only", title: "Hidden when something covers it; it hides nothing." };
  return { label: "Occludee only", title: `Hidden when something covers it, but it hides nothing: ${WHY[role.reason]}.` };
}

/** The meshes feature's occlusion diagnostics (ADR 0460 §6): views it ran for this frame, and their totals. */
export interface OcclusionDiagnostics {
  readonly views: number;
  readonly occluders: number;
  readonly triangles: number;
  readonly tested: number;
  readonly culled: number;
  readonly ms: number;
}

/** The diagnostics' occlusion part from a feature's diagnostics value, or null when it holds none. */
export function occlusionOf(meshes: unknown): OcclusionDiagnostics | null {
  const o = (meshes as { occlusion?: Partial<OcclusionDiagnostics> } | null | undefined)?.occlusion;
  if (!o || typeof o !== "object") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { views: n(o.views), occluders: n(o.occluders), triangles: n(o.triangles), tested: n(o.tested), culled: n(o.culled), ms: n(o.ms) };
}

const int = (n: number) => Math.round(n).toLocaleString("en-US");

/** The Occlusion table's rows: views, occluders and triangles rasterised, occludees tested and culled, and time. */
export function occlusionRows(o: OcclusionDiagnostics): PlayStatsRow[] {
  const share = o.tested > 0 ? `${Math.round((100 * o.culled) / o.tested)} % of tested` : undefined;
  return [
    { label: "Views", value: int(o.views) },
    { label: "Occluders", value: int(o.occluders), detail: `${int(o.triangles)} triangles` },
    { label: "Tested", value: int(o.tested) },
    { label: "Culled", value: int(o.culled), ...(share ? { detail: share } : {}) },
    { label: "Time", value: `${o.ms.toFixed(2)} ms` },
  ];
}
