// What a captain can tell about the sea around them, as plain functions the HUD draws (and tests
// check): how close the arena's edge is and the way back, what the minimap shows (fog clouds hide
// ships from everyone but the cloud's own team, and a hidden flag holder hides the flag), and where
// an off-screen marker sits on the screen's edge.
import { inCloudAmong, type CloudSpot } from "./data";

/** Within this many metres of the arena's edge, the HUD warns that it's near. */
export const EDGE_WARNING = 12;

export type EdgeState = "inside" | "near" | "outside";

export interface EdgeStatus {
  readonly state: EdgeState;
  /** Metres past the edge: negative inside the arena. */
  readonly beyond: number;
  /** The way back to the middle, a unit vector on the water. */
  readonly homeX: number;
  readonly homeZ: number;
}

/** Where (x, z) is against an arena of `radius` metres round the origin. */
export function edgeStatus(x: number, z: number, radius: number, warning = EDGE_WARNING): EdgeStatus {
  const d = Math.hypot(x, z);
  const beyond = d - radius;
  const state: EdgeState = beyond > 0 ? "outside" : beyond > -warning ? "near" : "inside";
  return { state, beyond, homeX: d > 1e-6 ? -x / d : 0, homeZ: d > 1e-6 ? -z / d : 1 };
}

/**
 * The camera looks north (+Z) from the south, so the screen's up is +Z and its right is world -X.
 * Map and compass directions are the screen's: north is up, east is right.
 */
export const SCREEN_RIGHT_X = -1;

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

/** The compass word for a direction on the water, as the screen shows it (north is up). */
export function compass(dx: number, dz: number): string {
  const east = dx * SCREEN_RIGHT_X;
  const a = Math.atan2(east, dz); // 0 = north, clockwise
  const i = Math.round(a / (Math.PI / 4));
  return COMPASS[(i + 8) % 8];
}

/** A ship as the chart sees it. */
export interface SeaShip {
  readonly team: number;
  readonly x: number;
  readonly z: number;
  readonly sunk: boolean;
  /** The ship this client steers. */
  readonly mine: boolean;
}

/** True when `viewer`'s team can see `ship`: its own, or not inside someone else's fog cloud. */
export function seenBy(viewer: number, ship: SeaShip, clouds: readonly CloudSpot[]): boolean {
  return ship.mine || ship.team === viewer || !inCloudAmong(clouds, ship.x, ship.z, viewer);
}

/** The flag as the viewer can tell it: where it is and who has it, or null when it's hidden. */
export function flagSeenBy(viewer: number, flag: { x: number; z: number; carrier: number } | null, ships: readonly SeaShip[], clouds: readonly CloudSpot[]): { x: number; z: number; carrier: number } | null {
  if (!flag) return null;
  if (flag.carrier < 0) return flag;
  const holder = ships.find((s) => s.team === flag.carrier);
  if (!holder) return flag;
  if (!seenBy(viewer, holder, clouds)) return null;
  return { x: holder.x, z: holder.z, carrier: flag.carrier };
}

export type MapMarker =
  | { readonly kind: "cloud"; readonly x: number; readonly z: number }
  | { readonly kind: "pickup"; readonly x: number; readonly z: number; readonly power: number }
  | { readonly kind: "flag"; readonly x: number; readonly z: number }
  | { readonly kind: "ship"; readonly x: number; readonly z: number; readonly team: number; readonly mine: boolean; readonly holder: boolean };

export interface ChartInput {
  /** The viewer's team (-1: no ship yet). */
  readonly viewer: number;
  readonly ships: readonly SeaShip[];
  readonly clouds: readonly CloudSpot[];
  readonly flag: { x: number; z: number; carrier: number } | null;
  readonly pickups: readonly { x: number; z: number; power: number }[];
}

/**
 * What the minimap shows the viewer, bottom layer first: fog clouds, power-ups, the flag (when it's
 * loose), and the ships afloat that the viewer can see, the flag's holder marked. Ships hidden in
 * fog are left out, and so is a flag whose holder is hidden.
 */
export function chartMarkers(input: ChartInput): MapMarker[] {
  const out: MapMarker[] = [];
  for (const c of input.clouds) out.push({ kind: "cloud", x: c.x, z: c.z });
  for (const p of input.pickups) out.push({ kind: "pickup", x: p.x, z: p.z, power: p.power });
  const flag = flagSeenBy(input.viewer, input.flag, input.ships, input.clouds);
  if (flag && flag.carrier < 0) out.push({ kind: "flag", x: flag.x, z: flag.z });
  for (const s of input.ships) {
    if (s.sunk || !seenBy(input.viewer, s, input.clouds)) continue;
    out.push({ kind: "ship", x: s.x, z: s.z, team: s.team, mine: s.mine, holder: !!flag && flag.carrier === s.team });
  }
  return out;
}

/** A point on the water on a round minimap `size` pixels across showing an arena of `radius` metres (north up). */
export function chartPoint(x: number, z: number, radius: number, size: number): { x: number; y: number } {
  const half = size / 2;
  return { x: half + (x * SCREEN_RIGHT_X * half) / radius, y: half - (z * half) / radius };
}

/** How far in from each side of the screen off-screen markers stay. */
export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/**
 * Where an off-screen marker for a screen point goes: null when the point is on screen (inside
 * the screen less `insets`, and in front of the camera), else the point where the line from the
 * screen's middle toward it leaves that inset rectangle. `depth` is `Camera.worldToScreenPoint`'s
 * z (negative: behind the camera, where the point is mirrored).
 */
export function edgeMarker(sx: number, sy: number, depth: number, width: number, height: number, insets: Insets): { x: number; y: number } | null {
  const left = insets.left, right = width - insets.right, top = insets.top, bottom = height - insets.bottom;
  if (depth > 0 && sx >= left && sx <= right && sy >= top && sy <= bottom) return null;
  const cx = Math.min(right, Math.max(left, width / 2)), cy = Math.min(bottom, Math.max(top, height / 2));
  let dx = sx - cx, dy = sy - cy;
  if (depth <= 0) {
    dx = -dx;
    dy = -dy;
  }
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) dy = 1;
  const kx = dx > 0 ? (right - cx) / dx : dx < 0 ? (left - cx) / dx : Infinity;
  const ky = dy > 0 ? (bottom - cy) / dy : dy < 0 ? (top - cy) / dy : Infinity;
  const k = Math.max(0, Math.min(kx, ky));
  return { x: cx + dx * k, y: cy + dy * k };
}
