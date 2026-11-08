/**
 * Debug drawing geometry for navigation (ADR 0065 "Debug drawing"): typed access to the wasm debug
 * buffers that need no runtime (a bake's bytes), and pure functions that turn the flat buffers
 * (see `debug.rs`) into coloured line segments the editor overlay draws (`EditorOverlay.segments`).
 * Used by the scene view (the Navigation plugin's src/plugins/navigation/editor/navGizmo.ts) and, through `RuntimeNavOverlay`, by games.
 */
import { loadNavigation } from "./loader";

/** Line kinds in `debugNavmeshLines` and `debugBakeLines` buffers (stride 7: a xyz, b xyz, kind). */
export const LINE_KIND = { outline: 0, shared: 1, fold: 2, jump: 3, chunkFace: 4 } as const;

/** Which parts to draw. */
export interface NavDebugFlags {
  /** Polygon outlines, shared edges and chunk-face edges. */
  navmesh: boolean;
  /** Fold and jump links. */
  links: boolean;
  /** Flight volume leaves (heavy: capped). */
  volume: boolean;
  /** Landing links (runtime only: a bake's bytes don't list them). */
  landing: boolean;
  /** Seams between loaded chunks (runtime only). */
  seams: boolean;
  /** Agents' current paths (runtime only). */
  paths: boolean;
  /** Polygons tinted by their runtime cost multiplier from NavCostVolumes (runtime only; ADR 0070). */
  costs: boolean;
}

export const NO_NAV_DEBUG: NavDebugFlags = { navmesh: false, links: false, volume: false, landing: false, seams: false, paths: false, costs: false };

/** 0xRRGGBB per drawn kind. */
export interface NavDebugColors {
  outline: number;
  shared: number;
  fold: number;
  jump: number;
  chunkFace: number;
  volume: number;
  landing: number;
  seam: number;
  path: number;
  /** Runtime cost volumes (ADR 0070): polygons costing more, less, or excluded. */
  costly: number;
  cheap: number;
  excluded: number;
}

/** A run of line segments in one colour: 6 floats per segment (a xyz, b xyz). Same shape as `EditorOverlay.segments`. */
export interface DebugSegments {
  positions: Float32Array;
  color: number;
}

/** Caps so a big bake can't make the scene view crawl (segments per drawing, leaves in total). */
export const NAV_DEBUG_CAPS = { segments: 60_000, leaves: 4_000, arcSteps: 8 } as const;

/** Reads a flags object tolerantly: `true` turns everything but the volume on, objects set the keys they name. */
export function readNavDebugFlags(input: unknown, base: NavDebugFlags = NO_NAV_DEBUG): NavDebugFlags {
  if (input === true) return { navmesh: true, links: true, volume: false, landing: true, seams: true, paths: true, costs: true };
  if (!input || typeof input !== "object") return { ...base };
  const o = input as Record<string, unknown>;
  const out = { ...base };
  for (const key of Object.keys(NO_NAV_DEBUG) as (keyof NavDebugFlags)[]) if (typeof o[key] === "boolean") out[key] = o[key] as boolean;
  return out;
}

/** True if any flag is on. */
export const anyNavDebug = (f: NavDebugFlags): boolean => Object.values(f).some(Boolean);

// ----------------------------------------------------------------------------------------- from a bake's bytes

/** A bake's flight volume leaves (section `group`), stride 5: min xyz, edge length, area. */
export async function debugBakeLeaves(bytes: Uint8Array, group = 0): Promise<Float32Array> {
  return (await loadNavigation()).debugBakeLeaves(bytes, group);
}

// ----------------------------------------------------------------------------------------- buffers to segments

class SegmentBuilder {
  private data: number[] = [];
  constructor(readonly color: number, private readonly cap: number) {}
  get count(): number {
    return this.data.length / 6;
  }
  add(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    if (this.count >= this.cap) return false;
    this.data.push(ax, ay, az, bx, by, bz);
    return true;
  }
  done(): DebugSegments {
    return { positions: Float32Array.from(this.data), color: this.color };
  }
}

/** Navmesh lines (stride 7) to segments by kind. Jump links become arcs; the total is capped. */
export function navmeshLineSegments(
  lines: Float32Array,
  flags: Pick<NavDebugFlags, "navmesh" | "links">,
  colors: NavDebugColors,
  cap: number = NAV_DEBUG_CAPS.segments,
  arcSteps: number = NAV_DEBUG_CAPS.arcSteps,
): DebugSegments[] {
  const builders = new Map<number, SegmentBuilder>();
  const colorOf = (kind: number) =>
    kind === LINE_KIND.shared ? colors.shared : kind === LINE_KIND.fold ? colors.fold : kind === LINE_KIND.jump ? colors.jump : kind === LINE_KIND.chunkFace ? colors.chunkFace : colors.outline;
  let total = 0;
  for (let i = 0; i + 7 <= lines.length && total < cap; i += 7) {
    const kind = lines[i + 6];
    const isLink = kind === LINE_KIND.fold || kind === LINE_KIND.jump;
    if (isLink ? !flags.links : !flags.navmesh) continue;
    let b = builders.get(kind);
    if (!b) builders.set(kind, (b = new SegmentBuilder(colorOf(kind), cap)));
    const ax = lines[i], ay = lines[i + 1], az = lines[i + 2], bx = lines[i + 3], by = lines[i + 4], bz = lines[i + 5];
    if (kind === LINE_KIND.jump && arcSteps > 1) {
      // A parabola lifted along +Y (up) by a quarter of the span, at most 2 m.
      const lift = Math.min(2, 0.25 * Math.hypot(bx - ax, by - ay, bz - az));
      let px = ax, py = ay, pz = az;
      for (let s = 1; s <= arcSteps; s++) {
        const t = s / arcSteps;
        const x = ax + (bx - ax) * t, y = ay + (by - ay) * t + 4 * lift * t * (1 - t), z = az + (bz - az) * t;
        if (b.add(px, py, pz, x, y, z)) total++;
        px = x;
        py = y;
        pz = z;
      }
    } else if (b.add(ax, ay, az, bx, by, bz)) total++;
  }
  return [...builders.values()].filter((b) => b.count > 0).map((b) => b.done());
}

/** Flight leaves (stride 5: min xyz, edge, area) as cube wireframes; over `maxLeaves` only every n-th is drawn. */
export function leafSegments(leaves: Float32Array, color: number, maxLeaves: number = NAV_DEBUG_CAPS.leaves): DebugSegments[] {
  const n = Math.floor(leaves.length / 5);
  if (n === 0) return [];
  const step = Math.max(1, Math.ceil(n / maxLeaves));
  const b = new SegmentBuilder(color, maxLeaves * 12);
  for (let leaf = 0; leaf < n; leaf += step) {
    const o = leaf * 5, x = leaves[o], y = leaves[o + 1], z = leaves[o + 2], s = leaves[o + 3];
    const corner = (i: number): [number, number, number] => [x + (i & 1 ? s : 0), y + (i & 2 ? s : 0), z + (i & 4 ? s : 0)];
    for (let i = 0; i < 8; i++) {
      for (const bit of [1, 2, 4]) {
        if (i & bit) continue;
        const a = corner(i), d = corner(i | bit);
        b.add(a[0], a[1], a[2], d[0], d[1], d[2]);
      }
    }
  }
  return [b.done()];
}

/**
 * Runtime cost outlines (stride 7: a xyz, b xyz, multiplier; ADR 0070) as segments tinted by multiplier: one colour
 * for excluded polygons, one for costlier (> 1) and one for cheaper (< 1).
 */
export function costSegments(buf: Float32Array, colors: Pick<NavDebugColors, "costly" | "cheap" | "excluded">, cap: number = NAV_DEBUG_CAPS.segments): DebugSegments[] {
  const costly = new SegmentBuilder(colors.costly, cap);
  const cheap = new SegmentBuilder(colors.cheap, cap);
  const excluded = new SegmentBuilder(colors.excluded, cap);
  for (let i = 0; i + 7 <= buf.length; i += 7) {
    const m = buf[i + 6];
    const b = m === Infinity ? excluded : m > 1 ? costly : m < 1 ? cheap : null;
    b?.add(buf[i], buf[i + 1], buf[i + 2], buf[i + 3], buf[i + 4], buf[i + 5]);
  }
  return [excluded, costly, cheap].filter((b) => b.count > 0).map((b) => b.done());
}

/** Segments from a flat buffer of `stride` floats per row whose first six are a xyz, b xyz (landing links, seams, agent paths). */
export function rowSegments(buf: Float32Array, stride: number, color: number, cap: number = NAV_DEBUG_CAPS.segments): DebugSegments[] {
  const b = new SegmentBuilder(color, cap);
  for (let i = 0; i + stride <= buf.length; i += stride) if (!b.add(buf[i], buf[i + 1], buf[i + 2], buf[i + 3], buf[i + 4], buf[i + 5])) break;
  return b.count > 0 ? [b.done()] : [];
}

// ----------------------------------------------------------------------------------------- the live runtime

/** The runtime calls the overlay needs (`NavigationRuntime` has them). */
export interface NavDebugSource {
  debugNavmeshLines(chunkId: string, agentType: string): Float32Array;
  debugVolumeLeaves(chunkId: string, agentType: string): Float32Array;
  debugLandingLinks(chunkId: string, agentType: string): Float32Array;
  debugSeams(): Float32Array;
  debugAgentPaths(): Float32Array;
  /** Optional: runtimes without cost volumes draw none. */
  debugCosts?(chunkId: string, agentType: string): Float32Array;
}

/** Chunk ids out of whatever `NavigationWorld.loadedChunks()` returns (strings, or objects with an `id`/`chunkId`). */
export function chunkIdsOf(loaded: unknown): string[] {
  if (!loaded) return [];
  const list: unknown[] = Array.isArray(loaded) ? loaded : loaded instanceof Map ? [...loaded.keys()] : loaded instanceof Set ? [...loaded] : [];
  const out: string[] = [];
  for (const c of list) {
    if (typeof c === "string") out.push(c);
    else if (c && typeof c === "object") {
      const o = c as { id?: unknown; chunkId?: unknown };
      const id = typeof o.chunkId === "string" ? o.chunkId : typeof o.id === "string" ? o.id : null;
      if (id) out.push(id);
    }
  }
  return out;
}

/**
 * The live runtime's debug drawing. The navmesh, links, volume and landing geometry (which only
 * changes when chunks load or overlays rebuild) is refreshed every `slowMs`; paths, seams and runtime costs
 * every `fastMs`, so a frame mostly reuses the arrays.
 */
export class RuntimeNavOverlay {
  private slow: DebugSegments[] = [];
  private fast: DebugSegments[] = [];
  private slowAt = -Infinity;
  private fastAt = -Infinity;

  constructor(
    private readonly source: NavDebugSource,
    private readonly chunks: () => string[],
    private readonly agentTypes: () => string[],
    private readonly flags: () => NavDebugFlags,
    private readonly colors: () => NavDebugColors,
    private readonly clock: () => number = () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
    private readonly slowMs = 500,
    private readonly fastMs = 100,
  ) {}

  segments(): DebugSegments[] {
    const f = this.flags();
    if (!anyNavDebug(f)) return [];
    const now = this.clock();
    const colors = this.colors();
    if (now - this.slowAt >= this.slowMs) {
      this.slowAt = now;
      this.slow = [];
      for (const chunk of this.chunks()) {
        for (const type of this.agentTypes()) {
          try {
            if (f.navmesh || f.links) this.slow.push(...navmeshLineSegments(this.source.debugNavmeshLines(chunk, type), f, colors));
            if (f.volume) this.slow.push(...leafSegments(this.source.debugVolumeLeaves(chunk, type), colors.volume));
            if (f.landing) this.slow.push(...rowSegments(this.source.debugLandingLinks(chunk, type), 6, colors.landing));
          } catch {
            // A chunk unloaded between listing and drawing: skip it this time.
          }
        }
      }
    }
    if (now - this.fastAt >= this.fastMs) {
      this.fastAt = now;
      this.fast = [];
      try {
        if (f.seams) this.fast.push(...rowSegments(this.source.debugSeams(), 7, colors.seam));
        if (f.paths) this.fast.push(...rowSegments(this.source.debugAgentPaths(), 7, colors.path));
        if (f.costs && this.source.debugCosts) {
          for (const chunk of this.chunks()) for (const type of this.agentTypes()) this.fast.push(...costSegments(this.source.debugCosts(chunk, type), colors));
        }
      } catch {
        // The runtime was disposed.
      }
    }
    return [...this.slow, ...this.fast];
  }
}
