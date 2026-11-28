// What an Animator's input row says about how it is seen (ADR 0370, "LOD and culling"; T17): visible this frame, and the
// update-rate LOD step from `lodMetric`.
//
// The render side doesn't report per-node visibility to the simulation, so visibility is decided here, on the CPU, as
// a bounding sphere against the frustum of each enabled `Camera` in the World: the sphere is centred on the Skeleton's
// node, with the rest pose's reach (the farthest joint from the model origin, times the node's largest world scale,
// plus a quarter for the animation's extra reach) as its radius. A World without an enabled Camera (servers, headless
// tests, a game drawing through something else) counts every Animator as visible. LOD measures against `Camera.main`
// (the enabled camera with the lowest depth): distance from its position, or the share of its view's height the sphere
// covers. Without a camera, LOD is off.
//
// Each camera's frame and frustum numbers are read once per gather sub-step (`cameraViews`), and each skeleton's world
// matrix straight from the World's storage, so the per-Animator test allocates nothing (it used to make a
// `LocalToWorld` per Animator and per camera, and four vectors per camera test).
import type { World } from "../../../../../engine/core/World";
import { Camera, LODGroup } from "../../../../../engine/render/components";
import { visibilityService } from "../../../../../engine/render/visibility/service";
import type { AnimatorRuntime } from "../instances";

/** Extra reach over the rest pose for an animated pose (an arm swinging out). */
const POSE_REACH = 1.25;
/** A sphere for a skeleton whose file couldn't be read. */
const DEFAULT_RADIUS = 1;

interface Sphere {
  x: number;
  y: number;
  z: number;
  r: number;
}

/** @internal One enabled camera's numbers for the sphere test, read once per gather sub-step. */
export interface CameraView {
  readonly camera: Camera;
  /** False when the camera's node has no transform (it then sees everything, as before). */
  readonly placed: boolean;
  /** World position, and the unit right, up and forward axes. */
  readonly px: number;
  readonly py: number;
  readonly pz: number;
  readonly rx: number;
  readonly ry: number;
  readonly rz: number;
  readonly ux: number;
  readonly uy: number;
  readonly uz: number;
  readonly fx: number;
  readonly fy: number;
  readonly fz: number;
  readonly near: number;
  readonly far: number;
  readonly aspect: number;
  readonly orthographic: boolean;
  readonly orthographicSize: number;
  /** `tan(fov / 2)` vertically and horizontally, and `hypot(1, t)` of each. */
  readonly ty: number;
  readonly tx: number;
  readonly hy: number;
  readonly hx: number;
}

/** @internal The enabled cameras of a World for one gather sub-step, and its main one (`Camera.main`: lowest depth). */
export interface CameraViews {
  readonly all: readonly CameraView[];
  readonly main: CameraView | null;
  /**
   * The level the visibility stage gives the `LODGroup` enclosing `rt`'s Animator for the main camera: -1 when it is
   * culled by LOD, 0 with no group, no camera or no stage (ADR 0459 §6). The first call of a sub-step brings the
   * stage up to date, so it is this frame's selection, not last frame's (the stage's own run is after propagation,
   * which is after the animation gather).
   */
  groupLevel(rt: AnimatorRuntime): number;
}

const sphere: Sphere = { x: 0, y: 0, z: 0, r: 0 };

function boundsOf(rt: AnimatorRuntime): Sphere | null {
  const s = rt.skeleton;
  const node = s?.component.node;
  if (!s || !node?.transform) return null;
  const e = node.entity;
  const m = node.world.worldMatrix(e), o = e * 16;
  const scale = Math.max(Math.hypot(m[o]!, m[o + 1]!, m[o + 2]!), Math.hypot(m[o + 4]!, m[o + 5]!, m[o + 6]!), Math.hypot(m[o + 8]!, m[o + 9]!, m[o + 10]!));
  sphere.x = m[o + 12]!;
  sphere.y = m[o + 13]!;
  sphere.z = m[o + 14]!;
  sphere.r = (s.info ? Math.max(s.info.radius, 0.1) : DEFAULT_RADIUS) * POSE_REACH * scale;
  return sphere;
}

function viewOf(camera: Camera): CameraView {
  const l = camera.node.transform?.localToWorld;
  const aspect = camera.aspect > 0 ? camera.aspect : 1;
  const ty = Math.tan((camera.fieldOfView * Math.PI) / 360);
  const tx = ty * aspect;
  const base = {
    camera,
    near: camera.near,
    far: camera.far,
    aspect,
    orthographic: camera.projection === "orthographic",
    orthographicSize: camera.orthographicSize,
    ty,
    tx,
    hy: Math.hypot(1, ty),
    hx: Math.hypot(1, tx),
  };
  if (!l) return { ...base, placed: false, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, ux: 0, uy: 0, uz: 0, fx: 0, fy: 0, fz: 0 };
  const p = l.position, right = l.right, up = l.up, fwd = l.forward;
  return { ...base, placed: true, px: p.x, py: p.y, pz: p.z, rx: right.x, ry: right.y, rz: right.z, ux: up.x, uy: up.y, uz: up.z, fx: fwd.x, fy: fwd.y, fz: fwd.z };
}

/** Whether `b` is inside (or touches) the view of `v`. */
function inView(v: CameraView, b: Sphere): boolean {
  if (!v.placed) return true;
  const dx = b.x - v.px, dy = b.y - v.py, dz = b.z - v.pz;
  const x = dx * v.rx + dy * v.ry + dz * v.rz;
  const y = dx * v.ux + dy * v.uy + dz * v.uz;
  const z = dx * v.fx + dy * v.fy + dz * v.fz;
  if (z + b.r < v.near || z - b.r > v.far) return false;
  if (v.orthographic) {
    const h = v.orthographicSize;
    return Math.abs(y) <= h + b.r && Math.abs(x) <= h * v.aspect + b.r;
  }
  // Distance from the sphere's centre to each side plane, measured along the plane's normal.
  return Math.abs(y) - v.ty * z <= b.r * v.hy && Math.abs(x) - v.tx * z <= b.r * v.hx;
}

const NONE: CameraViews = { all: [], main: null, groupLevel: () => 0 };

/** The group-level lookup of one gather sub-step over `world` (lazy: a World with no `"lodGroup"` Animator pays nothing). */
function groupLevels(world: World): (rt: AnimatorRuntime) => number {
  let ready = false;
  let service: ReturnType<typeof visibilityService> = null;
  // Owner entity → its LODGroup, or null for a disabled one (which stops the search, as the stage's member search does).
  const owners = new Map<number, LODGroup | null>();
  return (rt) => {
    if (!ready) {
      ready = true;
      service = visibilityService(world);
      if (service) {
        service.update();
        for (const g of world._componentsOfType(LODGroup)) {
          if (g._destroyed) continue;
          const e = g.owner.entity;
          if (g.isActiveAndEnabled && !owners.get(e)) owners.set(e, g);
          else if (!owners.has(e)) owners.set(e, null);
        }
      }
    }
    if (!service) return 0;
    for (let e = rt.animator.gameObject.entity; e !== -1; e = world.parentOf[e]!) {
      if (!owners.has(e)) continue;
      const g = owners.get(e);
      return g ? service.levelOf(g) : 0;
    }
    return 0;
  };
}

/** @internal The enabled Cameras of `world` with their numbers (read once per gather sub-step). */
export function cameraViews(world: World): CameraViews {
  const cams = world._componentsOfType(Camera).filter((c) => c.isActiveAndEnabled);
  if (!cams.length) return NONE;
  const all = cams.map(viewOf);
  const main = all.reduce((best, c) => (c.camera.depth < best.camera.depth ? c : best));
  return { all, main, groupLevel: groupLevels(world) };
}

/**
 * @internal Whether any camera of `views` sees `rt`'s skeleton (true without cameras or bounds). With
 * `lodMetric: "lodGroup"`, an enclosing group culled by LOD counts as not seen (ADR 0459 §6).
 */
export function isVisible(views: CameraViews, rt: AnimatorRuntime): boolean {
  if (!views.all.length) return true;
  if (rt.animator.lodMetric === "lodGroup" && views.groupLevel(rt) === -1) return false;
  const b = boundsOf(rt);
  if (!b) return true;
  for (const v of views.all) if (inView(v, b)) return true;
  return false;
}

/** @internal The update-rate LOD step (1, 2 or 4) for `rt` this frame, measured against the main camera of `views`. */
export function lodStep(views: CameraViews, rt: AnimatorRuntime): number {
  const a = rt.animator;
  if (a.lodMetric === "off") return 1;
  if (a.lodMetric === "lodGroup") {
    // Level 0 every frame, level 1 every 2nd, level 2 and below (and culled) every 4th.
    const level = views.groupLevel(rt);
    return level === 0 ? 1 : level === 1 ? 2 : 4;
  }
  const main = views.main;
  if (!main) return 1;
  const b = boundsOf(rt);
  if (!b || !main.placed) return 1;
  const d = Math.hypot(b.x - main.px, b.y - main.py, b.z - main.pz);
  if (a.lodMetric === "distance") return d > a.lodEvery4 ? 4 : d > a.lodEvery2 ? 2 : 1;
  const half = main.orthographic ? main.orthographicSize : Math.max(d, 1e-6) * main.ty;
  const share = half > 0 ? b.r / half : 1;
  return share < a.lodEvery4 ? 4 : share < a.lodEvery2 ? 2 : 1;
}
