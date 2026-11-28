/**
 * The editor's guides on the Babylon backend (ADR 0022, 0065, 0075 stage 8, 0128): the grid and axes,
 * selection outlines, and the overlay the editor supplies every frame (collider outlines, handles,
 * bulk segments such as navigation debug drawing).
 *
 * The grid and axes are in the main scene (editor Worlds only); the rest is in the overlay scene
 * (`editorBatches.ts`). A game's surface has no grid but draws the overlay and the live selection outline.
 */
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { Vector3 as EngineVector3 } from "../../core/math";
import type { GameObject } from "../../scene/GameObject";
import type { EditorColors, EditorOverlay } from "../editorViewport";
import { srgbToLinear } from "../../core/colorSpace";
import { b8, g8, LineBatch, OVERLAY_GROUP, overlayMaterial, partOfMesh, r8, type View } from "./editorBatches";
import { EDITOR_LAYER_MASK, type BabylonEditorContext } from "./editorContext";
import { shapeWorldBox } from "./feature";
import type { IconStyle } from "./editorIcons";

const DEFAULT_EDITOR_COLORS: EditorColors = { background: 0x24272d, grid: 0x3a3f47, gridCenter: 0x5a606b, outline: 0x4c8dff, cameraGizmo: 0xc9ccd1 };
/** An overlay handle's size on screen, CSS pixels. */
const HANDLE_SIZE = 9;

/** Grid lines per side for a cell size: about 40 m across, between 10 and 400 lines. */
function gridDivisions(cell: number): number {
  return Math.min(400, Math.max(10, Math.round(40 / cell)));
}

// --- Handle batches ----------------------------------------------------------------------------

/** One mesh of camera-facing coloured squares, rebuilt each frame in place (a handle is 4 vertices). */
class HandleBatch {
  readonly mesh: Mesh;
  count = 0;
  private positions = new Float32Array(0);
  private colors = new Float32Array(0);
  private capacity = 0;

  constructor(scene: Scene, name: string, group: number, material: StandardMaterial) {
    this.mesh = new Mesh(name, scene);
    this.mesh.material = material;
    this.mesh.renderingGroupId = group;
    this.mesh.isPickable = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.isVisible = false;
  }

  begin(capacity: number): void {
    this.count = 0;
    if (capacity <= this.capacity) return;
    this.capacity = Math.max(16, 2 ** Math.ceil(Math.log2(capacity)));
    this.positions = new Float32Array(this.capacity * 12);
    this.colors = new Float32Array(this.capacity * 16);
    const indices = new Uint32Array(this.capacity * 6);
    for (let q = 0; q < this.capacity; q++) indices.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
    this.mesh.setVerticesData(VertexBuffer.PositionKind, this.positions, true, 3);
    this.mesh.setVerticesData(VertexBuffer.ColorKind, this.colors, true, 4);
    this.mesh.setIndices(indices, this.capacity * 4);
  }

  /** A square around (x, y, z) with half-sides `r` and `u` along the right and up vectors. */
  quad(x: number, y: number, z: number, rx: number, ry: number, rz: number, ux: number, uy: number, uz: number, cr: number, cg: number, cb: number): void {
    const p = this.positions, c = this.colors;
    let i = this.count * 12;
    const corner = (sr: number, su: number): void => {
      p[i++] = x + rx * sr + ux * su;
      p[i++] = y + ry * sr + uy * su;
      p[i++] = z + rz * sr + uz * su;
    };
    corner(-1, -1); corner(1, -1); corner(1, 1); corner(-1, 1);
    i = this.count * 16;
    for (let k = 0; k < 4; k++) {
      c[i++] = cr; c[i++] = cg; c[i++] = cb; c[i++] = 1;
    }
    this.count++;
  }

  end(): void {
    if (this.count > 0) {
      this.mesh.updateVerticesData(VertexBuffer.PositionKind, this.positions);
      this.mesh.updateVerticesData(VertexBuffer.ColorKind, this.colors);
      const sub = this.mesh.subMeshes[0];
      if (sub) partOfMesh(sub, this.count * 6);
    }
    this.mesh.isVisible = this.count > 0;
  }

  dispose(): void {
    this.mesh.dispose(false, false);
  }
}

interface Outline {
  batch: LineBatch;
  box: boolean;
}

const tmpA = new Matrix();
const tmpB = new Matrix();
const tmpScale = new Vector3();

/** @internal The grid, selection outlines and editor overlay of one Babylon surface. */
export class BabylonEditorGuides implements IconStyle {
  private colorsNow: EditorColors = { ...DEFAULT_EDITOR_COLORS };
  private readonly utility: Scene;

  // Grid and axes (main scene).
  private grid: LineBatch | null = null;
  private axes: LineBatch | null = null;
  private gridPlane: "xz" | "xy" = "xz";
  private gridCell = 1;
  private gridVisible = true;

  // Selection.
  private readonly outlined = new Set<GameObject>();
  private outlineShown = true;
  private readonly spriteOutlines: Outline[] = [];
  private readonly boxOutlines: Outline[] = [];

  // Overlay.
  private provider: (() => EditorOverlay) | null = null;
  private overlayLines: LineBatch | null = null;
  private handles: HandleBatch | null = null;
  private handleMaterial: StandardMaterial | null = null;
  private handleIds: string[] = [];
  private handlePositions = new Float32Array(0);
  private readonly overlaySegments: { positions: Float32Array; color: number; batch: LineBatch }[] = [];

  constructor(private readonly ctx: BabylonEditorContext) {
    this.utility = ctx.overlay.utilityLayerScene;
    if (ctx.editor) this.buildGrid();
  }

  /** The editor's colours now. */
  get colors(): EditorColors {
    return this.colorsNow;
  }

  // --- Grid and axes (main scene) ---------------------------------------------------------------

  /** Recolour the grid and outlines (the editor's theme). The grid bakes its colours into its vertices, so it is rebuilt. */
  setColors(colors: EditorColors): void {
    this.colorsNow = { ...colors };
    if (this.grid) this.buildGrid();
    this.recolorOutlines();
  }

  /** Lay the grid on the ground (XZ, 3D view) or facing the camera (XY, 2D view), `cellSize` metres apart, shown or not. Editor Worlds only. */
  setGrid(plane: "xz" | "xy", cellSize: number, visible: boolean): void {
    this.gridPlane = plane;
    if (!this.grid) return;
    this.grid.mesh.rotation.x = plane === "xy" ? Math.PI / 2 : 0;
    const cell = cellSize > 0 && Number.isFinite(cellSize) ? cellSize : 1;
    this.gridVisible = visible;
    if (cell !== this.gridCell) {
      this.gridCell = cell;
      this.buildGrid();
    }
    this.grid.visible = visible;
  }

  /** The grid's cell size, line count and visibility; null where there is no grid (a game's surface). */
  gridShown(): { cellSize: number; visible: boolean; divisions: number } | null {
    return this.grid ? { cellSize: this.gridCell, visible: this.gridVisible, divisions: gridDivisions(this.gridCell) } : null;
  }

  /** (Re)build the grid and, the first time, the axes: `cell` metres between lines, in linear light (the main scene's space). */
  private buildGrid(): void {
    const scene = this.ctx.scene;
    this.grid?.dispose();
    const grid = (this.grid = new LineBatch(scene, "myco.editor.grid", 0, false));
    const n = gridDivisions(this.gridCell), cell = this.gridCell, half = (n * cell) / 2, center = n / 2;
    const lin = (c: number): [number, number, number] => [srgbToLinear(r8(c)), srgbToLinear(g8(c)), srgbToLinear(b8(c))];
    const major = lin(this.colorsNow.gridCenter), minor = lin(this.colorsNow.grid);
    grid.begin();
    for (let i = 0; i <= n; i++) {
      const k = -half + i * cell, [r, g, b] = i === center ? major : minor;
      grid.line(-half, 0, k, half, 0, k, r, g, b, 1);
      grid.line(k, 0, -half, k, 0, half, r, g, b, 1);
    }
    grid.end();
    grid.mesh.layerMask = EDITOR_LAYER_MASK; // game cameras (previews, probes) never see it
    grid.mesh.rotation.x = this.gridPlane === "xy" ? Math.PI / 2 : 0;
    grid.visible = this.gridVisible;
    if (!this.axes) {
      // Three's AxesHelper(1.5): each axis fades from its colour to a tint, drawn in linear light.
      const axes = (this.axes = new LineBatch(scene, "myco.editor.axes", 0, false));
      axes.begin();
      axes.line(0, 0, 0, 1.5, 0, 0, 1, 0, 0, 1);
      axes.line(0, 0, 0, 0, 1.5, 0, 0, 1, 0, 1);
      axes.line(0, 0, 0, 0, 0, 1.5, 0, 0, 1, 1);
      axes.end();
      axes.mesh.layerMask = EDITOR_LAYER_MASK;
    }
  }

  // --- Selection outlines -----------------------------------------------------------------------

  /** Outline the sprites and meshes of these nodes and their descendants every frame, or keep them hidden (`shown` false: play mode's Gizmos menu). */
  setSelection(nodes: readonly GameObject[], shown: boolean): void {
    this.outlined.clear();
    for (const n of nodes) this.outlined.add(n);
    this.outlineShown = shown;
  }

  /** True if the node or an ancestor is selected for outlining. */
  isOutlined(node: GameObject): boolean {
    for (const n of this.outlined) {
      if (!n.isValid) continue;
      for (let p: GameObject | null = node; p; p = p.parent) if (p === n) return true;
    }
    return false;
  }

  private makeOutline(box: boolean): Outline {
    const batch = new LineBatch(this.utility, box ? "myco.editor.boxOutline" : "myco.editor.outline", OVERLAY_GROUP.outlines, false);
    this.fillOutline(batch, box);
    const outline = { batch, box };
    (box ? this.boxOutlines : this.spriteOutlines).push(outline);
    batch.mesh.rotationQuaternion = new Quaternion();
    return outline;
  }

  /** A unit loop (a sprite's quad) or a unit cube's twelve edges, in the selection colour. */
  private fillOutline(batch: LineBatch, box: boolean): void {
    const c = this.colorsNow.outline, r = r8(c), g = g8(c), b = b8(c);
    batch.begin();
    if (box) {
      const corner = (i: number): [number, number, number] => [i & 1 ? 0.5 : -0.5, i & 2 ? 0.5 : -0.5, i & 4 ? 0.5 : -0.5];
      for (const [a, z] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) batch.line(...corner(a), ...corner(z), r, g, b, 1);
    } else {
      const p: [number, number][] = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
      for (let i = 0; i < 4; i++) batch.line(p[i][0], p[i][1], 0, p[(i + 1) % 4][0], p[(i + 1) % 4][1], 0, r, g, b, 1);
    }
    batch.end();
  }

  private recolorOutlines(): void {
    for (const o of this.spriteOutlines) this.fillOutline(o.batch, false);
    for (const o of this.boxOutlines) this.fillOutline(o.batch, true);
  }

  /** Put an outline on a mesh's local bounds: its world matrix, then the box's centre and size. */
  private placeOutline(outline: Outline, mesh: AbstractMesh, flat: boolean): void {
    const bounds = mesh.getBoundingInfo().boundingBox;
    const min = bounds.minimum, max = bounds.maximum;
    Matrix.ScalingToRef(Math.max(max.x - min.x, 1e-4), Math.max(max.y - min.y, 1e-4), flat ? 1 : Math.max(max.z - min.z, 1e-4), tmpA);
    tmpA.setTranslationFromFloats((min.x + max.x) / 2, (min.y + max.y) / 2, flat ? (min.z + max.z) / 2 : (min.z + max.z) / 2);
    tmpA.multiplyToRef(mesh.computeWorldMatrix(true), tmpB);
    const m = outline.batch.mesh;
    tmpB.decompose(tmpScale, m.rotationQuaternion!, m.position);
    m.scaling.copyFrom(tmpScale);
    outline.batch.visible = true;
  }

  /**
   * Position a flat outline around each selected node's quads (sprites) and a box around each of its
   * meshes (MeshRenderers, tile layers, water, world canvases), whichever feature drew them (ADR 0276).
   */
  private syncOutlines(): void {
    let used = 0, boxes = 0;
    if (this.outlined.size > 0 && this.outlineShown) {
      for (const d of this.ctx.drawn()) {
        const shape = d.shape;
        if (!shape || !this.isOutlined(d.component.node)) continue;
        if (shape.kind === "box" || shape.kind === "polyline") {
          // A decal's volume is outlined by itself; a line by the box around it (ADR 0395, 0396).
          if (shape.kind === "box") Matrix.FromArrayToRef(shape.matrix as number[], 0, tmpB);
          else {
            const b = shapeWorldBox(shape);
            if (!b) continue;
            Matrix.ScalingToRef(Math.max(b.max[0] - b.min[0], 1e-4), Math.max(b.max[1] - b.min[1], 1e-4), Math.max(b.max[2] - b.min[2], 1e-4), tmpB);
            tmpB.setTranslationFromFloats((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
          }
          const outline = this.boxOutlines[boxes] ?? this.makeOutline(true);
          const m = outline.batch.mesh;
          tmpB.decompose(tmpScale, m.rotationQuaternion!, m.position);
          m.scaling.copyFrom(tmpScale);
          outline.batch.visible = true;
          boxes++;
          continue;
        }
        if (shape.kind === "quad") {
          if (!shape.mesh.isEnabled() || !shape.mesh.isVisible) continue;
          this.placeOutline(this.spriteOutlines[used] ?? this.makeOutline(false), shape.mesh, true);
          used++;
          continue;
        }
        for (const m of shape.meshes) {
          if (!m.isEnabled() || !m.isVisible) continue;
          this.placeOutline(this.boxOutlines[boxes] ?? this.makeOutline(true), m, false);
          boxes++;
        }
      }
    }
    for (let i = used; i < this.spriteOutlines.length; i++) this.spriteOutlines[i].batch.visible = false;
    for (let i = boxes; i < this.boxOutlines.length; i++) this.boxOutlines[i].batch.visible = false;
  }

  // --- Frame ------------------------------------------------------------------------------------

  /**
   * Each frame after the renderer's sync, before the overlay scene draws: place the outlines and the
   * overlay, facing `view`. Editor Worlds draw both; a game or play World draws only the overlay
   * (navigation debug drawing, ADR 0065) and the live selection outline.
   */
  sync(view: View | null): void {
    if (this.ctx.editor) {
      this.syncOutlines();
      this.syncOverlay(view);
    } else {
      if (this.provider || this.overlayLines?.visible || this.overlaySegments.length > 0) this.syncOverlay(view); // one more pass clears it when removed
      if (this.outlined.size > 0 || this.spriteOutlines.some((o) => o.batch.visible) || this.boxOutlines.some((o) => o.batch.visible)) this.syncOutlines();
    }
  }

  // --- Overlay ----------------------------------------------------------------------------------

  /** Draw what `provider` returns every frame (null stops). */
  setOverlay(provider: (() => EditorOverlay) | null): void {
    this.provider = provider;
  }

  private syncOverlay(view: View | null): void {
    const overlay = this.provider?.() ?? { lines: [], handles: [] };
    // Lines: one batch with per-vertex colours, refilled each frame.
    this.overlayLines ??= new LineBatch(this.utility, "myco.editor.overlayLines", OVERLAY_GROUP.lines, true);
    const lines = this.overlayLines;
    lines.begin();
    for (const line of overlay.lines) {
      const p = line.points, n = line.closed ? p.length : p.length - 1;
      const r = r8(line.color), g = g8(line.color), b = b8(line.color);
      for (let i = 0; i < n; i++) {
        const a = p[i], q = p[(i + 1) % p.length];
        lines.line(a[0], a[1], a[2], q[0], q[1], q[2], r, g, b, 0.9);
      }
    }
    lines.end();
    this.syncOverlaySegments(overlay.segments ?? []);
    this.syncHandles(overlay.handles, view);
  }

  /** Handles: squares of a fixed size on screen, facing the camera, drawn above everything else. */
  private syncHandles(handles: EditorOverlay["handles"], v: View | null): void {
    this.handleMaterial ??= overlayMaterial(this.utility, "myco.editor.handles");
    const batch = (this.handles ??= new HandleBatch(this.utility, "myco.editor.handles", OVERLAY_GROUP.handles, this.handleMaterial));
    this.handleIds = handles.map((h) => h.id);
    if (this.handlePositions.length < handles.length * 3) this.handlePositions = new Float32Array(Math.max(16, 2 ** Math.ceil(Math.log2(handles.length))) * 3);
    batch.begin(handles.length);
    handles.forEach((h, i) => {
      const [x, y, z] = h.position;
      this.handlePositions.set(h.position, i * 3);
      if (!v) return;
      const depth = (x - v.px) * v.fx + (y - v.py) * v.fy + (z - v.pz) * v.fz;
      const perPixel = v.ortho ? (2 * v.camera.orthographicSize) / v.pixels : (2 * Math.max(depth, 1e-3) * Math.tan((v.camera.fieldOfView * Math.PI) / 360)) / v.pixels;
      const half = (HANDLE_SIZE / 2) * perPixel;
      batch.quad(x, y, z, v.rx * half, v.ry * half, v.rz * half, v.ux * half, v.uy * half, v.uz * half, r8(h.color), g8(h.color), b8(h.color));
    });
    batch.end();
  }

  /**
   * Bulk segment groups (navigation debug drawing, ADR 0065): one batch per group, drawn straight from the
   * group's Float32Array. Providers hand back the same array while nothing changed (they memoise), so a group is
   * uploaded to the GPU only when its array or colour changes, not every frame.
   */
  private syncOverlaySegments(groups: readonly { positions: Float32Array; color: number }[]): void {
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      let slot = this.overlaySegments[i];
      if (slot && slot.positions === group.positions && slot.color === group.color) continue;
      if (!slot) {
        slot = { positions: group.positions, color: group.color, batch: new LineBatch(this.utility, `myco.editor.segments.${i}`, OVERLAY_GROUP.lines, true) };
        this.overlaySegments.push(slot);
      }
      const vertices = Math.floor(group.positions.length / 3);
      const colors = new Float32Array(vertices * 4);
      const r = r8(group.color), g = g8(group.color), b = b8(group.color);
      for (let k = 0; k < vertices; k++) colors.set([r, g, b, 0.9], k * 4);
      slot.batch.setStatic(group.positions.subarray(0, vertices * 3), colors, vertices);
      slot.positions = group.positions;
      slot.color = group.color;
    }
    for (const slot of this.overlaySegments.splice(groups.length)) slot.batch.dispose();
  }

  /** Where each overlay handle is on the canvas (CSS pixels); handles behind the camera are left out. */
  overlayHandles(): { id: string; x: number; y: number }[] {
    const view = this.ctx.viewCameras()[0];
    if (!view || !this.handles?.mesh.isVisible) return [];
    const out: { id: string; x: number; y: number }[] = [];
    this.handleIds.forEach((id, i) => {
      const s = view.worldToScreenPoint(new EngineVector3(this.handlePositions[i * 3], this.handlePositions[i * 3 + 1], this.handlePositions[i * 3 + 2]));
      if (s.z >= view.near && s.z <= view.far) out.push({ id, x: s.x, y: s.y });
    });
    return out;
  }

  dispose(): void {
    for (const b of [this.grid, this.axes, this.overlayLines]) b?.dispose();
    for (const o of [...this.spriteOutlines, ...this.boxOutlines]) o.batch.dispose();
    for (const s of this.overlaySegments) s.batch.dispose();
    this.handles?.dispose();
    this.handleMaterial?.dispose(false, true);
    this.spriteOutlines.length = this.boxOutlines.length = this.overlaySegments.length = 0;
    this.grid = this.axes = this.overlayLines = null;
    this.handles = null;
    this.handleMaterial = null;
  }
}
