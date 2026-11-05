/* tslint:disable */
/* eslint-disable */

/**
 * A chunk's baker (see the module doc).
 */
export class NavBaker {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Bakes the chunk; returns its `myco.nav@1` bytes.
     */
    bakeChunk(input_json: string, positions: Float32Array | number[], indices: Uint32Array | number[], mesh_table_json: string): Uint8Array;
    /**
     * Drops the caches (the next bake is a full one).
     */
    clearCaches(): void;
    /**
     * The last bake's report as JSON (empty before the first bake).
     */
    lastBakeReport(): string;
    constructor();
}

/**
 * A World's navigation runtime (see the module doc and `runtime.ts`).
 */
export class NavRuntime {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Queues an agent (live from the next tick); returns its handle. `desc_json`: `AgentDescDto`.
     */
    addAgent(desc_json: string): number;
    /**
     * Queues an avoidance obstacle at a position; returns its handle (its row in the obstacle buffer).
     */
    addObstacle(desc_json: string, x: number, y: number, z: number): number;
    /**
     * Rows in the agent buffers (agent slots ever made).
     */
    agentRows(): number;
    agentStatePtr(): number;
    /**
     * `[kind, pathState, mode, flags, position xyz, rotation xyzw, up xyz, velocity xyz, desired xyz, remaining,
     * chunk entry]` (22), or empty for a stale or not yet live handle.
     */
    agentState(agent_handle: number): Float32Array;
    /**
     * Byte offsets of the boundary buffers in `memory()` (see `nav_crowd::boundary`); they move when `epoch` changes.
     */
    agentsInPtr(): number;
    agentsOutPtr(): number;
    /**
     * Chases another agent; `repath_distance` 0 = the default.
     */
    chaseAgent(agent_handle: number, target_agent: number, repath_distance: number): void;
    /**
     * Chases a host target (positions from `setTargetPositions`).
     */
    chaseTarget(agent_handle: number, target_id: number, repath_distance: number): void;
    clearAreaCosts(agent_handle: number): void;
    /**
     * Every live agent's current path as segments: stride 7 (a xyz, b xyz, agent row).
     */
    debugAgentPaths(): Float32Array;
    /**
     * A loaded chunk's landing links for an agent type: stride 6 (ground xyz, air xyz).
     */
    debugLandingLinks(chunk_id: string, agent_type: string): Float32Array;
    /**
     * A loaded chunk's navmesh for an agent type: segments, stride 7 (see `debug.rs`).
     */
    debugNavmeshLines(chunk_id: string, agent_type: string): Float32Array;
    /**
     * A loaded chunk's navmesh polygons as triangles, stride 11 (a, b, c, bin, area).
     */
    debugNavmeshTriangles(chunk_id: string, agent_type: string): Float32Array;
    /**
     * The live seams' links: stride 7.
     */
    debugSeams(): Float32Array;
    /**
     * A loaded chunk's flight leaves for an agent type: stride 5 (min xyz, size, area).
     */
    debugVolumeLeaves(chunk_id: string, agent_type: string): Float32Array;
    /**
     * Log lines since the last drain (JSON array of strings).
     */
    drainLogs(): string;
    /**
     * Warnings since the last drain (JSON array of strings).
     */
    drainWarnings(): string;
    /**
     * Changes whenever the buffers were reallocated (views must be rebuilt).
     */
    epoch(): number;
    /**
     * `[status, (x, y, z, nx, ny, nz, flags)...]`: status 0 full path, 1 partial, 2 none. Flags: waypoint flag bits,
     * 0x80 on flight points.
     */
    findPath(agent_type: string, fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): Float32Array;
    isLive(agent_handle: number): boolean;
    /**
     * True if a full path exists.
     */
    isReachable(agent_type: string, fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): boolean;
    joinGroup(agent_handle: number, group_handle: number): void;
    /**
     * Leaves its group; with `has_goal`, walks on to (x, y, z).
     */
    leaveGroup(agent_handle: number, has_goal: boolean, x: number, y: number, z: number): void;
    /**
     * Loads (or replaces) a chunk from its `myco.nav@1` bytes; `id` is its chunk id (hex from `chunkId`).
     */
    loadChunk(id: string, bytes: Uint8Array | number[]): void;
    /**
     * The loaded chunks' ids (hex), as a JSON array.
     */
    loadedChunks(): string;
    /**
     * `[x, y, z, nx, ny, nz]` or empty.
     */
    nearestPoint(agent_type: string, x: number, y: number, z: number, max_distance: number): Float32Array;
    /**
     * `settings_json`: the `navigation` project settings section (agent types, areas, runtime budgets).
     */
    constructor(settings_json: string);
    obstacleRows(): number;
    obstaclesInPtr(): number;
    /**
     * The agent's current path: position xyz, normal xyz, flags per waypoint (copied).
     */
    pathWaypoints(agent_handle: number): Float32Array;
    /**
     * `[t, reached, x, y, z, nx, ny, nz]` or empty (start off the navmesh).
     */
    raycast(agent_type: string, fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): Float32Array;
    removeAgent(agent_handle: number): void;
    removeObstacle(obstacle_handle: number): void;
    removeTarget(target_id: number): void;
    /**
     * An agent's own area cost (`cost` < 0: the area's default).
     */
    setAreaCost(agent_handle: number, area: string, cost: number, excluded: boolean): void;
    setDestination(agent_handle: number, x: number, y: number, z: number): void;
    /**
     * A flow goal on a host target (`move_threshold` 0 = the default), or none with `enabled` false.
     */
    setFlowGoal(target_id: number, enabled: boolean, move_threshold: number): void;
    setGate(gate_id: string, open: boolean): void;
    setGroupJoining(agent_handle: number, joining: boolean): void;
    /**
     * A group body's painted shape: `width` x `height` bits, row 0 the front, 64 bits per word.
     */
    setGroupMask(group_handle: number, bits: BigUint64Array | bigint[], width: number, height: number): void;
    /**
     * Replaces the agent types and runtime budgets (agents keep the settings they were added with).
     */
    setSettings(settings_json: string): void;
    setSpeed(agent_handle: number, speed: number, turn_speed: number): void;
    /**
     * Host targets' positions for the next tick: `ids[i]` at `positions[3i..3i+3]`. Unlisted targets keep theirs.
     */
    setTargetPositions(ids: Uint32Array | number[], positions: Float32Array | number[]): void;
    /**
     * Surround slots on a host target (`NavSurround` JSON), or none with an empty string.
     */
    setTargetSurround(target_id: number, surround_json: string): void;
    /**
     * The World's override of an area's cost (`Navigation.setAreaCost`), under every agent's own.
     */
    setWorldAreaCost(area: string, cost: number, excluded: boolean): void;
    stopChase(agent_handle: number): void;
    stop(agent_handle: number): void;
    /**
     * What the last tick did, as JSON (`tick`, `agents`, `paused`, `commands`, `chunks`).
     */
    tickStats(): string;
    /**
     * One runtime tick (`engine.NavStep`): reads `agentsIn` / `obstaclesIn`, applies the commands, writes
     * `agentsOut` / `agentState`.
     */
    tick(dt: number, time: number): void;
    unloadChunk(id: string): boolean;
    warp(agent_handle: number, x: number, y: number, z: number): void;
}

/**
 * Which navmesh and flight volume sections (`[walk group, fly group]`, -1 for none) a bake holds for an agent type
 * (its id as in project settings): the groups the `debugBake*` functions take.
 */
export function bakeAgentGroups(bytes: Uint8Array | number[], agent_type: string): Int32Array;

/**
 * A summary of a `myco.nav@1` bake file as JSON (for the editor's asset inspector and tests):
 * `{ "packageVersion", "signature", "sections": [{ "kind", "group", "group2", "length", "fingerprint" }] }`,
 * or `{ "error" }`. With `verify`, the whole file is parsed and every section's fingerprint checked.
 */
export function bakeInfo(bytes: Uint8Array | number[], verify: boolean): string;

/**
 * What a chunk bakes for each agent type (`plan::bake_plan`), as JSON.
 */
export function bakePlan(input_json: string, walkable_for_json: string): string;

/**
 * Strides of the boundary buffers: `[agentsIn, agentsOut, agentState, obstaclesIn, waypoint]`.
 */
export function bufferStrides(): Uint32Array;

/**
 * A chunk's id (hex) from its scene's project path (forward slashes) and the chunk node's id.
 */
export function chunkId(scene_path: string, chunk_node_id: string): string;

/**
 * The bin each triangle (9 floats each) bakes into, -1 where it isn't walkable (`plan::classify_surface_bins`).
 */
export function classifySurfaceBins(settings_json: string, positions: Float32Array | number[]): Int32Array;

/**
 * A bake's flight volume (section `group`) leaves, filtered: stride 5 as [`debug_bake_leaves`]. With `area` (an area
 * id as in project settings) only leaves in that area (none if the volume doesn't know it); with `refined_only` only
 * leaves inside a resolution region (their cell is smaller than the volume's base cell). The editor's previews of the
 * selected modifier and resolution volumes.
 */
export function debugBakeFlightLeaves(bytes: Uint8Array | number[], group: number, area: string, refined_only: boolean): Float32Array;

/**
 * A bake's flight volume (section `group`) leaves: stride 5 (min xyz, size, area).
 */
export function debugBakeLeaves(bytes: Uint8Array | number[], group: number): Float32Array;

/**
 * A bake's navmesh (section `group`) as line segments, without a runtime (the editor's scene view): stride 7, see
 * `debug::navmesh_lines`.
 */
export function debugBakeLines(bytes: Uint8Array | number[], group: number): Float32Array;

/**
 * A bake's navmesh polygons as triangles: stride 11 (a, b, c, bin, area).
 */
export function debugBakeTriangles(bytes: Uint8Array | number[], group: number): Float32Array;

/**
 * A string id as the runtime and bakes see it (32 hex digits; see `dto::parse_id`).
 */
export function navId(id: string): string;

/**
 * The orientation bins the navigation settings make (`plan::surface_bin_layout`), as JSON.
 */
export function surfaceBinLayout(settings_json: string): string;

/**
 * The crate's version, for the loader to check against the TypeScript side.
 */
export function version(): string;

/**
 * The module's memory, for typed-array views of the boundary buffers.
 */
export function wasmMemory(): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_navbaker_free: (a: number, b: number) => void;
    readonly __wbg_navruntime_free: (a: number, b: number) => void;
    readonly bakeAgentGroups: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly bakeInfo: (a: number, b: number, c: number) => [number, number];
    readonly bakePlan: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly bufferStrides: () => [number, number];
    readonly chunkId: (a: number, b: number, c: number, d: number) => [number, number];
    readonly classifySurfaceBins: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly debugBakeFlightLeaves: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly debugBakeLeaves: (a: number, b: number, c: number) => [number, number, number, number];
    readonly debugBakeLines: (a: number, b: number, c: number) => [number, number, number, number];
    readonly debugBakeTriangles: (a: number, b: number, c: number) => [number, number, number, number];
    readonly navId: (a: number, b: number) => [number, number];
    readonly navbaker_bakeChunk: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number, number];
    readonly navbaker_clearCaches: (a: number) => void;
    readonly navbaker_lastBakeReport: (a: number) => [number, number];
    readonly navbaker_new: () => number;
    readonly navruntime_addAgent: (a: number, b: number, c: number) => [number, number, number];
    readonly navruntime_addObstacle: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly navruntime_agentRows: (a: number) => number;
    readonly navruntime_agentState: (a: number, b: number) => [number, number];
    readonly navruntime_agentStatePtr: (a: number) => number;
    readonly navruntime_agentsInPtr: (a: number) => number;
    readonly navruntime_agentsOutPtr: (a: number) => number;
    readonly navruntime_chaseAgent: (a: number, b: number, c: number, d: number) => void;
    readonly navruntime_chaseTarget: (a: number, b: number, c: number, d: number) => void;
    readonly navruntime_clearAreaCosts: (a: number, b: number) => void;
    readonly navruntime_debugAgentPaths: (a: number) => [number, number];
    readonly navruntime_debugLandingLinks: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly navruntime_debugNavmeshLines: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly navruntime_debugNavmeshTriangles: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly navruntime_debugSeams: (a: number) => [number, number];
    readonly navruntime_debugVolumeLeaves: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly navruntime_drainLogs: (a: number) => [number, number];
    readonly navruntime_drainWarnings: (a: number) => [number, number];
    readonly navruntime_epoch: (a: number) => number;
    readonly navruntime_findPath: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
    readonly navruntime_isLive: (a: number, b: number) => number;
    readonly navruntime_isReachable: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly navruntime_joinGroup: (a: number, b: number, c: number) => void;
    readonly navruntime_leaveGroup: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly navruntime_loadChunk: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly navruntime_loadedChunks: (a: number) => [number, number];
    readonly navruntime_nearestPoint: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly navruntime_new: (a: number, b: number) => [number, number, number];
    readonly navruntime_obstacleRows: (a: number) => number;
    readonly navruntime_obstaclesInPtr: (a: number) => number;
    readonly navruntime_pathWaypoints: (a: number, b: number) => [number, number];
    readonly navruntime_raycast: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
    readonly navruntime_removeAgent: (a: number, b: number) => void;
    readonly navruntime_removeObstacle: (a: number, b: number) => void;
    readonly navruntime_removeTarget: (a: number, b: number) => void;
    readonly navruntime_setAreaCost: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly navruntime_setDestination: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly navruntime_setFlowGoal: (a: number, b: number, c: number, d: number) => void;
    readonly navruntime_setGate: (a: number, b: number, c: number, d: number) => void;
    readonly navruntime_setGroupJoining: (a: number, b: number, c: number) => void;
    readonly navruntime_setGroupMask: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly navruntime_setSettings: (a: number, b: number, c: number) => [number, number];
    readonly navruntime_setSpeed: (a: number, b: number, c: number, d: number) => void;
    readonly navruntime_setTargetPositions: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly navruntime_setTargetSurround: (a: number, b: number, c: number, d: number) => [number, number];
    readonly navruntime_setWorldAreaCost: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly navruntime_stop: (a: number, b: number) => void;
    readonly navruntime_stopChase: (a: number, b: number) => void;
    readonly navruntime_tick: (a: number, b: number, c: number) => void;
    readonly navruntime_tickStats: (a: number) => [number, number];
    readonly navruntime_unloadChunk: (a: number, b: number, c: number) => number;
    readonly navruntime_warp: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly surfaceBinLayout: (a: number, b: number) => [number, number];
    readonly version: () => [number, number];
    readonly wasmMemory: () => any;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
