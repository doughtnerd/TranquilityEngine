/**
 * Visibility views (ADR 0446 §3): a view's inputs to selection and occlusion, built from a `Camera` component or from
 * a bare camera frame (the editor's scene view, a probe face), with no renderer types. Not public API.
 *
 * Conventions: left-handed, the view looks along its forward axis (a node's +Z, ADR 0164). The view-projection matrix is
 * column-major and maps the view volume to x, y in -1..1 (+y up) and depth z in 0..1 (near to far). Frustum planes are
 * built from the frame directly, normalised, inside where ax + by + cz + d ≥ 0, in the order near, far, left, right,
 * bottom, top.
 */
import type { Camera } from "../components";
import type { ViewKey, ViewKind, VisibilityView } from "./types";

/** A view described by its frame and projection, in world space. The axes are unit length and orthogonal. */
export interface ViewSpec {
  readonly key: ViewKey;
  readonly kind: ViewKind;
  readonly position: readonly [number, number, number];
  readonly right: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  readonly forward: readonly [number, number, number];
  readonly projection: "perspective" | "orthographic";
  /** Vertical field of view in radians (perspective). */
  readonly fovY: number;
  /** Half the view's height in world units (orthographic). */
  readonly orthoHalfHeight: number;
  readonly near: number;
  readonly far: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly persistent: boolean;
  readonly occlusion: boolean;
}

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Build a view from its frame and projection. */
export function makeView(spec: ViewSpec): VisibilityView {
  const { position: p, right: r, up: u, forward: f, near, far } = spec;
  const aspect = spec.widthPx > 0 && spec.heightPx > 0 ? spec.widthPx / spec.heightPx : 1;
  const perspective = spec.projection === "perspective";
  const planes = new Float32Array(24);
  const set = (i: number, x: number, y: number, z: number, d: number) => planes.set([x, y, z, d], i * 4);
  const fp = dot(f, p), rp = dot(r, p), up = dot(u, p);
  set(0, f[0], f[1], f[2], -fp - near);
  set(1, -f[0], -f[1], -f[2], fp + far);
  let sx: number, sy: number; // projection scale of x and y
  if (perspective) {
    const ty = Math.tan(spec.fovY / 2), tx = ty * aspect;
    const hx = Math.hypot(1, tx), hy = Math.hypot(1, ty);
    // Inside the left side: x ≥ -tx·z, i.e. (right + tx·forward)·(q - p) ≥ 0; and so on.
    const side = (i: number, a: readonly number[], sign: number, t: number, len: number) => {
      const nx = (sign * a[0] + t * f[0]) / len, ny = (sign * a[1] + t * f[1]) / len, nz = (sign * a[2] + t * f[2]) / len;
      set(i, nx, ny, nz, -(nx * p[0] + ny * p[1] + nz * p[2]));
    };
    side(2, r, 1, tx, hx);
    side(3, r, -1, tx, hx);
    side(4, u, 1, ty, hy);
    side(5, u, -1, ty, hy);
    sy = 1 / ty;
    sx = sy / aspect;
  } else {
    const hh = spec.orthoHalfHeight, hw = hh * aspect;
    set(2, r[0], r[1], r[2], -rp + hw);
    set(3, -r[0], -r[1], -r[2], rp + hw);
    set(4, u[0], u[1], u[2], -up + hh);
    set(5, -u[0], -u[1], -u[2], up + hh);
    sx = 1 / Math.max(hw, 1e-9);
    sy = 1 / Math.max(hh, 1e-9);
  }
  // View matrix rows: right, up, forward, with translation -axis·p. Projection rows (perspective): sx·x, sy·y,
  // a·z + b, z; (orthographic): sx·x, sy·y, a·z + b, 1.
  const range = Math.max(far - near, 1e-9);
  const a = perspective ? far / range : 1 / range;
  const b = perspective ? (-near * far) / range : -near / range;
  const vp = new Float32Array(16);
  const rows = [
    [sx * r[0], sx * r[1], sx * r[2], -sx * rp],
    [sy * u[0], sy * u[1], sy * u[2], -sy * up],
    [a * f[0], a * f[1], a * f[2], -a * fp + b],
    perspective ? [f[0], f[1], f[2], -fp] : [0, 0, 0, 1],
  ];
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) vp[col * 4 + row] = rows[row][col];
  return {
    key: spec.key,
    kind: spec.kind,
    position: [p[0], p[1], p[2]],
    viewProjection: vp,
    planes,
    projection: spec.projection,
    fovY: spec.fovY,
    orthoHalfHeight: spec.orthoHalfHeight,
    heightPx: spec.heightPx,
    persistent: spec.persistent,
    occlusion: spec.occlusion,
  };
}

/** The key a camera's view has: its node's id and its output kind. */
export function cameraViewKey(camera: Camera, kind: ViewKind = camera.targetTexture ? "texture" : "camera"): ViewKey {
  return `${camera.gameObject.id}/${kind}`;
}

/** Overrides for `cameraView`. */
export interface CameraViewOptions {
  readonly kind?: ViewKind;
  readonly key?: ViewKey;
  readonly persistent?: boolean;
  readonly occlusion?: boolean;
}

/**
 * The view of a `Camera` drawing `widthPx` × `heightPx` device pixels: its node's world position and axes (scale
 * ignored), its projection, and a pixel-perfect camera's effective size. Kind `"texture"` when it draws into a render
 * texture, else `"camera"`; persistent; occlusion when `occlusionCulling` is on for a perspective camera drawing to the
 * canvas (render-texture cameras default off, ADR 0447 §4).
 */
export function cameraView(camera: Camera, widthPx: number, heightPx: number, options: CameraViewOptions = {}): VisibilityView {
  const kind = options.kind ?? (camera.targetTexture ? "texture" : "camera");
  const node = camera.gameObject;
  let position: [number, number, number] = [0, 0, 0];
  let right: [number, number, number] = [1, 0, 0], up: [number, number, number] = [0, 1, 0], forward: [number, number, number] = [0, 0, 1];
  if (node.transform) {
    const m = node.world.worldMatrix(node.entity), o = node.entity * 16;
    const axis = (c: number): [number, number, number] => {
      const x = m[o + c], y = m[o + c + 1], z = m[o + c + 2], l = Math.hypot(x, y, z) || 1;
      return [x / l, y / l, z / l];
    };
    position = [m[o + 12], m[o + 13], m[o + 14]];
    right = axis(0);
    up = axis(4);
    forward = axis(8);
  }
  const perspective = camera.projection === "perspective";
  return makeView({
    key: options.key ?? cameraViewKey(camera, kind),
    kind,
    position,
    right,
    up,
    forward,
    projection: camera.projection,
    fovY: (camera.fieldOfView * Math.PI) / 180,
    orthoHalfHeight: perspective ? 0 : camera._effectiveOrthographicSize(heightPx),
    near: camera.near,
    far: camera.far,
    widthPx,
    heightPx,
    persistent: options.persistent ?? true,
    occlusion: options.occlusion ?? (camera.occlusionCulling && perspective && kind === "camera"),
  });
}
