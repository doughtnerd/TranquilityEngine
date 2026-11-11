// What a captain can tell about the sea around them, as plain functions the HUD draws, bots obey
// (and tests check): how close the arena's edge is and the way back, what the minimap shows, and
// where an off-screen marker sits on the screen's edge.
//
// Two kinds of hiding, one set of rules:
// - Seen (on the water): a ship inside another team's fog cloud is hidden from that team, on the
//   water, on the minimap, in the scoreboard's flag mark and from bots. `seenBy`.
// - Charted (on the minimap and the off-screen flag marker): seen, and not a ghost ship. A ghost
//   still sails in plain sight (translucent), but enemies' minimaps leave it out, and the flag's
//   marker hides while a ghost holds it. `chartedBy`.
// Bots have no minimap: they spot ships they can see within `BOT_SIGHT`, and a ghost only within
// `BOT_GHOST_SIGHT` (it's hard to make out). `botSpots`.
import { inCloudAmong, type CloudSpot } from "./data";

/** How far a bot spots an enemy ship it can see, and a ghost ship (metres). */
export const BOT_SIGHT = 50;
export const BOT_GHOST_SIGHT = 25;

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
 * The camera looks north (-Z) from the south, so the screen's up is world -Z and its right is world -X.
 * Map and compass directions are the screen's: north is up, east is right.
 */
export const SCREEN_RIGHT_X = -1;
export const SCREEN_UP_Z = -1;

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

/** The compass word for a direction on the water, as the screen shows it (north is up). */
export function compass(dx: number, dz: number): string {
  const east = dx * SCREEN_RIGHT_X;
  const a = Math.atan2(east, dz * SCREEN_UP_Z); // 0 = north, clockwise
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
  /** A ghost ship (the power-up): left off enemies' minimaps. */
  readonly ghost?: boolean;
}

/** True when `viewer`'s team can see `ship` on the water: its own, or not inside someone else's fog cloud. */
export function seenBy(viewer: number, ship: SeaShip, clouds: readonly CloudSpot[]): boolean {
  return ship.mine || ship.team === viewer || !inCloudAmong(clouds, ship.x, ship.z, viewer);
}

/** True when `viewer`'s minimap shows `ship`: seen, and (unless it's the viewer's own) not a ghost. */
export function chartedBy(viewer: number, ship: SeaShip, clouds: readonly CloudSpot[]): boolean {
  if (ship.mine || ship.team === viewer) return true;
  return !ship.ghost && seenBy(viewer, ship, clouds);
}

/**
 * True when a bot of team `viewer`, `distance` metres away, spots `ship` to shoot at or hunt: not in
 * someone else's fog cloud, within `BOT_SIGHT`, and within `BOT_GHOST_SIGHT` when it's a ghost.
 */
export function botSpots(viewer: number, ship: SeaShip, clouds: readonly CloudSpot[], distance: number): boolean {
  if (ship.team === viewer) return false;
  if (!seenBy(viewer, ship, clouds)) return false;
  return distance <= (ship.ghost ? BOT_GHOST_SIGHT : BOT_SIGHT);
}

type FlagSpot = { x: number; z: number; carrier: number };

/** The flag as `rule` lets the viewer tell it: where it is and who has it, or null when its holder is hidden. */
function flagBy(rule: typeof seenBy, viewer: number, flag: FlagSpot | null, ships: readonly SeaShip[], clouds: readonly CloudSpot[]): FlagSpot | null {
  if (!flag) return null;
  if (flag.carrier < 0) return flag;
  const holder = ships.find((s) => s.team === flag.carrier);
  if (!holder) return flag;
  if (!rule(viewer, holder, clouds)) return null;
  return { x: holder.x, z: holder.z, carrier: flag.carrier };
}

/** The flag as the viewer can see it on the water (the scoreboard's flag mark): null while its holder hides in fog. */
export function flagSeenBy(viewer: number, flag: FlagSpot | null, ships: readonly SeaShip[], clouds: readonly CloudSpot[]): FlagSpot | null {
  return flagBy(seenBy, viewer, flag, ships, clouds);
}

/** The flag as the viewer's minimap and off-screen marker show it: null while its holder hides in fog or is a ghost. */
export function flagChartedBy(viewer: number, flag: FlagSpot | null, ships: readonly SeaShip[], clouds: readonly CloudSpot[]): FlagSpot | null {
  return flagBy(chartedBy, viewer, flag, ships, clouds);
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
 * loose), and the ships afloat that the viewer's chart shows, the flag's holder marked. Ships
 * hidden in fog and other teams' ghost ships are left out, and so is a flag whose holder is.
 */
export function chartMarkers(input: ChartInput): MapMarker[] {
  const out: MapMarker[] = [];
  for (const c of input.clouds) out.push({ kind: "cloud", x: c.x, z: c.z });
  for (const p of input.pickups) out.push({ kind: "pickup", x: p.x, z: p.z, power: p.power });
  const flag = flagChartedBy(input.viewer, input.flag, input.ships, input.clouds);
  if (flag && flag.carrier < 0) out.push({ kind: "flag", x: flag.x, z: flag.z });
  for (const s of input.ships) {
    if (s.sunk || !chartedBy(input.viewer, s, input.clouds)) continue;
    out.push({ kind: "ship", x: s.x, z: s.z, team: s.team, mine: s.mine, holder: !!flag && flag.carrier === s.team });
  }
  return out;
}

/** A point on the water on a round minimap `size` pixels across showing an arena of `radius` metres (north up). */
export function chartPoint(x: number, z: number, radius: number, size: number): { x: number; y: number } {
  const half = size / 2;
  return { x: half + (x * SCREEN_RIGHT_X * half) / radius, y: half - (z * SCREEN_UP_Z * half) / radius };
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
