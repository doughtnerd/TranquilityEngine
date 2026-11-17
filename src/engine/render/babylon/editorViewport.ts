/**
 * The Babylon backend's editor viewport (ADR 0022, 0075 stage 8, 0128): the adapter `ViewportHandle`
 * drives once the renderer's editor tools have loaded on demand, so a game never downloads them.
 * It answers the editor's queries itself (what lies under a canvas point, the ray through it, where a
 * world point lands, nodes' rectangles on the canvas) and draws through three modules: the grid,
 * outlines and editor overlay (`editorGuides.ts`), the camera, light and particle system icons
 * (`editorIcons.ts`), and the transform gizmo (`editorGizmo.ts`). Renderer-level features (background,
 * sprite sizes, UI, probe bakes) go to `BabylonEditorContext.renderer`.
 *
 * Camera maths is the engine's own (`Camera.screenPointToRay`, `worldToScreenPoint`, ADR 0073,
 * viewport-aware); Babylon only intersects meshes and measures their bounds. Nothing Babylon crosses
 * this class's public methods. Queries answer nothing (empty, null) until the surface has a World.
 */
import { Ray as BabylonRay } from "@babylonjs/core/Culling/ray.js";
import { Matrix, Vector3 as BabylonVector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { Vector2, Vector3 } from "../../core/math";
import type { World } from "../../core/World";
import type { GameObject } from "../../scene/GameObject";
import type { Camera, ReflectionProbe, SpriteRenderer } from "../components";
import type { EditorColors, EditorOverlay, GizmoHandlers, GizmoOptions, ScreenRect, ViewportAdapter, ViewportUI, ViewRay, WorldBox } from "../editorViewport";
import { readView } from "./editorBatches";
import type { BabylonEditorContext } from "./editorContext";
import { BabylonEditorGizmo } from "./editorGizmo";
import { BabylonEditorGuides } from "./editorGuides";
import { BabylonEditorIcons } from "./editorIcons";

/** Icons (camera, light and particle system) draw above every sprite; meshes below every sprite. */
const ICON_ORDER = 1e9;
const MESH_ORDER = -1e12;

const visible = (m: AbstractMesh): boolean => m.isEnabled() && m.isVisible;

/** @internal The Babylon editor viewport adapter (ADR 0128). */
export class BabylonEditorViewport implements ViewportAdapter {
  private readonly guides: BabylonEditorGuides;
  private readonly icons: BabylonEditorIcons;
  private readonly gizmo: BabylonEditorGizmo;
  private disposed = false;

  constructor(private readonly ctx: BabylonEditorContext) {
    // A utility layer scene starts with image processing on; the overlay colours are sRGB values drawn to the canvas as they are.
    ctx.overlay.utilityLayerScene.imageProcessingConfiguration.isEnabled = false;
    this.guides = new BabylonEditorGuides(ctx);
    this.icons = new BabylonEditorIcons(ctx, this.guides);
    this.gizmo = new BabylonEditorGizmo(ctx);
  }

  /** Each frame, after the renderer's sync and before the overlay scene draws. Editor Worlds draw icons; every World its overlay and live selection outline. */
  sync(world: World): void {
    if (this.disposed) return;
    const view = readView(this.ctx);
    this.guides.sync(view);
    if (this.ctx.editor) this.icons.sync(world, view);
    this.gizmo.sync(world);
  }

  dispose(): void {
    this.disposed = true;
    this.gizmo.dispose();
    this.guides.dispose();
    this.icons.dispose();
  }

  // --- State -------------------------------------------------------------------------------------

  setColors(colors: EditorColors): void {
    if (!this.ctx.editor) return; // a game's surface keeps its own background and has no grid
    this.ctx.renderer.setClearColor(colors.background);
    this.guides.setColors(colors);
  }

  setGrid(plane: "xz" | "xy", cellSize: number, visible: boolean): void {
    this.guides.setGrid(plane, cellSize, visible);
  }

  setSelection(nodes: readonly GameObject[], shown: boolean): void {
    this.guides.setSelection(nodes, shown);
  }

  setOverlay(provider: (() => EditorOverlay) | null): void {
    this.guides.setOverlay(provider);
  }

  setGizmo(nodes: readonly GameObject[], options: GizmoOptions, handlers: GizmoHandlers | null): void {
    this.gizmo.setGizmo(nodes, options, handlers);
  }

  // --- Drawing queries ---------------------------------------------------------------------------

  grid(): { cellSize: number; visible: boolean; divisions: number } | null {
    return this.guides.gridShown();
  }

  gizmoActiveAt(x: number, y: number): boolean {
    return this.gizmo.gizmoActiveAt(x, y);
  }

  overlayHandles(): { id: string; x: number; y: number }[] {
    return this.ctx.world() ? this.guides.overlayHandles() : [];
  }

  lightIcons(): { node: GameObject; x: number; y: number }[] {
    return this.ctx.world() ? this.icons.lightIcons() : [];
  }

  // --- Renderer-level features -------------------------------------------------------------------

  spriteSize(sprite: SpriteRenderer): [number, number] | null {
    return this.ctx.renderer.spriteSize(sprite);
  }

  ui(): ViewportUI | null {
    return this.ctx.renderer.ui();
  }

  bakeReflectionProbe(probe: ReflectionProbe): Promise<ArrayBuffer> {
    return this.ctx.renderer.bakeReflectionProbe(probe);
  }

  // --- Picking and canvas queries ----------------------------------------------------------------

  private hasSize(): boolean {
    return this.ctx.canvas.clientWidth > 0 && this.ctx.canvas.clientHeight > 0;
  }

  /** The camera that draws the view (the first in depth order), once there is a World. */
  private view(): Camera | null {
    return this.ctx.world() ? (this.ctx.viewCameras()[0] ?? null) : null;
  }

  /**
   * Nodes whose renderers lie under a canvas point (CSS pixels, origin top-left), topmost first:
   * icons, screen-space text, sprites by draw order (no depth testing), then meshes nearest first.
   * Uses the camera that draws the view (the first in depth order).
   */
  pick(x: number, y: number): GameObject[] {
    if (!this.ctx.world() || !this.hasSize()) return [];
    const hits: { node: GameObject; order: number; distance: number }[] = [];

    for (const t of this.ctx.texts()) {
      const r = t.rect;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) hits.push({ node: t.component.node, order: Infinity, distance: 0 });
    }

    const ray = this.rayAt(x, y);
    if (ray) {
      const o = new BabylonVector3(...ray.origin), d = new BabylonVector3(...ray.direction);
      for (const s of this.ctx.sprites()) {
        if (!visible(s.mesh)) continue;
        const distance = rayQuadDistance(o, d, s.mesh.getWorldMatrix());
        if (distance !== null) hits.push({ node: s.component.node, order: s.order, distance });
      }
      const bray = new BabylonRay(o, d, 1e9);
      for (const m of this.ctx.meshes()) {
        let nearest = Infinity;
        for (const mesh of m.meshes) {
          if (!visible(mesh)) continue;
          // Babylon's mesh test takes the ray in the mesh's own space, and measures the hit there: take
          // the hit point back to world space for a distance comparable across meshes.
          const world = mesh.getWorldMatrix();
          const local = BabylonRay.Transform(bray, world.clone().invert());
          const info = mesh.intersects(local, false);
          if (!info.hit) continue;
          const point = BabylonVector3.TransformCoordinates(local.origin.add(local.direction.scale(info.distance)), world);
          const distance = BabylonVector3.Distance(o, point);
          if (distance < nearest) nearest = distance;
        }
        if (nearest < Infinity) hits.push({ node: m.component.node, order: MESH_ORDER, distance: nearest });
      }
      for (const node of this.icons.iconsAt(x, y)) hits.push({ node, order: ICON_ORDER, distance: 0 });
    }

    hits.sort((a, b) => b.order - a.order || a.distance - b.distance);
    const seen = new Set<number>();
    return hits.filter((h) => !seen.has(h.node.entity) && seen.add(h.node.entity)).map((h) => h.node);
  }

  /** The ray under a canvas point through the camera that draws the view, or null. */
  rayAt(x: number, y: number): ViewRay | null {
    const view = this.view();
    if (!view || !this.hasSize()) return null;
    const ray = view.screenPointToRay(new Vector2(x, y));
    return { origin: ray.origin.toArray() as [number, number, number], direction: ray.direction.toArray() as [number, number, number] };
  }

  /** A world point's place on the canvas (CSS pixels, origin top-left), or null if it's behind the camera or beyond far. */
  worldToCanvas(p: readonly number[]): [number, number] | null {
    const view = this.view();
    if (!view || !this.hasSize()) return null;
    return project(view, p[0], p[1], p[2] ?? 0);
  }

  /**
   * Where each active node under `root` with a Transform is on the canvas: the rectangle around its
   * sprite, text or meshes, or (with none) a point at its origin. Nodes behind the camera are left
   * out. Parents come before children.
   */
  screenBounds(root: GameObject): { node: GameObject; rect: ScreenRect }[] {
    const world = this.ctx.world(), view = this.view();
    if (!world || !view || !this.hasSize()) return [];
    const sprites = new Map<GameObject, Mesh>(), texts = new Map<GameObject, ScreenRect>(), meshes = new Map<GameObject, AbstractMesh[]>();
    for (const s of this.ctx.sprites()) if (visible(s.mesh)) sprites.set(s.component.node, s.mesh);
    for (const m of this.ctx.meshes()) {
      const shown = m.meshes.filter(visible);
      if (shown.length) meshes.set(m.component.node, [...(meshes.get(m.component.node) ?? []), ...shown]);
    }
    for (const t of this.ctx.texts()) texts.set(t.component.node, { left: t.rect.left, top: t.rect.top, right: t.rect.right, bottom: t.rect.bottom });

    const grow = (rect: ScreenRect, p: [number, number] | null): boolean => {
      if (!p) return false;
      rect.left = Math.min(rect.left, p[0]);
      rect.right = Math.max(rect.right, p[0]);
      rect.top = Math.min(rect.top, p[1]);
      rect.bottom = Math.max(rect.bottom, p[1]);
      return true;
    };
    const boundsOf = (node: GameObject): ScreenRect | null => {
      const text = texts.get(node);
      if (text) return text;
      const rect: ScreenRect = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      const sprite = sprites.get(node);
      if (sprite) {
        const m = sprite.getWorldMatrix();
        for (const [cx, cy] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
          const w = BabylonVector3.TransformCoordinates(new BabylonVector3(cx, cy, 0), m);
          if (!grow(rect, project(view, w.x, w.y, w.z))) return null;
        }
        return rect;
      }
      const drawn = meshes.get(node);
      if (drawn) {
        for (const mesh of drawn) {
          for (const c of mesh.getBoundingInfo().boundingBox.vectorsWorld) if (!grow(rect, project(view, c.x, c.y, c.z))) return null;
        }
        return rect;
      }
      const e = node.entity * 16, m = world.worldMatrix(node.entity);
      return grow(rect, project(view, m[e + 12], m[e + 13], m[e + 14])) ? rect : null;
    };

    const out: { node: GameObject; rect: ScreenRect }[] = [];
    const visit = (node: GameObject): void => {
      if (world.isPendingDestroy(node.entity) || !node.activeInHierarchy) return;
      const rect = node.transform ? boundsOf(node) : null;
      if (rect) out.push({ node, rect });
      for (const c of node.children) visit(c);
    };
    visit(root);
    return out;
  }

  /** The world-space box around the meshes of `node`'s MeshRenderers, or null if none is drawn. */
  meshBounds(node: GameObject): WorldBox | null {
    const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    let any = false;
    for (const m of this.ctx.meshes()) {
      if (m.component.node !== node) continue;
      for (const mesh of m.meshes) {
        const box = mesh.getBoundingInfo().boundingBox;
        const lo = box.minimumWorld, hi = box.maximumWorld;
        min[0] = Math.min(min[0], lo.x); min[1] = Math.min(min[1], lo.y); min[2] = Math.min(min[2], lo.z);
        max[0] = Math.max(max[0], hi.x); max[1] = Math.max(max[1], hi.y); max[2] = Math.max(max[2], hi.z);
        any = true;
      }
    }
    return any ? { min, max } : null;
  }
}

/** A world point on the canvas through `camera`, or null if it's outside the near/far range. */
function project(camera: Camera, x: number, y: number, z: number): [number, number] | null {
  const s = camera.worldToScreenPoint(new Vector3(x, y, z));
  if (s.z < camera.near || s.z > camera.far) return null;
  return [s.x, s.y];
}

const inv = new Matrix();

/**
 * Distance along a world ray to where it crosses the unit quad (-0.5..0.5 on X and Y at local z = 0)
 * transformed by `world`, or null. Both faces count; degenerate quads never hit.
 */
function rayQuadDistance(origin: BabylonVector3, direction: BabylonVector3, world: Matrix): number | null {
  if (Math.abs(world.determinant()) < 1e-12) return null;
  world.invertToRef(inv);
  const o = BabylonVector3.TransformCoordinates(origin, inv);
  const d = BabylonVector3.TransformNormal(direction, inv);
  if (Math.abs(d.z) < 1e-12) return null;
  const t = -o.z / d.z;
  if (t < 0) return null;
  const hx = o.x + d.x * t, hy = o.y + d.y * t;
  if (Math.abs(hx) > 0.5 || Math.abs(hy) > 0.5) return null;
  const hit = BabylonVector3.TransformCoordinates(new BabylonVector3(hx, hy, 0), world);
  return BabylonVector3.Distance(hit, origin);
}
