// The base game scene's layer on the Scene view's plan (ADR 0333: a test scene's `base` loads read-only underneath): what
// the plan draws for each imported object (box colliders and box zones as turned boxes, spheres and upright capsules as
// circles, mesh colliders and emitters as points), its label, its height span for the elevation slab, and the banner
// that says which game scene is underneath, or that it is missing.
//
// Pure: no DOM, no signals.
import type { BaseObjectKind, BaseSceneImport, BaseSceneObject } from "../../../engine/audio/spatial/baseScene";
import { boxCorners, type P2 } from "./geometry";

export type BasePlanShape =
  | { readonly kind: "box"; readonly corners: readonly P2[] }
  | { readonly kind: "circle"; readonly center: P2; readonly radius: number }
  | { readonly kind: "point"; readonly at: P2 };

export interface BasePlanItem {
  readonly key: string;
  readonly kind: BaseObjectKind;
  readonly shape: BasePlanShape;
  /** What the plan writes beside it. */
  readonly label: string;
  /** Its height span (the elevation slab dims what is outside it). */
  readonly low: number;
  readonly high: number;
  /** False for an object that is off in the game scene (an inactive node or a disabled component). */
  readonly active: boolean;
}

/** The plan's CSS class per kind (theme tokens in `spatial.css`). */
export const BASE_CLASS: Readonly<Record<BaseObjectKind, string>> = {
  emitter: "sp-base-emitter",
  audioZone: "sp-base-azone",
  reverbZone: "sp-base-reverb",
  collider: "sp-base-collider",
};

const flat = (p: { x: number; z: number }): P2 => ({ x: p.x, z: p.z });

function labelOf(o: BaseSceneObject): string {
  switch (o.kind) {
    case "collider":
      return `${o.name} · ${o.material ?? "default"}`;
    case "reverbZone":
      return `${o.name} · ${o.preset ?? ""}`;
    default:
      return o.name;
  }
}

/** Area on the plan, for drawing big shapes first so smaller ones inside stay on top. */
function area(o: BaseSceneObject): number {
  if (o.box) return o.box.width * o.box.depth;
  if (o.radius !== null) return Math.PI * o.radius * o.radius;
  return 0;
}

/** The base scene's objects as the plan draws them: shapes biggest first, points last. */
export function basePlanItems(base: BaseSceneImport | null): BasePlanItem[] {
  if (!base) return [];
  const sorted = [...base.objects].sort((a, b) => area(b) - area(a));
  return sorted.map((o): BasePlanItem => {
    const shape: BasePlanShape = o.box
      ? { kind: "box", corners: boxCorners(o.box) }
      : o.radius !== null
        ? { kind: "circle", center: flat(o.position), radius: o.radius }
        : { kind: "point", at: flat(o.position) };
    const low = o.box ? o.box.bottom : o.radius !== null ? o.position.y - o.radius : o.position.y;
    const high = o.box ? o.box.top : o.radius !== null ? o.position.y + o.radius : o.position.y;
    return { key: o.key, kind: o.kind, shape, label: labelOf(o), low, high, active: o.active };
  });
}

/** Points that frame the base scene's objects (Fit frames them with the test scene's). */
export function baseFramePoints(base: BaseSceneImport | null): P2[] {
  const out: P2[] = [];
  for (const item of basePlanItems(base)) {
    if (item.shape.kind === "box") out.push(...item.shape.corners);
    else if (item.shape.kind === "circle") {
      const { center: c, radius: r } = item.shape;
      out.push({ x: c.x - r, z: c.z - r }, { x: c.x + r, z: c.z + r });
    } else out.push(item.shape.at);
  }
  return out;
}

const sceneTitle = (path: string): string => path.slice(path.lastIndexOf("/") + 1).replace(/\.scene\.json$/i, "");

/** The Scene view's note on the base scene: which one is underneath (read-only), or that it is missing; null without one. */
export function baseBanner(base: BaseSceneImport | null): { readonly text: string; readonly warning: boolean } | null {
  if (!base) return null;
  if (!base.found) return { text: `Base scene ${base.path} is missing; playing without it`, warning: true };
  const n = base.objects.length;
  return { text: `Over ${sceneTitle(base.path)}: ${n === 0 ? "nothing audible" : `${n} object${n === 1 ? "" : "s"}`}, read-only`, warning: false };
}
