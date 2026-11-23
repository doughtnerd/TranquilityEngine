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
import type { World } from "../../../../../engine/core/World";
import { Camera } from "../../../../../engine/render/components";
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

const sphere: Sphere = { x: 0, y: 0, z: 0, r: 0 };

function boundsOf(rt: AnimatorRuntime): Sphere | null {
  const s = rt.skeleton;
  const t = s?.component.node.transform;
  if (!s || !t) return null;
  const m = t.localToWorld.value;
  const scale = Math.max(Math.hypot(m[0]!, m[1]!, m[2]!), Math.hypot(m[4]!, m[5]!, m[6]!), Math.hypot(m[8]!, m[9]!, m[10]!));
  sphere.x = m[12]!;
  sphere.y = m[13]!;
  sphere.z = m[14]!;
  sphere.r = (s.info ? Math.max(s.info.radius, 0.1) : DEFAULT_RADIUS) * POSE_REACH * scale;
  return sphere;
}

/** Whether `b` is inside (or touches) `camera`'s view. */
function inView(camera: Camera, b: Sphere): boolean {
  const l = camera.node.transform?.localToWorld;
  if (!l) return true;
  const p = l.position, right = l.right, up = l.up, fwd = l.forward;
  const dx = b.x - p.x, dy = b.y - p.y, dz = b.z - p.z;
  const x = dx * right.x + dy * right.y + dz * right.z;
  const y = dx * up.x + dy * up.y + dz * up.z;
  const z = dx * fwd.x + dy * fwd.y + dz * fwd.z;
  if (z + b.r < camera.near || z - b.r > camera.far) return false;
  const aspect = camera.aspect > 0 ? camera.aspect : 1;
  if (camera.projection === "orthographic") {
    const h = camera.orthographicSize;
    return Math.abs(y) <= h + b.r && Math.abs(x) <= h * aspect + b.r;
  }
  const ty = Math.tan((camera.fieldOfView * Math.PI) / 360);
  const tx = ty * aspect;
  // Distance from the sphere's centre to each side plane, measured along the plane's normal.
  return Math.abs(y) - ty * z <= b.r * Math.hypot(1, ty) && Math.abs(x) - tx * z <= b.r * Math.hypot(1, tx);
}

function cameras(world: World): readonly Camera[] {
  return world._componentsOfType(Camera).filter((c) => c.isActiveAndEnabled);
}

/** @internal Whether any enabled Camera of `world` sees `rt`'s skeleton (true without cameras or bounds). */
export function isVisible(world: World, rt: AnimatorRuntime): boolean {
  const cams = cameras(world);
  if (!cams.length) return true;
  const b = boundsOf(rt);
  if (!b) return true;
  for (const c of cams) if (inView(c, b)) return true;
  return false;
}

/** @internal The update-rate LOD step (1, 2 or 4) for `rt` this frame. */
export function lodStep(world: World, rt: AnimatorRuntime): number {
  const a = rt.animator;
  if (a.lodMetric === "off") return 1;
  const cams = cameras(world);
  if (!cams.length) return 1;
  const main = cams.reduce((best, c) => (c.depth < best.depth ? c : best));
  const b = boundsOf(rt);
  const at = main.node.transform?.worldPosition;
  if (!b || !at) return 1;
  const d = Math.hypot(b.x - at.x, b.y - at.y, b.z - at.z);
  if (a.lodMetric === "distance") return d > a.lodEvery4 ? 4 : d > a.lodEvery2 ? 2 : 1;
  const half = main.projection === "orthographic" ? main.orthographicSize : Math.max(d, 1e-6) * Math.tan((main.fieldOfView * Math.PI) / 360);
  const share = half > 0 ? b.r / half : 1;
  return share < a.lodEvery4 ? 4 : share < a.lodEvery2 ? 2 : 1;
}
