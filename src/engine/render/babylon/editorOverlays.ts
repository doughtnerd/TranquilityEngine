/**
 * Stage 8 of ADR 0075 (ADR 0022 and 0043): the editor's drawing helpers on the Babylon backend, the
 * same set as the three.js backend's `RenderBackend`: the grid and axes, selection outlines, the
 * editor overlay (collider outlines, handles, bulk segments), camera gizmos (icon and frustum) and
 * light gizmos (icon and wireframe).
 *
 * Two scenes (`editorContext.ts`):
 * - The grid and axes live in the main scene, which the frame graph renders in linear light and the
 *   finish pass encodes to sRGB. Their colours are therefore converted from sRGB to linear here,
 *   and meshes hide them (depth test). They exist in editor Worlds only.
 * - Everything else lives in the overlay scene (a utility layer) that draws after the frame graph,
 *   straight onto the canvas, never post-processed. A utility layer scene has no image processing
 *   (`imageProcessingConfiguration.isEnabled` is false, checked by the tests), so colours are passed as
 *   the sRGB values they are and come out unchanged. Lines use Babylon's own `color` shader, which writes
 *   its vertex colour as is; quads (handles, icons) use an emissive `StandardMaterial`, which does the same.
 *
 * Draw order comes from rendering groups (Babylon clears depth between them), standing in for three's
 * `renderOrder`, so each of these sits above the last: `OVERLAY_GROUP`. The transform gizmo belongs between
 * the icons and the handles.
 *
 * Per-frame paths reuse their meshes and typed arrays, updating vertex data in place.
 */
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { LinesMesh } from "@babylonjs/core/Meshes/linesMesh.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { Vector3 as EngineVector3 } from "../../core/math";
import type { World } from "../../core/World";
import type { GameObject } from "../../scene/GameObject";
import { frustumSegments } from "../cameraGizmo";
import { Camera, Light } from "../components";
import type { EditorColors, EditorOverlay } from "../RenderSurface";
import { EDITOR_LAYER_MASK, type BabylonEditorContext } from "./editorContext";

/** Rendering groups of the overlay scene, back to front (Babylon has four). */
export const OVERLAY_GROUP = { lines: 0, wires: 1, outlines: 2, icons: 2, handles: 3 } as const;

const DEFAULT_EDITOR_COLORS: EditorColors = { background: 0x24272d, grid: 0x3a3f47, gridCenter: 0x5a606b, outline: 0x4c8dff, cameraGizmo: 0xc9ccd1 };
/** Icon sizes (a fraction of the view's height, as three.js's constant-size sprites) and the click radius in CSS pixels. */
const CAMERA_ICON_SIZE = 0.065;
const LIGHT_ICON_SIZE = 0.055;
const ICON_PICK_RADIUS = 16;
/** An overlay handle's size on screen, CSS pixels. */
const HANDLE_SIZE = 9;

type Seg = [[number, number, number], [number, number, number]];

// --- Colours ---------------------------------------------------------------------------------

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function r8(c: number): number { return ((c >> 16) & 255) / 255; }
function g8(c: number): number { return ((c >> 8) & 255) / 255; }
function b8(c: number): number { return (c & 255) / 255; }

// --- Line batches ------------------------------------------------------------------------------

/**
 * One `LinesMesh` drawing many segments with per-vertex colours (rgba). Fill it each frame with
 * `begin`, `line`, `end`: its typed arrays only grow (to a power of two), and a frame that fits just
 * updates the vertex buffers and shortens the draw.
 */
class LineBatch {
  readonly mesh: LinesMesh;
  /** Vertices in use (two per segment). */
  count = 0;
  private positions: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private colors: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private capacity = 0;
  private shown = true;
  private regrown = false;
  /** Something written since the last upload differs from what the buffers hold (or the count changed). */
  private dirty = false;
  /** Vertices in the buffers at the last upload. */
  private uploaded = 0;

  constructor(scene: Scene, name: string, group: number, alpha: boolean, onDraw?: () => void) {
    this.mesh = new LinesMesh(name, scene, null, null, undefined, true, alpha);
    this.mesh.renderingGroupId = group;
    this.mesh.isPickable = false;
    this.mesh.alwaysSelectAsActiveMesh = true; // bounds aren't kept in step with the data
    this.mesh.isVisible = false;
    if (onDraw) this.mesh.onAfterRenderObservable.add(onDraw);
  }

  set visible(v: boolean) {
    this.shown = v;
    this.mesh.isVisible = v && this.count > 0;
  }

  get visible(): boolean {
    return this.mesh.isVisible;
  }

  begin(): void {
    this.count = 0;
  }

  /** Room for `vertices` in all, keeping what's written so far. */
  private reserve(vertices: number): void {
    if (vertices <= this.capacity) return;
    const capacity = Math.max(64, 2 ** Math.ceil(Math.log2(vertices)));
    const positions = new Float32Array(capacity * 3), colors = new Float32Array(capacity * 4);
    positions.set(this.positions.subarray(0, this.count * 3));
    colors.set(this.colors.subarray(0, this.count * 4));
    this.positions = positions;
    this.colors = colors;
    this.capacity = capacity;
    this.regrown = true;
  }

  line(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, g: number, b: number, a: number): void {
    this.reserve(this.count + 2);
    const p = this.positions, c = this.colors;
    let i = this.count * 3;
    // Overlays are mostly the same frame to frame: note whether this one differs, so `end` can skip the upload.
    const f = Math.fround; // the buffers hold 32-bit floats
    if (!this.dirty && (p[i] !== f(ax) || p[i + 1] !== f(ay) || p[i + 2] !== f(az) || p[i + 3] !== f(bx) || p[i + 4] !== f(by) || p[i + 5] !== f(bz))) this.dirty = true;
    p[i] = ax; p[i + 1] = ay; p[i + 2] = az; p[i + 3] = bx; p[i + 4] = by; p[i + 5] = bz;
    i = this.count * 4;
    if (!this.dirty && (c[i] !== f(r) || c[i + 1] !== f(g) || c[i + 2] !== f(b) || c[i + 3] !== f(a))) this.dirty = true;
    c[i] = r; c[i + 1] = g; c[i + 2] = b; c[i + 3] = a;
    c[i + 4] = r; c[i + 5] = g; c[i + 6] = b; c[i + 7] = a;
    this.count += 2;
  }

  end(): void {
    const mesh = this.mesh;
    if (this.count > 0) {
      if (this.regrown || !mesh.geometry) {
        const indices = new Uint32Array(this.capacity);
        for (let i = 0; i < this.capacity; i++) indices[i] = i;
        mesh.setVerticesData(VertexBuffer.PositionKind, this.positions, true, 3);
        mesh.setVerticesData(VertexBuffer.ColorKind, this.colors, true, 4);
        mesh.setIndices(indices, this.capacity);
        this.regrown = false;
      } else if (this.dirty || this.count !== this.uploaded) {
        // Only the part in use; the rest of the buffer isn't drawn.
        mesh.updateVerticesData(VertexBuffer.PositionKind, this.positions.subarray(0, this.count * 3));
        mesh.updateVerticesData(VertexBuffer.ColorKind, this.colors.subarray(0, this.count * 4));
      }
      const sub = mesh.subMeshes[0];
      if (sub) partOfMesh(sub, this.count);
      this.uploaded = this.count;
      this.dirty = false;
    }
    mesh.isVisible = this.shown && this.count > 0;
  }

  /** A fixed set of vertices, as handed over (positions xyz, colours rgba), not copied. */
  setStatic(positions: Float32Array, colors: Float32Array, count: number): void {
    this.positions = positions;
    this.colors = colors;
    this.capacity = count;
    this.count = count;
    const mesh = this.mesh;
    if (count > 0) {
      const indices = new Uint32Array(count);
      for (let i = 0; i < count; i++) indices[i] = i;
      mesh.setVerticesData(VertexBuffer.PositionKind, positions, false, 3);
      mesh.setVerticesData(VertexBuffer.ColorKind, colors, false, 4);
      mesh.setIndices(indices, count);
    }
    this.regrown = true; // it isn't the batch's own arrays: the next `end()` starts afresh
    this.uploaded = count;
    this.dirty = false;
    mesh.isVisible = this.shown && count > 0;
  }

  dispose(): void {
    this.mesh.dispose(false, true);
  }
}

/**
 * Draw only a mesh's first `indexCount` indices. The submesh stops being "global" (all indices), and
 * Babylon then reads the submesh's own bounds (culling, the transparent sort), which a global one never
 * got: hand it the mesh's.
 */
function partOfMesh(sub: SubMesh, indexCount: number): void {
  sub.indexCount = indexCount;
  if (!sub.getBoundingInfo()) sub.setBoundingInfo(sub.getMesh().getBoundingInfo());
}

// --- Quad batches (handles) ------------------------------------------------------------------

/** One mesh of camera-facing coloured squares, rebuilt each frame in place (a handle is 4 vertices). */
class QuadBatch {
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

// --- Icons ---------------------------------------------------------------------------------------

type Sdf = (x: number, y: number) => number;

const circle = (cx: number, cy: number, r: number): Sdf => (x, y) => Math.hypot(x - cx, y - cy) - r;
const roundBox = (x0: number, y0: number, x1: number, y1: number, r: number): Sdf => {
  const hx = (x1 - x0) / 2 - r, hy = (y1 - y0) / 2 - r, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return (x, y) => {
    const dx = Math.abs(x - cx) - hx, dy = Math.abs(y - cy) - hy;
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
  };
};
/** Signed distance to a convex polygon (clockwise or counter-clockwise), exact outside its vertices. */
const polygon = (pts: [number, number][]): Sdf => (x, y) => {
  let inside = true, best = Infinity;
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
    const ex = bx - ax, ey = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
    best = Math.min(best, Math.hypot(x - ax - ex * t, y - ay - ey * t));
    const cross = ex * (y - ay) - ey * (x - ax);
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign && cross !== 0) inside = false;
  }
  return inside ? -best : best;
};
const segment = (ax: number, ay: number, bx: number, by: number, r: number): Sdf => (x, y) => {
  const ex = bx - ax, ey = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
  return Math.hypot(x - ax - ex * t, y - ay - ey * t) - r;
};

const ICON_SIZE = 64;
const OUTLINE_RGB: [number, number, number] = [0x1b, 0x1d, 0x21];

/** An icon drawn in software (no 2D canvas, so it works headless): shapes with a dark outline, light fill. Row 0 is the top. */
function paintIcon(layers: { shape: Sdf; fill: [number, number, number]; stroke?: number; alpha?: number }[]): Uint8Array {
  const data = new Uint8Array(ICON_SIZE * ICON_SIZE * 4);
  for (let py = 0; py < ICON_SIZE; py++) {
    for (let px = 0; px < ICON_SIZE; px++) {
      const x = px + 0.5, y = py + 0.5;
      let r = 0, g = 0, b = 0, a = 0;
      const over = (cr: number, cg: number, cb: number, ca: number): void => {
        const outA = ca + a * (1 - ca);
        if (outA <= 0) return;
        r = (cr * ca + r * a * (1 - ca)) / outA;
        g = (cg * ca + g * a * (1 - ca)) / outA;
        b = (cb * ca + b * a * (1 - ca)) / outA;
        a = outA;
      };
      for (const layer of layers) {
        const d = layer.shape(x, y), k = layer.alpha ?? 1;
        const stroke = (layer.stroke ?? 6) / 2;
        const sc = Math.min(1, Math.max(0, stroke + 0.5 - d)) * k;
        if (sc > 0) over(OUTLINE_RGB[0], OUTLINE_RGB[1], OUTLINE_RGB[2], sc);
        const fc = Math.min(1, Math.max(0, 0.5 - d)) * k;
        if (fc > 0) over(layer.fill[0], layer.fill[1], layer.fill[2], fc);
      }
      const o = (py * ICON_SIZE + px) * 4;
      data[o] = Math.round(r); data[o + 1] = Math.round(g); data[o + 2] = Math.round(b); data[o + 3] = Math.round(a * 255);
    }
  }
  return data;
}

const LIGHT_FILL: [number, number, number] = [0xff, 0xe0, 0x8a];
const CAMERA_FILL: [number, number, number] = [0xe8, 0xea, 0xed];

/** A camera glyph: a body and lens, like three.js's icon. */
function cameraIconPixels(): Uint8Array {
  return paintIcon([
    { shape: roundBox(6, 18, 42, 46, 5), fill: CAMERA_FILL },
    { shape: polygon([[42, 27], [58, 18], [58, 46], [42, 37]]), fill: CAMERA_FILL },
  ]);
}

/** A light's icon: a sun (directional), a bulb (point), a lamp shade (spot) or a soft disc (ambient). */
function lightIconPixels(type: string): Uint8Array {
  const layers: Parameters<typeof paintIcon>[0] = [];
  if (type === "directional") {
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4, c = Math.cos(a), s = Math.sin(a);
      layers.push({ shape: segment(32 + c * 21, 32 + s * 21, 32 + c * 27, 32 + s * 27, 2), fill: LIGHT_FILL, stroke: 5 });
    }
    layers.push({ shape: circle(32, 32, 13), fill: LIGHT_FILL });
  } else if (type === "spot") {
    layers.push({ shape: polygon([[24, 10], [40, 10], [54, 46], [10, 46]]), fill: LIGHT_FILL });
    layers.push({ shape: circle(32, 52, 6), fill: LIGHT_FILL, stroke: 4 });
  } else if (type === "ambient") {
    layers.push({ shape: circle(32, 32, 22), fill: LIGHT_FILL, alpha: 0.9 });
    layers.push({ shape: segment(24, 41, 32, 22, 1.5), fill: OUTLINE_RGB, stroke: 0, alpha: 0.9 }); // an "A"
    layers.push({ shape: segment(40, 41, 32, 22, 1.5), fill: OUTLINE_RGB, stroke: 0, alpha: 0.9 });
    layers.push({ shape: segment(27, 35, 37, 35, 1.5), fill: OUTLINE_RGB, stroke: 0, alpha: 0.9 });
  } else {
    layers.push({ shape: circle(32, 26, 17), fill: LIGHT_FILL });
    layers.push({ shape: roundBox(24, 42, 40, 54, 3), fill: LIGHT_FILL, stroke: 4 });
  }
  return paintIcon(layers);
}

// --- Light wireframes ------------------------------------------------------------------------

/**
 * A light's wireframe in world space, given to `emit` segment by segment: a directional light's arrow,
 * a spot light's cone, a point light's range (when selected). `m` is the node's world matrix, 16
 * numbers column by column starting at `offset`.
 */
export function emitLightSegments(
  l: Pick<Light, "type" | "range" | "spotAngle">,
  m: ArrayLike<number>,
  offset: number,
  selected: boolean,
  emit: (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => void,
): void {
  const o = offset;
  const px = m[o + 12], py = m[o + 13], pz = m[o + 14];
  const unit = (i: number, sign: number): [number, number, number] => {
    const x = m[o + i], y = m[o + i + 1], z = m[o + i + 2];
    const n = Math.hypot(x, y, z) || 1;
    return [(x / n) * sign, (y / n) * sign, (z / n) * sign];
  };
  const [xx, xy, xz] = unit(0, 1), [yx, yy, yz] = unit(4, 1), [fx, fy, fz] = unit(8, -1);
  const ring = (cx: number, cy: number, cz: number, ux: number, uy: number, uz: number, vx: number, vy: number, vz: number, r: number, n = 32): void => {
    let qx = cx + ux * r, qy = cy + uy * r, qz = cz + uz * r;
    for (let i = 1; i <= n; i++) {
      const a = (i / n) * Math.PI * 2, c = Math.cos(a) * r, s = Math.sin(a) * r;
      const nx = cx + ux * c + vx * s, ny = cy + uy * c + vy * s, nz = cz + uz * c + vz * s;
      emit(qx, qy, qz, nx, ny, nz);
      qx = nx; qy = ny; qz = nz;
    }
  };
  const spokes: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  if (l.type === "directional") {
    // Four parallel rays around the node and an arrowhead on the middle one.
    const tx = px + fx * 2, ty = py + fy * 2, tz = pz + fz * 2;
    emit(px, py, pz, tx, ty, tz);
    for (const [dx, dy] of spokes) {
      const ox = px + xx * dx * 0.3 + yx * dy * 0.3, oy = py + xy * dx * 0.3 + yy * dy * 0.3, oz = pz + xz * dx * 0.3 + yz * dy * 0.3;
      emit(ox, oy, oz, ox + fx * 1.2, oy + fy * 1.2, oz + fz * 1.2);
      emit(tx, ty, tz, tx - fx * 0.3 + xx * dx * 0.12 + yx * dy * 0.12, ty - fy * 0.3 + xy * dx * 0.12 + yy * dy * 0.12, tz - fz * 0.3 + xz * dx * 0.12 + yz * dy * 0.12);
    }
  } else if (l.type === "spot") {
    const d = l.range > 0 ? l.range : 5;
    const r = d * Math.tan((Math.min(Math.max(l.spotAngle, 1), 179) / 2) * (Math.PI / 180));
    const bx = px + fx * d, by = py + fy * d, bz = pz + fz * d;
    for (const [dx, dy] of spokes) emit(px, py, pz, bx + xx * dx * r + yx * dy * r, by + xy * dx * r + yy * dy * r, bz + xz * dx * r + yz * dy * r);
    ring(bx, by, bz, xx, xy, xz, yx, yy, yz, r);
  } else if (l.type === "point" && selected && l.range > 0) {
    ring(px, py, pz, xx, xy, xz, yx, yy, yz, l.range);
    ring(px, py, pz, xx, xy, xz, fx, fy, fz, l.range);
    ring(px, py, pz, yx, yy, yz, fx, fy, fz, l.range);
  }
}

/** @see emitLightSegments: the wireframe as a list of segments (for tests and tools). `m` holds the world matrix column by column. */
export function lightSegments(l: Pick<Light, "type" | "range" | "spotAngle">, m: ArrayLike<number>, selected: boolean): Seg[] {
  const out: Seg[] = [];
  emitLightSegments(l, m, 0, selected, (ax, ay, az, bx, by, bz) => out.push([[ax, ay, az], [bx, by, bz]]));
  return out;
}

// --- Grid ------------------------------------------------------------------------------------

/** Grid lines per side for a cell size: about 40 m across, between 10 and 400 lines. */
export function gridDivisions(cell: number): number {
  return Math.min(400, Math.max(10, Math.round(40 / cell)));
}

// --- The helpers -------------------------------------------------------------------------------

interface Outline {
  batch: LineBatch;
  box: boolean;
}

interface CameraGizmo {
  icon: Mesh;
}

interface LightGizmo {
  icon: Mesh;
  type: string;
}

/** The view camera's frame, taken once per `sync`. */
interface View {
  camera: Camera;
  px: number; py: number; pz: number;
  rx: number; ry: number; rz: number;
  ux: number; uy: number; uz: number;
  fx: number; fy: number; fz: number;
  q: Quaternion;
  ortho: boolean;
  /** Height of the camera's viewport on the canvas, CSS pixels. */
  pixels: number;
}

const tmpA = new Matrix();
const tmpB = new Matrix();
const tmpS = new Vector3();
const tmpScale = new Vector3();

/** Draws the editor's helpers for one Babylon surface. */
export class BabylonEditorOverlays {
  private colors: EditorColors = { ...DEFAULT_EDITOR_COLORS };
  private readonly utility: Scene;
  private disposed = false;

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
  private overlayHandles: QuadBatch | null = null;
  private handleIds: string[] = [];
  private handlePositions = new Float32Array(0);
  private readonly overlaySegments: { positions: Float32Array; color: number; batch: LineBatch }[] = [];
  private readonly draws = { count: 0, last: 0 };

  // Gizmos.
  private readonly cameraGizmos = new Map<Camera, CameraGizmo>();
  private cameraWires: LineBatch | null = null;
  private cameraMaterial: StandardMaterial | null = null;
  private cameraTexture: RawTexture | null = null;
  private readonly lightGizmos = new Map<Light, LightGizmo>();
  private lightWires: LineBatch | null = null;
  private readonly lightMaterials = new Map<string, { material: StandardMaterial; texture: RawTexture }>();
  private handleMaterial: StandardMaterial | null = null;

  private view: View | null = null;

  constructor(private readonly ctx: BabylonEditorContext) {
    this.utility = ctx.overlay.utilityLayerScene;
    // A utility layer scene starts with image processing on; the colours here are sRGB values drawn to the canvas as they are.
    this.utility.imageProcessingConfiguration.isEnabled = false;
    if (ctx.editor) this.buildGrid();
  }

  // --- Grid and axes (main scene) ---------------------------------------------------------------

  /** Editor: recolour the overlays (the editor's theme). The grid bakes its colours into its vertices, so it is rebuilt. */
  setEditorColors(colors: EditorColors): void {
    this.colors = { ...colors };
    if (this.grid) this.buildGrid();
    this.recolorOutlines();
  }

  /** Editor: lay the grid on the ground (XZ, 3D view) or facing the camera (XY, 2D view). */
  setEditorGridPlane(plane: "xz" | "xy"): void {
    this.gridPlane = plane;
    if (this.grid) this.grid.mesh.rotation.x = plane === "xy" ? Math.PI / 2 : 0;
  }

  /** Editor: the grid's cell size in metres, and whether it shows. */
  setEditorGrid(cellSize: number, visible: boolean): void {
    if (!this.grid) return;
    const cell = cellSize > 0 && Number.isFinite(cellSize) ? cellSize : 1;
    this.gridVisible = visible;
    if (cell !== this.gridCell) {
      this.gridCell = cell;
      this.buildGrid();
    }
    this.grid.visible = visible;
  }

  /** Editor: the grid's cell size, line count and visibility; null where there is no grid (a game's surface). */
  editorGrid(): { cellSize: number; visible: boolean; divisions: number } | null {
    return this.grid ? { cellSize: this.gridCell, visible: this.gridVisible, divisions: gridDivisions(this.gridCell) } : null;
  }

  /** (Re)build the grid and, the first time, the axes: `cell` metres between lines, in linear light (the main scene's space). */
  private buildGrid(): void {
    const scene = this.ctx.scene;
    this.grid?.dispose();
    const grid = (this.grid = new LineBatch(scene, "myco.editor.grid", 0, false));
    const n = gridDivisions(this.gridCell), cell = this.gridCell, half = (n * cell) / 2, center = n / 2;
    const lin = (c: number): [number, number, number] => [srgbToLinear(r8(c)), srgbToLinear(g8(c)), srgbToLinear(b8(c))];
    const major = lin(this.colors.gridCenter), minor = lin(this.colors.grid);
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

  /** Editor: outline the sprites and meshes of these nodes and their descendants, every frame. */
  setSelectionOutline(nodes: readonly GameObject[]): void {
    this.outlined.clear();
    for (const n of nodes) this.outlined.add(n);
  }

  /** Editor: show or hide the selection outline without forgetting what's selected (play mode's Gizmos menu). */
  setSelectionOutlineShown(shown: boolean): void {
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
    const c = this.colors.outline, r = r8(c), g = g8(c), b = b8(c);
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

  /** Position one outline per selected sprite, and a box around each selected mesh. */
  private syncOutlines(): void {
    let used = 0, boxes = 0;
    if (this.outlined.size > 0 && this.outlineShown) {
      for (const s of this.ctx.sprites()) {
        if (!s.mesh.isEnabled() || !s.mesh.isVisible || !this.isOutlined(s.component.node)) continue;
        this.placeOutline(this.spriteOutlines[used] ?? this.makeOutline(false), s.mesh, true);
        used++;
      }
      for (const entry of this.ctx.meshes()) {
        if (!this.isOutlined(entry.component.node)) continue;
        for (const m of entry.meshes) {
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
   * Each frame after the renderer's sync, before the overlay scene draws: place the outlines,
   * gizmos and overlay. Editor Worlds draw it all; a game or play World draws only the overlay
   * (navigation debug drawing, ADR 0065) and the live selection outline.
   */
  sync(world: World): void {
    if (this.disposed) return;
    this.draws.last = this.draws.count; // what the last whole frame drew (editorDrawingShown)
    this.draws.count = 0;
    this.view = this.readView();
    if (this.ctx.editor) {
      this.syncOutlines();
      this.syncCameraGizmos(world);
      this.syncLightGizmos(world);
      this.syncOverlay();
    } else {
      if (this.provider || this.overlayLines?.visible || this.overlaySegments.length > 0) this.syncOverlay(); // one more pass clears it when removed
      if (this.outlined.size > 0 || this.spriteOutlines.some((o) => o.batch.visible) || this.boxOutlines.some((o) => o.batch.visible)) this.syncOutlines();
    }
  }

  /** The view camera's position and axes (ignoring scale), and how tall its viewport is. */
  private readView(): View | null {
    const camera = this.ctx.viewCameras()[0];
    const t = camera?.node.transform;
    if (!camera || !t) return null;
    const q = t.worldRotation, p = t.worldPosition;
    const rot = (x: number, y: number, z: number): [number, number, number] => {
      const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
      return [x + q.w * tx + (q.y * tz - q.z * ty), y + q.w * ty + (q.z * tx - q.x * tz), z + q.w * tz + (q.x * ty - q.y * tx)];
    };
    const [rx, ry, rz] = rot(1, 0, 0), [ux, uy, uz] = rot(0, 1, 0), [fx, fy, fz] = rot(0, 0, -1);
    const canvasHeight = this.ctx.canvas.clientHeight > 0 ? this.ctx.canvas.clientHeight : this.ctx.settings.display.height;
    const pixels = Math.max(1, canvasHeight * Math.min(1, Math.max(0.001, camera.viewportSize.y)));
    return { camera, px: p.x, py: p.y, pz: p.z, rx, ry, rz, ux, uy, uz, fx, fy, fz, q: new Quaternion(q.x, q.y, q.z, q.w), ortho: camera.projection === "orthographic", pixels };
  }

  /** World size of an icon that keeps `size` (a fraction of the view's height) on screen, as three.js's constant-size sprites. */
  private iconScale(v: View, size: number, x: number, y: number, z: number): number {
    if (v.ortho) return size * 2 * v.camera.orthographicSize;
    const depth = (x - v.px) * v.fx + (y - v.py) * v.fy + (z - v.pz) * v.fz;
    return size * Math.max(depth, 1e-3);
  }

  // --- Overlay ----------------------------------------------------------------------------------

  /** Editor: draw what `provider` returns every frame (null stops). */
  setOverlayProvider(provider: (() => EditorOverlay) | null): void {
    this.provider = provider;
  }

  private overlayHandleMaterial(): StandardMaterial {
    return (this.handleMaterial ??= overlayMaterial(this.utility, "myco.editor.handles"));
  }

  private countDraw = (): void => void this.draws.count++;

  private syncOverlay(): void {
    const overlay = this.provider?.() ?? { lines: [], handles: [] };
    // Lines: one batch with per-vertex colours, refilled each frame.
    this.overlayLines ??= new LineBatch(this.utility, "myco.editor.overlayLines", OVERLAY_GROUP.lines, true, this.countDraw);
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
    this.syncHandles(overlay.handles);
  }

  /** Handles: squares of a fixed size on screen, facing the camera, drawn above everything else. */
  private syncHandles(handles: EditorOverlay["handles"]): void {
    this.overlayHandles ??= new QuadBatch(this.utility, "myco.editor.handles", OVERLAY_GROUP.handles, this.overlayHandleMaterial());
    const batch = this.overlayHandles, v = this.view;
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
        slot = { positions: group.positions, color: group.color, batch: new LineBatch(this.utility, `myco.editor.segments.${i}`, OVERLAY_GROUP.lines, true, this.countDraw) };
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

  /** Editor: where each overlay handle is on the canvas (CSS pixels); handles behind the camera are left out. */
  overlayHandlesOnCanvas(_world: World): { id: string; x: number; y: number }[] {
    const view = this.ctx.viewCameras()[0];
    if (!view || !this.overlayHandles?.mesh.isVisible) return [];
    const out: { id: string; x: number; y: number }[] = [];
    this.handleIds.forEach((id, i) => {
      const s = view.worldToScreenPoint(new EngineVector3(this.handlePositions[i * 3], this.handlePositions[i * 3 + 1], this.handlePositions[i * 3 + 2]));
      if (s.z >= view.near && s.z <= view.far) out.push({ id, x: s.x, y: s.y });
    });
    return out;
  }

  /** Editor: the id of the overlay handle under a canvas point (CSS pixels), nearest within `radius` pixels, or null. */
  pickOverlayHandle(world: World, x: number, y: number, radius = 9): string | null {
    let best: string | null = null, bestDistance = radius;
    for (const h of this.overlayHandlesOnCanvas(world)) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d <= bestDistance) {
        bestDistance = d;
        best = h.id;
      }
    }
    return best;
  }

  /** How much editor drawing shows now: overlay line segments (lines and bulk groups), handles, outlines, and overlay objects the last frame drew. */
  editorDrawingShown(): { segments: number; handles: number; outlines: number; drawnObjects: number } {
    let segments = this.overlayLines?.visible ? Math.floor(this.overlayLines.count / 2) : 0;
    for (const s of this.overlaySegments) if (s.batch.visible) segments += Math.floor(s.batch.count / 2);
    const outlines = this.spriteOutlines.filter((o) => o.batch.visible).length + this.boxOutlines.filter((o) => o.batch.visible).length;
    const handles = this.overlayHandles?.mesh.isVisible ? this.overlayHandles.count : 0;
    return { segments, handles, outlines, drawnObjects: this.draws.last };
  }

  // --- Icons ------------------------------------------------------------------------------------

  private makeIcon(name: string, material: StandardMaterial): Mesh {
    const icon = new Mesh(name, this.utility);
    icon.setVerticesData(VertexBuffer.PositionKind, [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], false, 3);
    icon.setVerticesData(VertexBuffer.UVKind, [0, 0, 1, 0, 1, 1, 0, 1], false, 2);
    icon.setIndices([0, 1, 2, 0, 2, 3], 4);
    icon.material = material;
    icon.renderingGroupId = OVERLAY_GROUP.icons;
    icon.isPickable = false;
    icon.alwaysSelectAsActiveMesh = true;
    icon.rotationQuaternion = new Quaternion();
    return icon;
  }

  private iconMaterial(name: string, pixels: Uint8Array): { material: StandardMaterial; texture: RawTexture } {
    const texture = new RawTexture(pixels, ICON_SIZE, ICON_SIZE, Constants.TEXTUREFORMAT_RGBA, this.utility, false, true, Constants.TEXTURE_BILINEAR_SAMPLINGMODE);
    texture.hasAlpha = true;
    texture.name = name;
    const material = overlayMaterial(this.utility, name);
    material.emissiveColor = Color3.White();
    material.emissiveTexture = texture;
    material.opacityTexture = texture;
    return { material, texture };
  }

  /** Face an icon to the view, a constant size on screen. */
  private placeIcon(icon: Mesh, v: View | null, x: number, y: number, z: number, size: number): void {
    icon.position.set(x, y, z);
    if (!v) return;
    const s = this.iconScale(v, size, x, y, z);
    icon.scaling.set(s, s, 1);
    icon.rotationQuaternion!.copyFrom(v.q);
  }

  // --- Camera gizmos ------------------------------------------------------------------------

  /**
   * Cameras inside the edited scene don't draw the editor's view, so the editor shows each as an icon
   * (clickable, constant size on screen) and a wireframe of what it sees at the game's aspect ratio;
   * selected cameras are drawn in the selection colour. All the wireframes share one batch.
   */
  private syncCameraGizmos(world: World): void {
    const seen = new Set<Camera>();
    const aspect = this.ctx.settings.display.width / this.ctx.settings.display.height;
    const wires = (this.cameraWires ??= new LineBatch(this.utility, "myco.editor.cameraWires", OVERLAY_GROUP.wires, true));
    wires.begin();
    for (const c of world._componentsOfType(Camera)) {
      if (!world.inEditMode(c.node.entity)) continue; // the editor's own camera has no gizmo
      seen.add(c);
      const gizmo = this.cameraGizmos.get(c) ?? this.createCameraGizmo(c);
      const visible = c.node.activeInHierarchy;
      gizmo.icon.isVisible = visible;
      if (!visible) continue;
      const e = c.node.entity, m = world.worldMatrix(e), o = e * 16;
      const local = frustumSegments({ projection: c.projection, orthographicSize: c.orthographicSize, fieldOfView: c.fieldOfView, aspect, near: c.near, far: c.far });
      const rgb = this.isOutlined(c.node) ? this.colors.outline : this.colors.cameraGizmo;
      const r = r8(rgb), g = g8(rgb), b = b8(rgb);
      for (let i = 0; i < local.length; i += 6) {
        wires.line(...transformPoint(m, o, local[i], local[i + 1], local[i + 2]), ...transformPoint(m, o, local[i + 3], local[i + 4], local[i + 5]), r, g, b, 0.85);
      }
      this.placeIcon(gizmo.icon, this.view, m[o + 12], m[o + 13], m[o + 14], CAMERA_ICON_SIZE);
    }
    wires.end();
    for (const [c, gizmo] of this.cameraGizmos) {
      if (seen.has(c) && c.node.isValid) continue;
      gizmo.icon.dispose(false, false);
      this.cameraGizmos.delete(c);
    }
  }

  private createCameraGizmo(c: Camera): CameraGizmo {
    if (!this.cameraMaterial) {
      const made = this.iconMaterial("myco.editor.cameraIcon", cameraIconPixels());
      this.cameraMaterial = made.material;
      this.cameraTexture = made.texture;
    }
    const gizmo = { icon: this.makeIcon("myco.editor.cameraGizmo", this.cameraMaterial) };
    this.cameraGizmos.set(c, gizmo);
    return gizmo;
  }

  /** How many cameras in the edited scene have a gizmo (for tests). */
  cameraGizmoCount(): number {
    return this.cameraGizmos.size;
  }

  // --- Light gizmos ------------------------------------------------------------------------------

  /**
   * Lights in the edited scene show as clickable icons (constant size on screen) and wireframes: a
   * directional light's direction, a spot light's cone, and (selected) a point light's range. Selected
   * lights are drawn in the selection colour.
   */
  private syncLightGizmos(world: World): void {
    const seen = new Set<Light>();
    const wires = (this.lightWires ??= new LineBatch(this.utility, "myco.editor.lightWires", OVERLAY_GROUP.wires, true, this.countDraw));
    wires.begin();
    for (const l of world._componentsOfType(Light)) {
      if (!world.inEditMode(l.node.entity)) continue;
      seen.add(l);
      let gizmo = this.lightGizmos.get(l);
      const material = this.lightMaterial(l.type);
      if (!gizmo) {
        gizmo = { icon: this.makeIcon("myco.editor.lightGizmo", material), type: l.type };
        this.lightGizmos.set(l, gizmo);
      } else if (gizmo.type !== l.type) {
        gizmo.icon.material = material;
        gizmo.type = l.type;
      }
      const visible = l.node.activeInHierarchy;
      gizmo.icon.isVisible = visible;
      if (!visible) continue;
      const e = l.node.entity, m = world.worldMatrix(e), o = e * 16;
      this.placeIcon(gizmo.icon, this.view, m[o + 12], m[o + 13], m[o + 14], LIGHT_ICON_SIZE);
      const selected = this.isOutlined(l.node);
      const rgb = selected ? this.colors.outline : this.colors.cameraGizmo;
      const r = r8(rgb), g = g8(rgb), b = b8(rgb);
      emitLightSegments(l, m, o, selected, (ax, ay, az, bx, by, bz) => wires.line(ax, ay, az, bx, by, bz, r, g, b, 0.85));
    }
    wires.end();
    for (const [l, gizmo] of this.lightGizmos) {
      if (seen.has(l) && l.node.isValid) continue;
      gizmo.icon.dispose(false, false);
      this.lightGizmos.delete(l);
    }
  }

  private lightMaterial(type: string): StandardMaterial {
    let made = this.lightMaterials.get(type);
    if (!made) {
      made = this.iconMaterial(`myco.editor.lightIcon.${type}`, lightIconPixels(type));
      this.lightMaterials.set(type, made);
    }
    return made.material;
  }

  /** Where each light icon in the edited scene is on the canvas (for tests and tools). */
  lightIconsOnCanvas(_world: World): { node: GameObject; x: number; y: number }[] {
    const view = this.ctx.viewCameras()[0];
    const out: { node: GameObject; x: number; y: number }[] = [];
    if (!view) return out;
    for (const [l, gizmo] of this.lightGizmos) {
      if (!gizmo.icon.isVisible) continue;
      const p = gizmo.icon.position;
      const s = view.worldToScreenPoint(new EngineVector3(p.x, p.y, p.z));
      if (s.z >= view.near && s.z <= view.far) out.push({ node: l.node, x: s.x, y: s.y });
    }
    return out;
  }

  /** How many light wireframe segments were drawn last frame (for tests). */
  lightWireCount(): number {
    return this.lightWires?.visible ? this.lightWires.count / 2 : 0;
  }

  // --- Picking icons ----------------------------------------------------------------------------

  /** Camera and light icons within a click's reach of a canvas point (CSS pixels), nearest first. */
  iconsAt(_world: World, x: number, y: number): GameObject[] {
    const view = this.ctx.viewCameras()[0];
    if (!view) return [];
    const hits: { node: GameObject; distance: number }[] = [];
    const test = (node: GameObject, icon: Mesh): void => {
      if (!icon.isVisible) return;
      const p = icon.position;
      const s = view.worldToScreenPoint(new EngineVector3(p.x, p.y, p.z));
      if (s.z < view.near || s.z > view.far) return;
      const distance = Math.hypot(s.x - x, s.y - y);
      if (distance <= ICON_PICK_RADIUS) hits.push({ node, distance });
    };
    for (const [c, g] of this.cameraGizmos) test(c.node, g.icon);
    for (const [l, g] of this.lightGizmos) test(l.node, g.icon);
    return hits.sort((a, b) => a.distance - b.distance).map((h) => h.node);
  }

  dispose(): void {
    this.disposed = true;
    for (const b of [this.grid, this.axes, this.overlayLines, this.cameraWires, this.lightWires]) b?.dispose();
    for (const o of [...this.spriteOutlines, ...this.boxOutlines]) o.batch.dispose();
    for (const s of this.overlaySegments) s.batch.dispose();
    this.overlayHandles?.dispose();
    for (const g of this.cameraGizmos.values()) g.icon.dispose(false, false);
    for (const g of this.lightGizmos.values()) g.icon.dispose(false, false);
    this.cameraGizmos.clear();
    this.lightGizmos.clear();
    this.spriteOutlines.length = this.boxOutlines.length = this.overlaySegments.length = 0;
    this.cameraMaterial?.dispose(false, true);
    for (const m of this.lightMaterials.values()) m.material.dispose(false, true);
    this.handleMaterial?.dispose(false, true);
    this.lightMaterials.clear();
    this.grid = this.axes = this.overlayLines = this.cameraWires = this.lightWires = null;
    this.overlayHandles = null;
    this.cameraMaterial = this.handleMaterial = null;
    this.cameraTexture = null;
  }
}

/** An unlit, two-sided material that draws its emissive colour and vertex colours as they are, over everything. */
function overlayMaterial(scene: Scene, name: string): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.disableLighting = true;
  m.diffuseColor = Color3.Black();
  m.specularColor = Color3.Black();
  m.emissiveColor = Color3.White();
  m.backFaceCulling = false;
  m.disableDepthWrite = true;
  m.depthFunction = Constants.ALWAYS;
  m.fogEnabled = false;
  return m;
}

/** A point of the column-major matrix at `o`, applied to (x, y, z). */
function transformPoint(m: ArrayLike<number>, o: number, x: number, y: number, z: number): [number, number, number] {
  return [m[o] * x + m[o + 4] * y + m[o + 8] * z + m[o + 12], m[o + 1] * x + m[o + 5] * y + m[o + 9] * z + m[o + 13], m[o + 2] * x + m[o + 6] * y + m[o + 10] * z + m[o + 14]];
}
