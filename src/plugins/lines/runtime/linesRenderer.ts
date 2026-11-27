/**
 * Line and trail drawing (ADR 0396), renderer-neutral: each `LineRenderer` and `TrailRenderer` becomes one ribbon
 * (`ribbon.ts`), drawn through the renderer core's dynamic meshes in 3D (camera-facing or flat, with a material asset)
 * or its quad batches in 2D (layered with sprites in a sorting layer, ADR 0186). The renderer knows meshes and quads;
 * this module knows lines. It is the Lines plugin's render feature (ADR 0130, 0418), loaded by the renderer from the
 * loader the plugin registers, so it stays out of the `myco` module. No Babylon here (ADR 0075): it's unit-tested
 * against fake hosts.
 */
import type { Component } from "../../../engine/core/Component";
import { evalCurve, type Curve } from "../../../engine/core/curve";
import { evaluateGradient, isGradient, type Gradient } from "../../../engine/core/gradient";
import type { World } from "../../../engine/core/World";
import { PICK_ORDER, type BabylonFeature, type BabylonFeatureFactory, type DrawnNode } from "../../../engine/render/babylon/feature";
import { drawPlace, ySortWithin } from "../../../engine/render/sortOrder";
import type { DynamicMesh, DynamicMeshHost } from "../../../engine/render/dynamicMeshes";
import type { QuadBatch, QuadBatchHost } from "../../../engine/render/quadBatches";
import { LineRenderer } from "./LineRenderer";
import { buildRibbon, type RibbonMesh } from "./ribbon";
import type { RibbonRenderer } from "./RibbonRenderer";
import { TrailRenderer } from "./TrailRenderer";

/** What the line drawing borrows from the renderer. */
export interface LinesHost {
  readonly dynamicMeshes: DynamicMeshHost;
  readonly quads: QuadBatchHost;
}

/** A ribbon drawn now (ADR 0276): its Component, its centre line in world space, its widest half width, and how it's picked. */
interface DrawnRibbon {
  readonly component: RibbonRenderer;
  /** xyz per point, world space. */
  readonly points: Float32Array;
  readonly halfWidth: number;
  readonly closed: boolean;
  /** 2D: its draw order (layered); 3D: null (depth-tested). */
  readonly order: number | null;
}

interface Entry {
  mesh: DynamicMesh | null;
  batch: QuadBatch | null;
  drawn: DrawnRibbon | null;
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const WHITE: Gradient = { colors: [[0, "#ffffff"]], alphas: [[0, 1]] };

/** A curve field as scenes and scripts hold it, or a flat 1 when it isn't one. */
const curveOf = (v: unknown): Curve => (Array.isArray(v) && v.length > 0 ? (v as Curve) : [[0, 1]]);

/** @internal Lines and trails: the Lines plugin's render feature. Syncs in `content`, after the meshes (`after` constraint, ADR 0135). */
export class LinesRenderer implements BabylonFeature {
  private readonly entries = new Map<RibbonRenderer, Entry>();

  constructor(private readonly host: LinesHost) {}

  sync(world: World): void {
    const seen = new Set<RibbonRenderer>();
    for (const c of world._componentsOfType(LineRenderer)) {
      seen.add(c);
      this.syncOne(world, c);
    }
    for (const c of world._componentsOfType(TrailRenderer)) {
      seen.add(c);
      this.syncOne(world, c);
    }
    for (const c of [...this.entries.keys()]) if (!seen.has(c)) this.release(c);
  }

  /** ADR 0276: each visible ribbon as a polyline (its camera-facing triangles have no CPU shape): 2D ones at their draw order, 3D ones depth-tested. */
  *drawn(): Iterable<DrawnNode> {
    for (const e of this.entries.values()) {
      const r = e.drawn;
      if (r) yield { component: r.component, shape: { kind: "polyline", points: r.points, halfWidth: r.halfWidth, closed: r.closed }, order: r.order ?? PICK_ORDER.depthTested };
    }
  }

  /** Whether every 3D ribbon's material and texture have loaded. */
  loaded(): boolean {
    for (const e of this.entries.values()) if (e.mesh && e.drawn && !e.mesh.loaded()) return false;
    return true;
  }

  /** Counts for the diagnostics (`features.lines`). */
  diagnostics(): { lines: number; trails: number; points: number; meshes: number } {
    let lines = 0, trails = 0, points = 0, meshes = 0;
    for (const [c, e] of this.entries) {
      if (!e.drawn) continue;
      if (c instanceof TrailRenderer) trails++;
      else lines++;
      points += e.drawn.points.length / 3;
      meshes++;
    }
    return { lines, trails, points, meshes };
  }

  release(c: Component): void {
    const e = this.entries.get(c as RibbonRenderer);
    if (!e) return;
    e.mesh?.dispose();
    e.batch?.dispose();
    this.entries.delete(c as RibbonRenderer);
  }

  dispose(): void {
    for (const c of [...this.entries.keys()]) this.release(c);
  }

  private syncOne(world: World, c: RibbonRenderer): void {
    let e = this.entries.get(c);
    if (!e) this.entries.set(c, (e = { mesh: null, batch: null, drawn: null }));
    const hide = (): void => {
      e.mesh?.setVisible(false);
      e.batch?.setVisible(false);
      e.drawn = null;
    };
    if (!c.isActiveAndEnabled || !c.node.transform) return hide();

    const node = world.worldMatrix(c.node.entity), at = c.node.entity * 16;
    const local = c instanceof LineRenderer && !c.useWorldSpace;
    const matrix = local ? node.subarray(at, at + 16) : IDENTITY;
    const { points, params, closed } = c instanceof LineRenderer ? lineSource(c) : trailSource(c as TrailRenderer);
    if (points.length < 6) return hide();

    // Width and colour per point, from the curve and gradient at the point's parameter.
    const n = points.length / 3;
    const halfWidths = new Float32Array(n);
    const colors = new Float32Array(n * 4);
    const curve = curveOf(c.widthCurve);
    const gradient = isGradient(c.colorGradient) ? c.colorGradient : WHITE;
    const rgba = [0, 0, 0, 0];
    const tint = c.color;
    for (let i = 0; i < n; i++) {
      const u = params[i]!;
      halfWidths[i] = Math.max(0, (c.width * evalCurve(curve, u)) / 2);
      evaluateGradient(gradient, u, rgba);
      colors[i * 4] = rgba[0]! * tint.r;
      colors[i * 4 + 1] = rgba[1]! * tint.g;
      colors[i * 4 + 2] = rgba[2]! * tint.b;
      colors[i * 4 + 3] = rgba[3]! * tint.a;
    }

    const twoD = c.mode === "2d";
    // A flat ribbon's face normal in the points' space: 2D lies in the XY plane; transformZ faces the node's +Z.
    let normal: [number, number, number] | null = null;
    if (twoD || c.alignment === "transformZ") {
      if (local || twoD) normal = [0, 0, 1];
      else {
        const l = Math.hypot(node[at + 8]!, node[at + 9]!, node[at + 10]!) || 1;
        normal = [node[at + 8]! / l, node[at + 9]! / l, node[at + 10]! / l];
      }
    }
    const mesh = buildRibbon({
      points,
      closed,
      halfWidths,
      colors,
      cornerVertices: c.cornerVertices,
      capVertices: c.capVertices,
      textureMode: c.textureMode,
      textureScale: [c.textureScale.x, c.textureScale.y],
      normal,
    });
    if (!mesh) return hide();

    let order: number | null = null;
    if (twoD) {
      e.mesh?.dispose();
      e.mesh = null;
      // In a y-sorted layer its sort point is its node's world position (ADR 0440).
      const y = node[at + 13]!;
      order = drawPlace(world.settings.render, c.sortingLayer, c.orderInLayer, y);
      this.draw2D(e, c, mesh, matrix, ySortWithin(world.settings.render, c.sortingLayer, y));
    } else {
      e.batch?.dispose();
      e.batch = null;
      this.draw3D(e, c, mesh, matrix);
    }
    let widest = 0;
    for (let i = 0; i < n; i++) widest = Math.max(widest, halfWidths[i]!);
    e.drawn = { component: c, points: local ? transformed(points, matrix) : Float32Array.from(points), halfWidth: widest, closed, order };
  }

  private draw3D(e: Entry, c: RibbonRenderer, mesh: RibbonMesh, matrix: ArrayLike<number>): void {
    if (!e.mesh) e.mesh = this.host.dynamicMeshes.createMesh(`${c instanceof TrailRenderer ? "trail" : "line"}:${c.node.name}`);
    e.mesh.setGeometry({ positions: mesh.positions, uvs: mesh.uvs, colors: mesh.colors, indices: mesh.indices, normals: mesh.normals, ribbon: mesh.ribbon });
    e.mesh.setLook(c.material, c.texture);
    e.mesh.setShadows(c.castShadows, c.receiveShadows);
    e.mesh.setMatrix(matrix);
    e.mesh.setVisible(true);
  }

  private draw2D(e: Entry, c: RibbonRenderer, mesh: RibbonMesh, matrix: ArrayLike<number>, within: number): void {
    if (!e.batch) e.batch = this.host.quads.createBatch(`${c instanceof TrailRenderer ? "trail" : "line"}2d:${c.node.name}`);
    // ADR 0399: lit by 2D lights unless its material is Sprite Unlit; normal maps follow the line (its U runs along it).
    e.batch.setOrder(c.sortingLayer, c.orderInLayer, within);
    e.batch.setMaterial(c.material);
    e.batch.setTriangles(c.texture, mesh.positions, mesh.uvs, mesh.indices, mesh.colors);
    e.batch.setTint("#ffffff", 1);
    e.batch.setMatrix(matrix);
    e.batch.setVisible(true);
  }
}

declare module "../../../engine/render/RenderSurface" {
  interface RenderFeatureDiagnostics {
    /** The Lines plugin's (ADR 0396): ribbons drawn now, their points and meshes. */
    lines?: { lines: number; trails: number; points: number; meshes: number };
  }
}

/** @internal Builds the feature from the renderer's shared services: the dynamic meshes and the quad batches. */
export const createLinesFeature: BabylonFeatureFactory = (host) => new LinesRenderer({ dynamicMeshes: host.dynamicMeshes, quads: host.quads });

/** A line's points (in its own space) and each point's parameter: its distance along the line over the line's length. */
function lineSource(c: LineRenderer): { points: Float32Array; params: Float32Array; closed: boolean } {
  const list = Array.isArray(c.positions) ? c.positions : [];
  const points = new Float32Array(list.length * 3);
  list.forEach((p, i) => points.set([p?.x ?? 0, p?.y ?? 0, p?.z ?? 0], i * 3));
  const n = list.length;
  const params = new Float32Array(n);
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += Math.hypot(points[i * 3]! - points[i * 3 - 3]!, points[i * 3 + 1]! - points[i * 3 - 2]!, points[i * 3 + 2]! - points[i * 3 - 1]!);
    params[i] = total;
  }
  for (let i = 0; i < n; i++) params[i] = total > 0 ? params[i]! / total : n > 1 ? i / (n - 1) : 0;
  return { points, params, closed: c.loop };
}

/** A trail's points, newest (the head) first, in world space, and each one's parameter: its age over the trail's lifetime. */
function trailSource(c: TrailRenderer): { points: Float32Array; params: Float32Array; closed: boolean } {
  const fixed = c._ages.length;
  const n = fixed + (c._head ? 1 : 0);
  const points = new Float32Array(n * 3);
  const params = new Float32Array(n);
  const life = c.lifetime > 0 ? c.lifetime : 1;
  let k = 0;
  if (c._head) {
    points.set(c._head, 0);
    params[0] = 0;
    k = 1;
  }
  for (let i = fixed - 1; i >= 0; i--, k++) {
    points[k * 3] = c._points[i * 3]!;
    points[k * 3 + 1] = c._points[i * 3 + 1]!;
    points[k * 3 + 2] = c._points[i * 3 + 2]!;
    params[k] = Math.min(1, c._ages[i]! / life);
  }
  return { points, params, closed: false };
}

/** Points under a column-major matrix. */
function transformed(points: Float32Array, m: ArrayLike<number>): Float32Array {
  const out = new Float32Array(points.length);
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i]!, y = points[i + 1]!, z = points[i + 2]!;
    out[i] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    out[i + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    out[i + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  }
  return out;
}
