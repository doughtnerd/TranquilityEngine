/**
 * The Babylon backend's editor viewport (ADR 0022, 0075 stage 8, 0128): the adapter `ViewportHandle`
 * drives once the renderer's editor tools have loaded on demand, so a game never downloads them.
 * It answers the editor's queries itself (what lies under a canvas point, the ray through it, where a
 * world point lands, nodes' rectangles on the canvas) and draws through three modules: the grid,
 * outlines and editor overlay (`editorGuides.ts`), the camera, light and particle system icons
 * (`editorIcons.ts`), and the transform gizmo (`editorGizmo.ts`). What it picks, frames and measures is
 * what the render features drew (`BabylonEditorContext.drawn`, ADR 0276), whichever feature drew it.
 * Renderer-level features (background, UI, probe bakes) go to `BabylonEditorContext.renderer`.
 *
 * Camera maths is the engine's own (`Camera.screenPointToRay`, `worldToScreenPoint`, ADR 0073,
 * viewport-aware); Babylon only intersects meshes and measures their bounds. Nothing Babylon crosses
 * this class's public methods. Queries answer nothing (empty, null) until the surface has a World.
 */
import { Ray as BabylonRay } from "@babylonjs/core/Culling/ray.js";
import { Matrix, Vector3 as BabylonVector3 } from "@babylonjs/core/Maths/math.vector.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import { Vector2, Vector3 } from "../../core/math";
import type { World } from "../../core/World";
import type { GameObject } from "../../scene/GameObject";
import type { Camera, ReflectionProbe, SpriteRenderer } from "../components";
import type { EditorColors, EditorOverlay, GizmoHandlers, GizmoOptions, ScreenRect, ViewportAdapter, ViewportUI, ViewRay, WorldBox } from "../editorViewport";
import { readView } from "./editorBatches";
import type { BabylonEditorContext, EditorDrawn } from "./editorContext";
import { BabylonEditorGizmo } from "./editorGizmo";
import { shapeWorldBox, type DrawnShape } from "./feature";
import { BabylonEditorGuides } from "./editorGuides";
import { BabylonEditorIcons } from "./editorIcons";

/** Icons (camera, light and particle system) draw above every sprite. */
const ICON_ORDER = 1e9;

const visible = (m: AbstractMesh): boolean => m.isEnabled() && m.isVisible;

/** The meshes of a drawing in the world (a quad's or meshes), visible ones only. */
function worldMeshes(d: EditorDrawn): AbstractMesh[] {
  const shape = d.shape;
  if (shape?.kind === "quad") return visible(shape.mesh) ? [shape.mesh] : [];
  if (shape?.kind === "meshes") return shape.meshes.filter(visible);
  return [];
}

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

  /** The size its feature drew the sprite at (ADR 0276 `DrawnNode.size`), while it's drawn. */
  spriteSize(sprite: SpriteRenderer): [number, number] | null {
    for (const d of this.ctx.drawn()) if (d.component === sprite && d.size) return [d.size[0], d.size[1]];
    return null;
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
   * Nodes drawn under a canvas point (CSS pixels, origin top-left), topmost first: by each drawing's pick
   * order (ADR 0276: icons, then layered 2D content such as sprites and tile layers by draw
   * order, then depth-tested meshes), nearest first within an order. Uses the camera that draws the view
   * (the first in depth order). What the UI core picks (canvases and elements, ADR 0117) isn't here.
   */
  pick(x: number, y: number): GameObject[] {
    if (!this.ctx.world() || !this.hasSize()) return [];
    const hits: { node: GameObject; order: number; distance: number }[] = [];
    const ray = this.rayAt(x, y);
    const o = ray && new BabylonVector3(...ray.origin), dir = ray && new BabylonVector3(...ray.direction);
    const bray = o && dir && new BabylonRay(o, dir, 1e9);

    for (const d of this.ctx.drawn()) {
      if (d.pickable === false || !d.shape) continue;
      const shape = d.shape;
      let distance: number | null = null;
      if (shape.kind === "box") {
        continue; // a decal's volume is picked through its gizmo or the Hierarchy, never by clicking the air in it (ADR 0395)
      } else if (shape.kind === "polyline") {
        distance = this.polylineHit(shape, x, y);
      } else if (o && dir && bray) {
        if (shape.kind === "quad") distance = visible(shape.mesh) ? rayQuadDistance(o, dir, shape.mesh.getWorldMatrix()) : null;
        else distance = nearestHit(bray, o, shape.meshes);
      }
      if (distance !== null) hits.push({ node: d.component.node, order: d.order, distance });
    }
    if (ray) for (const node of this.icons.iconsAt(x, y)) hits.push({ node, order: ICON_ORDER, distance: 0 });

    hits.sort((a, b) => b.order - a.order || a.distance - b.distance);
    const seen = new Set<number>();
    return hits.filter((h) => !seen.has(h.node.entity) && seen.add(h.node.entity)).map((h) => h.node);
  }

  /**
   * A polyline's hit at a canvas point (ADR 0396): the camera distance of its nearest segment when the point is
   * within the line's half width on screen (at least 4 CSS pixels), else null.
   */
  private polylineHit(shape: Extract<DrawnShape, { kind: "polyline" }>, x: number, y: number): number | null {
    const view = this.view();
    if (!view) return null;
    const p = shape.points, n = Math.floor(p.length / 3);
    const screen: ([number, number, number] | null)[] = [];
    for (let i = 0; i < n; i++) {
      const s = view.worldToScreenPoint(new Vector3(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!));
      screen.push(s.z < view.near || s.z > view.far ? null : [s.x, s.y, s.z]);
    }
    let best: number | null = null;
    const segments = shape.closed && n > 2 ? n : n - 1;
    for (let i = 0; i < Math.max(segments, n === 1 ? 1 : 0); i++) {
      const a = screen[i], b = screen[(i + 1) % n] ?? a;
      if (!a || !b) continue;
      const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len2)) : 0;
      const px = a[0] + dx * t, py = a[1] + dy * t, depth = a[2] + (b[2] - a[2]) * t;
      // The half width on screen at that depth: a world offset across the view, projected.
      const i0 = i * 3, i1 = ((i + 1) % n) * 3;
      const wx = p[i0]! + (p[i1]! - p[i0]!) * t, wy = p[i0 + 1]! + (p[i1 + 1]! - p[i0 + 1]!) * t, wz = p[i0 + 2]! + (p[i1 + 2]! - p[i0 + 2]!) * t;
      const up = view.node.transform?.localToWorld.up;
      const side = up ? view.worldToScreenPoint(new Vector3(wx + up.x * shape.halfWidth, wy + up.y * shape.halfWidth, wz + up.z * shape.halfWidth)) : null;
      const reach = Math.max(4, side ? Math.hypot(side.x - px, side.y - py) : 0);
      if (Math.hypot(x - px, y - py) <= reach && (best === null || depth < best)) best = depth;
    }
    return best;
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
   * Where each active node under `root` with a Transform or a drawing is on the canvas: the rectangle around everything
   * drawn for it (ADR 0276: sprite quads, meshes, tile layers, water, world canvases), or (with
   * nothing drawn) a point at its origin. Nodes partly behind the camera are left out. Parents come before children.
   */
  screenBounds(root: GameObject): { node: GameObject; rect: ScreenRect }[] {
    const world = this.ctx.world(), view = this.view();
    if (!world || !view || !this.hasSize()) return [];
    const drawn = new Map<GameObject, { quads: AbstractMesh[]; meshes: AbstractMesh[]; boxes: { min: number[]; max: number[] }[] }>();
    for (const d of this.ctx.drawn()) {
      const shape = d.shape;
      if (!shape) continue;
      const node = d.component.node;
      let entry = drawn.get(node);
      if (!entry) drawn.set(node, (entry = { quads: [], meshes: [], boxes: [] }));
      if (shape.kind === "box" || shape.kind === "polyline") {
        const b = shapeWorldBox(shape);
        if (b) entry.boxes.push(b);
      }
      else if (shape.kind === "quad") entry.quads.push(...worldMeshes(d));
      else entry.meshes.push(...worldMeshes(d));
    }

    const grow = (rect: ScreenRect, p: [number, number] | null): boolean => {
      if (!p) return false;
      rect.left = Math.min(rect.left, p[0]);
      rect.right = Math.max(rect.right, p[0]);
      rect.top = Math.min(rect.top, p[1]);
      rect.bottom = Math.max(rect.bottom, p[1]);
      return true;
    };
    const boundsOf = (node: GameObject): ScreenRect | null => {
      const rect: ScreenRect = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      const d = drawn.get(node);
      if (d && d.quads.length + d.meshes.length + d.boxes.length > 0) {
        for (const b of d.boxes) {
          for (let i = 0; i < 8; i++) if (!grow(rect, project(view, i & 1 ? b.max[0]! : b.min[0]!, i & 2 ? b.max[1]! : b.min[1]!, i & 4 ? b.max[2]! : b.min[2]!))) return null;
        }
        for (const quad of d.quads) {
          const m = quad.getWorldMatrix();
          for (const [cx, cy] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
            const w = BabylonVector3.TransformCoordinates(new BabylonVector3(cx, cy, 0), m);
            if (!grow(rect, project(view, w.x, w.y, w.z))) return null;
          }
        }
        for (const mesh of d.meshes) {
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
      const rect = node.transform || drawn.has(node) ? boundsOf(node) : null;
      if (rect) out.push({ node, rect });
      for (const c of node.children) visit(c);
    };
    visit(root);
    return out;
  }

  /** The world-space box around what's drawn for `node` in the world (ADR 0276: meshes, sprite quads, tile layers, water, world canvases), or null if nothing is. */
  drawnBounds(node: GameObject): WorldBox | null {
    const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    let any = false;
    for (const d of this.ctx.drawn()) {
      if (d.component.node !== node) continue;
      const b = d.shape ? shapeWorldBox(d.shape) : null;
      if (b) {
        for (let i = 0; i < 3; i++) {
          min[i] = Math.min(min[i]!, b.min[i]!);
          max[i] = Math.max(max[i]!, b.max[i]!);
        }
        any = true;
      }
      for (const mesh of worldMeshes(d)) {
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
 * Distance along a world ray (`ray`, from `origin`) to the nearest hit on `meshes`' triangles (visible ones),
 * or null. Babylon's mesh test takes the ray in the mesh's own space and measures the hit there: the hit
 * point goes back to world space for a distance comparable across meshes.
 *
 * A mesh whose vertices live only on the GPU (a skinned draw skinned by WebGPU compute or WebGL2 transform
 * feedback, ADR 0370, T18) has no positions for the triangle test: it's hit by its bounding box instead (the
 * skinned draw's bounds, from the animated bones or its fixed box). That is coarser: a click in the box but
 * beside the body (between the legs, past a hand) still picks it, and the nearest-first order compares the
 * box's face rather than the surface. Exact picking would need a CPU copy of the skinned vertices each frame,
 * which is what GPU skinning avoids.
 */
function nearestHit(ray: BabylonRay, origin: BabylonVector3, meshes: readonly AbstractMesh[]): number | null {
  let nearest = Infinity;
  for (const mesh of meshes) {
    if (!visible(mesh)) continue;
    const world = mesh.getWorldMatrix();
    const local = BabylonRay.Transform(ray, world.clone().invert());
    let distance: number | null;
    if (mesh.getVerticesData(VertexBuffer.PositionKind)) {
      const info = mesh.intersects(local, false);
      distance = info.hit ? info.distance : null;
    } else {
      const box = mesh.getBoundingInfo().boundingBox;
      distance = rayBoxDistance(local, box.minimum, box.maximum);
    }
    if (distance === null) continue;
    const point = BabylonVector3.TransformCoordinates(local.origin.add(local.direction.scale(distance)), world);
    nearest = Math.min(nearest, BabylonVector3.Distance(origin, point));
  }
  return nearest < Infinity ? nearest : null;
}

/**
 * Distance along `ray` (in the box's space) to where it enters the box `min`..`max` (0 from inside), or null when it
 * misses or the box is behind it. The slab test.
 */
function rayBoxDistance(ray: BabylonRay, min: BabylonVector3, max: BabylonVector3): number | null {
  let near = 0, far = ray.length;
  const o = [ray.origin.x, ray.origin.y, ray.origin.z], d = [ray.direction.x, ray.direction.y, ray.direction.z];
  const lo = [min.x, min.y, min.z], hi = [max.x, max.y, max.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]!) < 1e-12) {
      if (o[i]! < lo[i]! || o[i]! > hi[i]!) return null;
      continue;
    }
    let t1 = (lo[i]! - o[i]!) / d[i]!, t2 = (hi[i]! - o[i]!) / d[i]!;
    if (t1 > t2) [t1, t2] = [t2, t1];
    near = Math.max(near, t1);
    far = Math.min(far, t2);
    if (near > far) return null;
  }
  return near;
}

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
