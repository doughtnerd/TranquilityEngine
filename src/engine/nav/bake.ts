/**
 * Internal (ADR 0065): bakes one chunk (a scene, or a NavChunk node) into `myco.nav@1` bytes through the
 * navigation module's `NavBaker`. The caller (the editor's bake worker, `nav:bake`) collects world-space
 * triangles; this packs them into two flat arrays and a table, and keeps one baker per chunk so rebakes in a
 * session reuse unchanged tiles.
 */
import { loadNavigation } from "./loader";
import type { NavigationSettings } from "./settings";
import type { NavBaker } from "./wasm/myco_nav.js";

/** One mesh, in world space. Triangles are wound so the walkable side faces along `cross(b - a, c - a)`. */
export interface NavBakeMesh {
  /** xyz per vertex. */
  positions: Float32Array;
  /** Three per triangle, into this mesh's vertices. */
  indices: Uint32Array;
  /** A walkable surface (default) or an obstacle (solid for every agent type, never walkable). */
  kind?: "navMesh" | "obstacle";
  /** The area id of a walkable surface; default plain walkable. */
  area?: string;
  /** Agent type ids it is walkable for; empty or missing = every agent type. */
  walkableFor?: string[];
}

/** An oriented box: `boxToWorld` maps the unit box `[-0.5, 0.5]^3` to world space (column-major, three.js order). */
type BoxToWorld = readonly number[];

/** A chunk's bake settings besides geometry (`NavChunk` and the volumes in its scene). */
export interface NavBakeChunk {
  /** Bake only inside a box (snapped to the settings' chunk grid). */
  useChunkBounds?: boolean;
  center?: readonly [number, number, number];
  size?: readonly [number, number, number];
  /** Overlay depths, in tiles. */
  minOverlayDepth?: number;
  maxOverlayDepth?: number;
  /** Agent type ids that get nothing in this chunk. */
  skipAgents?: string[];
  modifierVolumes?: { boxToWorld: BoxToWorld; area: string; appliesTo?: "ground" | "air" | "both"; affectedAgents?: string[] }[];
  gates?: { boxToWorld: BoxToWorld; id: string; startOpen?: boolean }[];
  resolutionVolumes?: { boxToWorld: BoxToWorld; cellSize: number; affectedAgents?: string[] }[];
}

export interface NavBakeBounds {
  min: [number, number, number];
  max: [number, number, number];
}

/** What a bake did (`nav-wasm`'s `baker.rs`, `report_json`). */
export interface NavBakeReport {
  /** The id to load the bytes under (`NavigationRuntime.loadChunk`). */
  chunkId: string;
  /** The input signature: equal inputs, equal signature (a bake older than its inputs has a different one). */
  signature: string;
  scenePath: string;
  chunkNodeId: string;
  chunkBounds: NavBakeBounds | null;
  navmeshBounds: NavBakeBounds[];
  agents: { id: string; name: string; group: number }[];
  flyers: { id: string; name: string; group: number }[];
  landingPairs: [number, number][];
  fingerprints: string[];
  details: string[];
  warnings: string[];
  navmeshes: { group: number; polys: number; links: number }[];
  volumes: { group: number; leaves: number }[];
  report: {
    triangles: number;
    tiers: number;
    tiles: number;
    reusedTiles: number;
    tasks: number;
    builtTasks: number;
    reusedTasks: number;
    stitch: { polys: number; internalLinks: number; seamLinks: number; foldLinks: number; jumpLinks: number; boundaryEdges: number; seamEdges: number }[];
    flightLeaves: number[];
    /** Per stage; 0 ms inside WebAssembly (it has no clock): use {@link NavBakeResult.ms} for the total. */
    stageTimes: { stage: string; ms: number }[];
    totalMs: number;
  };
  summary: string;
}

export interface NavBakeResult {
  bytes: Uint8Array;
  report: NavBakeReport;
  /** Wall-clock time of the bake call. */
  ms: number;
}

/**
 * One incremental baker per chunk, most recently used last. Each holds its tile and task caches in WASM memory
 * (which never shrinks), so only the last few chunks baked keep theirs: rebaking the chunk being worked on stays
 * incremental, and Bake All over a big project doesn't keep every chunk's caches.
 */
const bakers = new Map<string, NavBaker>();
export const MAX_CACHED_BAKERS = 8;

/** Packs meshes into the flat arrays and table `NavBaker.bakeChunk` reads. */
export function packMeshes(meshes: readonly NavBakeMesh[]): { positions: Float32Array; indices: Uint32Array; table: object[] } {
  let vertexCount = 0;
  let indexCount = 0;
  for (const m of meshes) {
    vertexCount += Math.floor(m.positions.length / 3);
    indexCount += m.indices.length;
  }
  const positions = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  const table: object[] = [];
  let v = 0;
  let i = 0;
  for (const m of meshes) {
    const verts = Math.floor(m.positions.length / 3);
    positions.set(m.positions.subarray(0, verts * 3), v * 3);
    indices.set(m.indices, i);
    table.push({
      vertexStart: v,
      vertexCount: verts,
      indexStart: i,
      indexCount: m.indices.length,
      kind: m.kind ?? "navMesh",
      area: m.area ?? null,
      walkableFor: m.walkableFor ?? [],
    });
    v += verts;
    i += m.indices.length;
  }
  return { positions, indices, table };
}

/**
 * Bakes a chunk. Rebakes of the same chunk (`scenePath` + `chunkNodeId`) in this session are incremental.
 * Throws if the input can't be read (a mesh range outside the arrays, bad JSON).
 */
export async function bakeChunk(
  meshes: readonly NavBakeMesh[],
  settings: NavigationSettings,
  scenePath: string,
  chunkNodeId: string,
  chunk: NavBakeChunk = {},
): Promise<NavBakeResult> {
  const mod = await loadNavigation();
  const key = `${scenePath}\n${chunkNodeId}`;
  let baker = bakers.get(key);
  if (baker) bakers.delete(key); // re-added below as the most recent
  else baker = new mod.NavBaker();
  bakers.set(key, baker);
  for (const [oldKey, old] of bakers) {
    if (bakers.size <= MAX_CACHED_BAKERS) break;
    old.free();
    bakers.delete(oldKey);
  }
  const { positions, indices, table } = packMeshes(meshes);
  const { modifierVolumes = [], gates = [], resolutionVolumes = [], ...chunkSettings } = chunk;
  const input = { settings, chunk: chunkSettings, modifierVolumes, gates, resolutionVolumes, scenePath, chunkNodeId };
  const start = performance.now();
  const bytes = baker.bakeChunk(JSON.stringify(input), positions, indices, JSON.stringify(table));
  const ms = performance.now() - start;
  return { bytes, report: JSON.parse(baker.lastBakeReport()) as NavBakeReport, ms };
}

/** Forgets a chunk's caches (its next bake is a full one), or every chunk's. */
export function releaseBakeCaches(scenePath?: string, chunkNodeId?: string): void {
  if (scenePath === undefined) {
    for (const b of bakers.values()) b.free();
    bakers.clear();
    return;
  }
  const key = `${scenePath}\n${chunkNodeId ?? ""}`;
  bakers.get(key)?.free();
  bakers.delete(key);
}
