/**
 * The wakes of a World (ADR 0459): each `WaterWake`'s measured speed and trail, the simulated height
 * field, and the texels the water's renderer uploads for its shader. Renderer-neutral: the water's
 * render feature calls `updateWakes` once a frame with the point the camera looks at, and binds what
 * it returns. Only Worlds that draw water ever call it, so servers keep no wake state.
 */
import type { World } from "../../core/World";
import { WakeField, type WakeFieldSource } from "./wakeField";
import { WakePath, wakeStrength } from "./wakeTrail";
import { WaterWake } from "./WaterWake";

/** How a water surface draws wakes: a trail along the stern's path, a simulated height field, or none. */
export type WaterWakeMode = "trail" | "field" | "off";

/** Most wakes drawn at once (the nearest to the camera's focus when there are more). */
export const MAX_WAKES = 16;
/** Points of a trail sent to the shader: the stern now, then the path, newest first. */
export const TRAIL_POINTS = 16;
/** Texels per wake row in the trail texture: four of header, then the points. */
export const TRAIL_HEADER = 4;
export const TRAIL_TEXELS = TRAIL_HEADER + TRAIL_POINTS;
/** The height field's side (m) and cells per side. */
export const WAKE_FIELD_SIZE = 96;
export const WAKE_FIELD_RESOLUTION = 256;

/** Metres between trail points; a move further than `JUMP` in a frame (a respawn) starts a new trail. */
const SPACING = 1.6;
const JUMP = 8;
/** How quickly the measured speed and the strength follow the node (per second). */
const FOLLOW = 6;

interface Track {
  x: number;
  z: number;
  speed: number;
  /** The speed's wake strength, eased (0..1), times the wake's own `strength`. */
  eased: number;
  path: WakePath;
}

/** What the renderer binds for one frame. */
export interface WakeFrame {
  mode: WaterWakeMode;
  /** "trail": wakes in use, and `MAX_WAKES` rows of `TRAIL_TEXELS` RGBA texels. */
  trailCount: number;
  trail: Float32Array;
  /** "field": the field's world origin (its cell (0, 0)'s corner), side and cells per side, and its RGBA texels (height, ∂h/∂x, ∂h/∂z, foam). */
  fieldOrigin: [number, number];
  fieldSize: number;
  fieldResolution: number;
  field: Float32Array | null;
  /** Bumped whenever the texels change, so a renderer uploads only then. */
  version: number;
}

interface WakeState {
  frame: number;
  time: number | null;
  tracks: Map<WaterWake, Track>;
  sim: WakeField | null;
  out: WakeFrame;
}

const states = new WeakMap<World, WakeState>();

function state(world: World): WakeState {
  let s = states.get(world);
  if (!s) {
    s = {
      frame: -1,
      time: null,
      tracks: new Map(),
      sim: null,
      out: { mode: "off", trailCount: 0, trail: new Float32Array(MAX_WAKES * TRAIL_TEXELS * 4), fieldOrigin: [0, 0], fieldSize: WAKE_FIELD_SIZE, fieldResolution: WAKE_FIELD_RESOLUTION, field: null, version: 0 },
    };
    states.set(world, s);
  }
  return s;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);
const num = (v: number, d: number) => (Number.isFinite(v) ? v : d);

/**
 * Advance the World's wakes to its current time and pack them for `mode`, the trail texels for the
 * wakes nearest `focus` (world x, z) or the height field centred on it. Called more than once in a
 * frame (several views of one World), it steps once and returns the same frame.
 */
export function updateWakes(world: World, mode: WaterWakeMode, focus: { x: number; z: number } | null): WakeFrame {
  const s = state(world);
  const out = s.out;
  if (s.frame === world.time.frameCount && out.mode === mode) return out;
  s.frame = world.time.frameCount;
  const now = world.time.time;
  const dt = s.time === null ? 0 : Math.min(Math.max(now - s.time, 0), 0.25);
  s.time = now;

  // Measure every wake's speed and lay its trail.
  const seen = new Set<WaterWake>();
  const live: { wake: WaterWake; track: Track; px: number; pz: number; hx: number; hz: number }[] = [];
  for (const wake of world._componentsOfType(WaterWake)) {
    if (!wake.isActiveAndEnabled || !wake.node.transform) continue;
    seen.add(wake);
    const m = world.worldMatrix(wake.node.entity), o = wake.node.entity * 16;
    const px = m[o + 12]!, pz = m[o + 14]!;
    const hl = Math.hypot(m[o + 8]!, m[o + 10]!) || 1;
    const hx = m[o + 8]! / hl, hz = m[o + 10]! / hl;
    let track = s.tracks.get(wake);
    if (!track) s.tracks.set(wake, (track = { x: px, z: pz, speed: 0, eased: 0, path: new WakePath(SPACING, 2.6, TRAIL_POINTS - 1) }));
    const moved = Math.hypot(px - track.x, pz - track.z);
    const k = 1 - Math.exp(-FOLLOW * dt);
    if (moved > JUMP) {
      track.path.clear();
      track.speed = 0;
      track.eased = 0;
    } else if (dt > 0) track.speed += (moved / dt - track.speed) * k;
    track.x = px;
    track.z = pz;
    const own = clamp01(wake.strength);
    const target = wakeStrength(track.speed, num(wake.fullSpeed, 6)) * own;
    track.eased = own <= 0 ? 0 : track.eased + (target - track.eased) * k;
    track.path.life = Math.max(0.1, num(wake.life, 2.6));
    const stern = num(wake.stern, -2);
    track.path.step(px + hx * stern, pz + hz * stern, dt, track.eased > 0.01 ? track.eased : 0);
    live.push({ wake, track, px, pz, hx, hz });
  }
  for (const w of [...s.tracks.keys()]) if (!seen.has(w)) s.tracks.delete(w);

  out.mode = mode;
  out.version++;
  if (mode === "trail") packTrails(out, live, focus);
  else out.trailCount = 0;

  if (mode === "field") {
    s.sim ??= new WakeField(WAKE_FIELD_RESOLUTION, WAKE_FIELD_SIZE);
    const sim = s.sim;
    const f = focus ?? (live[0] ? { x: live[0].px, z: live[0].pz } : { x: 0, z: 0 });
    sim.recenter(f.x, f.z);
    const sources: WakeFieldSource[] = live.map(({ wake, track, px, pz, hx, hz }) => ({
      x: px, z: pz, hx, hz,
      bow: num(wake.bow, 2),
      stern: num(wake.stern, -2),
      beam: Math.max(0.2, num(wake.width, 3) * 0.3),
      strength: track.eased,
      foam: clamp01(wake.foam),
    }));
    sim.step(dt, sources);
    out.field ??= new Float32Array(WAKE_FIELD_RESOLUTION * WAKE_FIELD_RESOLUTION * 4);
    sim.pack(out.field);
    out.fieldOrigin = [sim.originX, sim.originZ];
  } else if (s.sim) {
    // Leaving field mode: the water calms, so switching back starts from still water.
    s.sim.clear();
  }
  return out;
}

/** Pack the trails of the wakes nearest `focus` into the trail texels (layout in `trailRow`). */
function packTrails(out: WakeFrame, live: { wake: WaterWake; track: Track; px: number; pz: number; hx: number; hz: number }[], focus: { x: number; z: number } | null): void {
  const drawn = live.filter((l) => clamp01(l.wake.strength) > 0 && (l.track.path.points.length > 0 || l.track.eased > 0.01));
  if (focus && drawn.length > MAX_WAKES) drawn.sort((a, b) => Math.hypot(a.px - focus.x, a.pz - focus.z) - Math.hypot(b.px - focus.x, b.pz - focus.z));
  const n = Math.min(MAX_WAKES, drawn.length);
  out.trail.fill(0);
  for (let w = 0; w < n; w++) trailRow(out.trail, w * TRAIL_TEXELS * 4, drawn[w]!);
  out.trailCount = n;
}

/**
 * One wake's row of texels:
 * - 0: (points in use, width at the stern, foam, ripples) — foam and ripples already × the wake's strength;
 * - 1: (stem x, stem z, heading x, heading z);
 * - 2: (bounds centre x, z, bounds radius, bow wave arm length);
 * - 3: (bow wave strength 0..1, life (s), unused, unused);
 * - 4…: points, the stern now first, then its path newest first: (x, z, age / life, strength laid at).
 */
function trailRow(t: Float32Array, o: number, l: { wake: WaterWake; track: Track; px: number; pz: number; hx: number; hz: number }): void {
  const { wake, track, px, pz, hx, hz } = l;
  const own = clamp01(wake.strength);
  const width = Math.max(0.1, num(wake.width, 3));
  const life = track.path.life;
  const bow = num(wake.bow, 2), stern = num(wake.stern, -2);
  const sx = px + hx * stern, sz = pz + hz * stern;
  const bx = px + hx * bow, bz = pz + hz * bow;
  const pts = [{ x: sx, z: sz, age: 0, strength: track.eased }, ...track.path.points].slice(0, TRAIL_POINTS);
  // Bounds: every point and the stem, widened by the widest the foam and the Kelvin wedge get.
  let minX = bx, maxX = bx, minZ = bz, maxZ = bz, length = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    if (i > 0) length += Math.hypot(p.x - pts[i - 1]!.x, p.z - pts[i - 1]!.z);
  }
  const bowLength = 0.8 + Math.min(4, track.speed * 0.3);
  const pad = width * 1.5 + length * 0.4 + bowLength + 1;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  t.set([pts.length, width, clamp01(wake.foam) * own, clamp01(wake.ripples) * own], o);
  t.set([bx, bz, hx, hz], o + 4);
  t.set([cx, cz, Math.hypot(maxX - minX, maxZ - minZ) / 2 + pad, bowLength], o + 8);
  t.set([track.eased, life, 0, 0], o + 12);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    t.set([p.x, p.z, Math.min(1, p.age / life), p.strength], o + (TRAIL_HEADER + i) * 4);
  }
}
