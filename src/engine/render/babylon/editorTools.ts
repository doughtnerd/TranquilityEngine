/**
 * The Babylon backend's editor helpers (ADR 0022, 0075 stage 8), loaded together on demand so a game
 * never downloads the gizmos: picking and canvas queries, the grid, outlines, overlays and camera and
 * light gizmos, and the transform gizmo. Together they are the Babylon adapter of the editor viewport
 * (ADR 0128): `ViewportHandle` keeps the editor's state and hands it over once these have loaded.
 * Nothing Babylon crosses this class's public methods.
 */
import type { World } from "../../core/World";
import type { GameObject } from "../../scene/GameObject";
import type { Camera, ReflectionProbe, SpriteRenderer } from "../components";
import type { EditorColors, EditorDrawing, EditorOverlay, GizmoHandlers, GizmoOptions, ScreenRect, ViewportAdapter, ViewportUI, ViewRay, WorldBox } from "../editorViewport";
import type { ParticlePreviewSettings } from "../RenderSurface";
import type { BabylonEditorContext } from "./editorContext";
import { BabylonEditorGizmo } from "./editorGizmo";
import { BabylonEditorOverlays } from "./editorOverlays";
import { BabylonEditorQueries } from "./editorQueries";

/** @internal The Babylon editor viewport adapter (ADR 0128). */
export class BabylonEditorTools implements ViewportAdapter {
  readonly overlays: BabylonEditorOverlays;
  readonly queries: BabylonEditorQueries;
  readonly gizmo: BabylonEditorGizmo;

  constructor(private readonly ctx: BabylonEditorContext) {
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

  // --- ViewportAdapter ---------------------------------------------------------------------------

  setColors(colors: EditorColors): void {
    if (!this.ctx.editor) return; // a game's surface keeps its own background and has no grid
    this.ctx.renderer.setClearColor(colors.background);
    this.overlays.setEditorColors(colors);
  }

  setGrid(plane: "xz" | "xy", cellSize: number, visible: boolean): void {
    this.overlays.setEditorGridPlane(plane);
    this.overlays.setEditorGrid(cellSize, visible);
  }

  setSelection(nodes: readonly GameObject[], shown: boolean): void {
    this.ctx.renderer.setSelected(nodes);
    this.overlays.setSelectionOutline(nodes);
    this.overlays.setSelectionOutlineShown(shown);
  }

  setOverlay(provider: (() => EditorOverlay) | null): void {
    this.overlays.setOverlayProvider(provider);
  }

  setGizmo(nodes: readonly GameObject[], options: GizmoOptions, handlers: GizmoHandlers | null): void {
    this.gizmo.setGizmo(nodes, options, handlers);
  }

  setCameraPreview(camera: Camera | null, frame: HTMLElement | null): void {
    this.ctx.renderer.setCameraPreview(camera, frame);
  }

  setParticlePreview(preview: Partial<ParticlePreviewSettings>): void {
    this.ctx.renderer.setParticlePreview(preview);
  }

  restartParticlePreview(): void {
    this.ctx.renderer.restartParticlePreview();
  }

  grid(): { cellSize: number; visible: boolean; divisions: number } | null {
    return this.overlays.editorGrid();
  }

  pick(x: number, y: number): GameObject[] {
    const world = this.ctx.world();
    return world ? this.queries.pick(world, x, y) : [];
  }

  rayAt(x: number, y: number): ViewRay | null {
    const world = this.ctx.world();
    return world ? this.queries.rayAt(world, x, y) : null;
  }

  worldToCanvas(point: readonly number[]): [number, number] | null {
    const world = this.ctx.world();
    return world ? this.queries.worldToCanvas(world, point) : null;
  }

  screenBounds(root: GameObject): { node: GameObject; rect: ScreenRect }[] {
    const world = this.ctx.world();
    return world ? this.queries.screenBounds(world, root) : [];
  }

  meshBounds(node: GameObject): WorldBox | null {
    return this.queries.meshBounds(node);
  }

  spriteSize(sprite: SpriteRenderer): [number, number] | null {
    return this.ctx.renderer.spriteSize(sprite);
  }

  gizmoActiveAt(x: number, y: number): boolean {
    return this.gizmo.gizmoActiveAt(x, y);
  }

  overlayHandles(): { id: string; x: number; y: number }[] {
    const world = this.ctx.world();
    return world ? this.overlays.overlayHandlesOnCanvas(world) : [];
  }

  lightIcons(): { node: GameObject; x: number; y: number }[] {
    const world = this.ctx.world();
    return world ? this.overlays.lightIconsOnCanvas(world) : [];
  }

  ui(): ViewportUI | null {
    return this.ctx.renderer.ui();
  }

  drawn(): EditorDrawing {
    return { ...this.overlays.editorDrawingShown(), lightWires: this.overlays.lightWireCount(), cameraPreview: this.ctx.renderer.cameraPreviewDrawn() };
  }

  bakeReflectionProbe(probe: ReflectionProbe): Promise<ArrayBuffer> {
    return this.ctx.renderer.bakeReflectionProbe(probe);
  }
}
