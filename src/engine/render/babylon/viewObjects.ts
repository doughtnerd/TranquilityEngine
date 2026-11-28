/**
 * Each view's object list (ADR 0446 §3): what the view's cull task (and so its geometry pass and render pass) or a
 * probe capture draws. Features that choose their drawables per view (`BabylonFeature.prepareViews`) own some of the
 * scene's meshes; a view lists every other mesh of the scene, as it always did (sprites, particles' meshes, water, UI
 * planes, the editor's helpers), plus what each such feature chose for it.
 */
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { Plane } from "@babylonjs/core/Maths/math.plane.js";
import type { ViewDrawing } from "./feature";
import type { CascadeExpander } from "./shadowCulling";

/** @internal The object lists of a frame's views, rebuilt each frame into arrays it keeps. */
export class ViewObjectLists {
  private readonly lists: AbstractMesh[][] = [];
  private readonly base: AbstractMesh[] = [];

  /**
   * `count` lists: the scene's meshes no drawing owns, less those `exclude(i)` rejects for view `i` (when it gives a
   * test), then each drawing's meshes for view `i`. The arrays are reused by the next build.
   */
  build(sceneMeshes: readonly AbstractMesh[], drawings: readonly ViewDrawing[], count: number, exclude: (view: number) => ((mesh: AbstractMesh) => boolean) | null = () => null): readonly (readonly AbstractMesh[])[] {
    const base = this.base;
    base.length = 0;
    for (const m of sceneMeshes) if (!drawings.some((d) => d.owns(m))) base.push(m);
    const lists = this.lists;
    lists.length = count;
    for (let i = 0; i < count; i++) {
      const list = (lists[i] ??= []);
      list.length = 0;
      const out = exclude(i);
      if (out) {
        for (const m of base) if (!out(m)) list.push(m);
      } else for (const m of base) list.push(m);
      for (const d of drawings) d.meshes(i, list);
    }
    return lists;
  }
}

/** @internal The drawings' cascade expanders as one (the first that claims a caster expands it), or null without any. */
export function cascadesOf(drawings: readonly ViewDrawing[]): CascadeExpander | null {
  const all = drawings.map((d) => d.cascades).filter((c): c is CascadeExpander => c !== null);
  if (all.length <= 1) return all[0] ?? null;
  return { expand: (mesh: AbstractMesh, list: number, layer: number, planes: readonly Plane[], out: AbstractMesh[]) => all.some((c) => c.expand(mesh, list, layer, planes, out)) };
}
