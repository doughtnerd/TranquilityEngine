/**
 * The Babylon backend's editor helpers (ADR 0022, 0075 stage 8), loaded together on demand so a game
 * never downloads the gizmos: picking and canvas queries, the grid, outlines, overlays and camera and
 * light gizmos, and the transform gizmo.
 */
import type { World } from "../../core/World";
import type { BabylonEditorContext } from "./editorContext";
import { BabylonEditorGizmo } from "./editorGizmo";
import { BabylonEditorOverlays } from "./editorOverlays";
import { BabylonEditorQueries } from "./editorQueries";

/** @internal */
export class BabylonEditorTools {
  readonly overlays: BabylonEditorOverlays;
  readonly queries: BabylonEditorQueries;
  readonly gizmo: BabylonEditorGizmo;

  constructor(ctx: BabylonEditorContext) {
    this.overlays = new BabylonEditorOverlays(ctx);
    this.queries = new BabylonEditorQueries(ctx, (world, x, y) => this.overlays.iconsAt(world, x, y));
    this.gizmo = new BabylonEditorGizmo(ctx);
  }

  /** Each frame, after the renderer's sync. */
  sync(world: World): void {
    this.overlays.sync(world);
    this.gizmo.sync(world);
  }

  dispose(): void {
    this.gizmo.dispose();
    this.overlays.dispose();
  }
}
