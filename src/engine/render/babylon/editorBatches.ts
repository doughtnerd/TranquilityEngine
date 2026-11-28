/**
 * The drawing pieces the Babylon editor viewport's overlay modules share (ADR 0022, 0075 stage 8, 0128):
 * line batches, the unlit overlay material, 0xRRGGBB colour helpers, the overlay scene's rendering
 * groups and the view camera's frame. `editorGuides.ts` (grid, outlines, the editor's overlay) and
 * `editorIcons.ts` (camera, light and particle system icons) draw with them.
 *
 * Two scenes (`editorContext.ts`):
 * - The grid and axes live in the main scene, which the frame graph renders in linear light and the
 *   finish pass encodes to sRGB. Their colours are therefore converted from sRGB to linear
 *   (`srgbToLinear`), and meshes hide them (depth test). They exist in editor Worlds only.
 * - Everything else lives in the overlay scene (a utility layer) that draws after the frame graph,
 *   straight onto the canvas, never post-processed. A utility layer scene has no image processing
 *   (`imageProcessingConfiguration.isEnabled` is false, checked by the tests), so colours are passed as
 *   the sRGB values they are and come out unchanged. Lines use Babylon's own `color` shader, which writes
 *   its vertex colour as is; quads (handles, icons) use an emissive `StandardMaterial`, which does the same.
 *
 * Draw order comes from rendering groups (Babylon clears depth between them), so each of these sits
 * above the last: `OVERLAY_GROUP`. The transform gizmo belongs between the icons and the handles.
 *
 * Per-frame paths reuse their meshes and typed arrays, updating vertex data in place.
 */
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Quaternion } from "@babylonjs/core/Maths/math.vector.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { LinesMesh } from "@babylonjs/core/Meshes/linesMesh.js";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { Camera } from "../components";
import type { BabylonEditorContext } from "./editorContext";

/** Rendering groups of the overlay scene, back to front (Babylon has four). */
export const OVERLAY_GROUP = { lines: 0, wires: 1, outlines: 2, icons: 2, handles: 3 } as const;

// --- Colours ---------------------------------------------------------------------------------

export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function r8(c: number): number { return ((c >> 16) & 255) / 255; }
export function g8(c: number): number { return ((c >> 8) & 255) / 255; }
export function b8(c: number): number { return (c & 255) / 255; }

// --- Line batches ------------------------------------------------------------------------------

/**
 * One `LinesMesh` drawing many segments with per-vertex colours (rgba). Fill it each frame with
 * `begin`, `line`, `end`: its typed arrays only grow (to a power of two), and a frame that fits just
 * updates the vertex buffers and shortens the draw.
 */
export class LineBatch {
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

  constructor(scene: Scene, name: string, group: number, alpha: boolean) {
    this.mesh = new LinesMesh(name, scene, null, null, undefined, true, alpha);
    this.mesh.renderingGroupId = group;
    this.mesh.isPickable = false;
    this.mesh.alwaysSelectAsActiveMesh = true; // bounds aren't kept in step with the data
    this.mesh.isVisible = false;
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
export function partOfMesh(sub: SubMesh, indexCount: number): void {
  sub.indexCount = indexCount;
  if (!sub.getBoundingInfo()) sub.setBoundingInfo(sub.getMesh().getBoundingInfo());
}

// --- The view ----------------------------------------------------------------------------------

/** The view camera's frame, taken once per frame. */
export interface View {
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

/** The view camera's position and axes (ignoring scale), and how tall its viewport is; null without a view camera. */
export function readView(ctx: BabylonEditorContext): View | null {
  const camera = ctx.viewCameras()[0];
  const t = camera?.node.transform;
  if (!camera || !t) return null;
  const q = t.worldRotation, p = t.worldPosition;
  const rot = (x: number, y: number, z: number): [number, number, number] => {
    const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
    return [x + q.w * tx + (q.y * tz - q.z * ty), y + q.w * ty + (q.z * tx - q.x * tz), z + q.w * tz + (q.x * ty - q.y * tx)];
  };
  const [rx, ry, rz] = rot(1, 0, 0), [ux, uy, uz] = rot(0, 1, 0), [fx, fy, fz] = rot(0, 0, 1);
  const size = ctx.canvasSize().height;
  const canvasHeight = size > 0 ? size : ctx.settings.display.height;
  const pixels = Math.max(1, canvasHeight * Math.min(1, Math.max(0.001, camera.viewportSize.y)));
  return { camera, px: p.x, py: p.y, pz: p.z, rx, ry, rz, ux, uy, uz, fx, fy, fz, q: new Quaternion(q.x, q.y, q.z, q.w), ortho: camera.projection === "orthographic", pixels };
}

// --- Materials ---------------------------------------------------------------------------------

/** An unlit, two-sided material that draws its emissive colour and vertex colours as they are, over everything. */
export function overlayMaterial(scene: Scene, name: string): StandardMaterial {
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
