// The animation core's host (ADR 0370, "Memory and the boundary"): typed wrappers over the wasm exports, with plain
// numbers, typed arrays and the wire's record layouts at its edges (no wasm types leave this folder). One per page,
// shared by every World (`loader.ts`); each World is a namespace in it (`AnimationWorldCore`, its World id).
//
// - **Assets** are reference-counted by key over every World: the first `acquire` of a key copies the bytes into the
//   core's arena, later ones share the handle. When the last reference goes the asset is *idle*: kept, so a scene that
//   loads it again reuses it, until `releaseIdle`, which runs when an Engine is disposed (an editor play session ends,
//   a project closes, a game exits).
// - **Instances** are index-plus-generation handles; a handle's index is its row in every view.
// - **Views** (`views()`) are typed arrays over the core's memory. A load, an instance creation or a restore can grow the
//   memory, which detaches every view, so call `views()` again after any call and never keep one across calls; it
//   rebuilds them only when the memory has moved.
// - **The frame:** `writeInputs` (through a World's command writer), then `evaluate(world, pass, dtScaled, dtUnscaled)`,
//   then read the output views and the state-change records before the next `writeInputs` (which clears them).
import {
  HANDLE_INDEX_MASK,
  INIT,
  INPUT_STRIDE,
  MATRIX_FLOATS,
  MEMORY_NEEDED,
  ROOT_STRIDE,
  STATE_CHANGE,
  STATUS_OK,
  STATUS_STALE_HANDLE,
  TRACK_STRIDE,
} from "../wasm/wire/core";
import { BLACKBOARD_STRIDE, GRAPH_CHANGE } from "../wasm/wire/graph";
import { PLUGIN_FAULT } from "../wasm/wire/plugin";
import type { EvaluateCounts } from "./frameMeter";
import { RAY_ROW_STRIDE, RIG_INPUT_STRIDE } from "../wasm/wire/rig";
import { TIMELINE_BLOCK, TIMELINE_CHANGE, TIMELINE_CONTROL, TIMELINE_CREATE, TIMELINE_INFO } from "../wasm/wire/timeline";
import { TWEEN_CHANGE, TWEEN_CONTROL, TWEEN_CREATE } from "../wasm/wire/tween";
import type * as AnimWasm from "../wasm/myco_anim.js";
import { encodeRecord, getRecord, type RecordFields, type RecordValues } from "./records";

/** @internal The glue module (`../wasm/myco_anim.js`) once instantiated. */
export type AnimationWasm = typeof AnimWasm;

/** @internal The `INIT` record's limits: fixed for the page's core (every World shares them). */
export interface AnimationCoreLimits {
  /** Animator instances alive at once over every World (at most 65,535). */
  readonly maxInstances: number;
  /** Bones in one skeleton (at most 65,535); a skeleton with more is refused (`STATUS_TOO_LARGE`). */
  readonly maxBones: number;
  /** The asset arena's first size in bytes; it grows in load calls. */
  readonly arenaInitialBytes: number;
}

/** The most roles a profile has (`anim-retarget`'s `MAX_ROLES`): the bone map buffers' size. */
const GUESS_CAPACITY = 1024;

/** @internal The limits a page's core starts with when a project names none. */
export const DEFAULT_CORE_LIMITS: AnimationCoreLimits = { maxInstances: 512, maxBones: 256, arenaInitialBytes: 4 << 20 };

/** @internal What an asset is made from: a file's bytes, or the arguments of the export that builds it. */
export type AnimationAssetSource =
  | { readonly kind: "skeleton" | "clip" | "graph" | "posedb" | "profile" | "plugin"; readonly bytes: Uint8Array }
  | { readonly kind: "mask"; readonly weights: Float32Array }
  | { readonly kind: "ragdoll"; readonly skeleton: number; readonly bytes: Uint8Array }
  | {
      readonly kind: "retargetMap";
      readonly source: RetargetSide;
      readonly target: RetargetSide;
      readonly flags: number;
    };

/** @internal One side of a retarget map: a skeleton handle, a profile (0: humanoid, else a profile handle) and its bone map. */
export interface RetargetSide {
  readonly skeleton: number;
  readonly profile: number;
  readonly map: Uint16Array;
}

/** @internal An asset kind. */
export type AnimationAssetKind = AnimationAssetSource["kind"];

/** @internal Typed arrays over the core's memory; valid until the next call into the core (see the file header). */
export interface AnimationViews {
  readonly buffer: ArrayBuffer;
  /** The whole memory. */
  readonly data: DataView;
  /** Input rows, `INPUT_STRIDE` bytes per instance index (`INPUT_*` offsets). */
  readonly inputs: DataView;
  /** Graph parameter rows (blackboard), `BLACKBOARD_STRIDE` bytes per instance index. */
  readonly blackboard: DataView;
  /** Model-space bone matrices, 3×4 row-major: `maxBones × MATRIX_FLOATS` floats per instance index. */
  readonly matrices: Float32Array;
  /** Root-motion deltas: `ROOT_STRIDE / 4` floats per instance index (translation xyz, rotation xyzw). */
  readonly roots: Float32Array;
  /** Track regions, `TRACK_STRIDE` bytes per instance index (`TRACK_*` offsets, the `tracks` family's records). */
  readonly tracks: DataView;
  /** Rig input rows (T40t), `RIG_INPUT_STRIDE` bytes per instance index (`rig` family: character, rig LOD, IK target slots, ray hits). */
  readonly rigInputs: DataView;
  /** Grounder ray requests (T40t), `RAY_ROW_STRIDE` bytes per instance index (`rig` family), written by the last evaluate. */
  readonly rays: DataView;
}

/** @internal Counts for the profiler and the debug views. */
export interface AnimationCoreStats {
  /** Assets loaded (in use or idle). */
  readonly assets: number;
  /** Of those, assets no World references (released by `releaseIdle`). */
  readonly idleAssets: number;
  /** Instances alive over every World. */
  readonly instances: number;
  /** The core's memory now, in bytes. */
  readonly memoryBytes: number;
  /** What the core said its limits need (`MEMORY_NEEDED.bytes`). */
  readonly neededBytes: number;
}

interface AssetEntry {
  readonly key: string;
  readonly handle: number;
  refs: number;
}

/** The handle's row in every view. */
const instanceRow = (handle: number): number => handle & HANDLE_INDEX_MASK;

/** The arena key of `key` as `kind` (a key names one asset per kind). */
const assetKey = (key: string, kind: AnimationAssetKind): string => `${kind}\u0000${key}`;

/** @internal Thrown by {@link AnimationCore.start} when the core refuses its limits and the defaults alike. */
export class AnimationCoreInitError extends Error {}

/** @internal The page's animation core. */
export class AnimationCore {
  /**
   * Starts `wasm` with `limits` (one `INIT` record), honouring the `MEMORY_NEEDED` reply: limits the core refuses
   * (`STATUS_TOO_LARGE`, a bad record) fall back to the defaults with `warn`; when it refuses those too this throws.
   */
  static start(wasm: AnimationWasm, memory: () => ArrayBuffer, limits: AnimationCoreLimits, warn: (message: string) => void): AnimationCore {
    const ask = (l: AnimationCoreLimits) => getRecord(new DataView(wasm.init(encodeRecord(INIT, l)).buffer), 0, MEMORY_NEEDED);
    let reply = ask(limits);
    let used = limits;
    if (reply.status !== STATUS_OK && limits !== DEFAULT_CORE_LIMITS) {
      warn(`[myco] animation: the core refused its limits (${JSON.stringify(limits)}, status ${reply.status}); using the defaults.`);
      used = DEFAULT_CORE_LIMITS;
      reply = ask(used);
    }
    if (reply.status !== STATUS_OK) throw new AnimationCoreInitError(`animation core: init refused (status ${reply.status})`);
    return new AnimationCore(wasm, memory, used, reply.bytes);
  }

  private readonly byKey = new Map<string, AssetEntry>();
  private readonly byHandle = new Map<number, AssetEntry>();
  private readonly instances = new Set<number>();
  private readonly freeWorlds: number[] = [];
  private nextWorld = 0;
  private cached: AnimationViews | null = null;
  private changeCount = 0;

  private constructor(
    private readonly wasm: AnimationWasm,
    private readonly memory: () => ArrayBuffer,
    readonly limits: AnimationCoreLimits,
    private readonly neededBytes: number,
  ) {}

  /** Why the last call that returned a handle (or 0) did so: a `STATUS_*`. */
  lastStatus(): number {
    return this.wasm.last_status();
  }

  // --- Worlds ---------------------------------------------------------------------------------------------------

  /** @internal A free World id (a namespace: instances are created in it and `evaluate` runs one). */
  openWorld(): number {
    return this.freeWorlds.pop() ?? this.nextWorld++;
  }

  /** @internal Gives a World id back once its instances are destroyed. */
  closeWorld(id: number): void {
    this.freeWorlds.push(id);
  }

  // --- Assets ---------------------------------------------------------------------------------------------------

  /**
   * One reference to the asset `key` of `source`'s kind: loads it on the first reference (or reuses it while idle).
   * Returns its handle, or 0 when the core refused it (`lastStatus` says why). `source` may be a function, called only
   * when the asset isn't loaded. Handles an asset is built from (a ragdoll's skeleton, a retarget map's) stay the
   * caller's to hold.
   */
  acquire(key: string, kind: AnimationAssetKind, source: AnimationAssetSource | (() => AnimationAssetSource)): number {
    const known = this.acquireLoaded(key, kind);
    if (known !== 0) return known;
    const s = typeof source === "function" ? source() : source;
    if (s.kind !== kind) return 0;
    const handle = this.load(s);
    if (handle === 0) return 0;
    const entry: AssetEntry = { key: assetKey(key, kind), handle, refs: 1 };
    this.byKey.set(entry.key, entry);
    this.byHandle.set(handle, entry);
    return handle;
  }

  /** One more reference to the asset `key` when it is loaded (in use or idle): its handle; else 0, taking none. */
  acquireLoaded(key: string, kind: AnimationAssetKind): number {
    const known = this.byKey.get(assetKey(key, kind));
    if (!known) return 0;
    known.refs++;
    return known.handle;
  }

  private load(s: AnimationAssetSource): number {
    const w = this.wasm;
    switch (s.kind) {
      case "skeleton":
        return w.load_skeleton(s.bytes);
      case "clip":
        return w.load_clip(s.bytes);
      case "graph":
        return w.load_graph(s.bytes);
      case "posedb":
        return w.posedb_load(s.bytes);
      case "profile":
        return w.profile_decode(s.bytes);
      case "plugin":
        return w.plugin_register(s.bytes);
      case "mask":
        return w.load_mask(s.weights);
      case "ragdoll":
        return w.ragdoll_create(s.skeleton, s.bytes);
      case "retargetMap":
        return w.retarget_map_create(s.source.skeleton, s.source.profile, s.source.map, s.target.skeleton, s.target.profile, s.target.map, s.flags);
    }
  }

  /**
   * Guesses a skeleton profile's bone map for a `myco.skel@1` skeleton (ADR 0371 import, T41g's `guess_bone_map`):
   * the profile's `encodeSkeletonProfile` bytes, or null for the built-in Humanoid. Returns each role's bone index
   * (`0xFFFF` for none) in the profile's role order, or null when the core refused (`lastStatus` says why).
   */
  guessBoneMap(skeleton: Uint8Array, profile: Uint8Array | null): Uint16Array | null {
    const w = this.wasm;
    const handle = profile ? w.profile_decode(profile) : 0;
    if (profile && handle === 0) return null;
    const bones = new Uint16Array(GUESS_CAPACITY);
    const roles = w.guess_bone_map(skeleton, handle, bones, new Float32Array(GUESS_CAPACITY));
    if (handle) w.release(handle);
    return roles === 0 ? null : bones.slice(0, roles);
  }

  /** Drops one reference to an asset; with none left it is idle. Returns false for a handle this core doesn't hold. */
  release(handle: number): boolean {
    const entry = this.byHandle.get(handle);
    if (!entry || entry.refs === 0) return false;
    entry.refs--;
    return true;
  }

  /** Releases every idle asset from the core (its handle goes stale). Returns how many. */
  releaseIdle(): number {
    let n = 0;
    for (const entry of [...this.byHandle.values()]) {
      if (entry.refs > 0) continue;
      this.wasm.release(entry.handle);
      this.byHandle.delete(entry.handle);
      this.byKey.delete(entry.key);
      n++;
    }
    return n;
  }

  /** References held to an asset over every World (0 when idle or unknown). */
  references(handle: number): number {
    return this.byHandle.get(handle)?.refs ?? 0;
  }

  /** Binds a graph's string id to a clip, mask or graph handle (0 unbinds). Returns a status. */
  bindGraph(graph: number, stringId: number, asset: number): number {
    return this.wasm.graph_bind(graph, stringId, asset);
  }

  /** Binds a pose database's clip `index` to a clip handle (0 unbinds). Returns a status. */
  bindPoseDb(db: number, index: number, clip: number): number {
    return this.wasm.posedb_bind(db, index, clip);
  }

  /** A pose database clip's asset reference ("" for none). */
  poseDbClip(db: number, index: number): string {
    return this.wasm.posedb_clip(db, index);
  }

  /** A clip's `COLUMN` records (the `tracks` family), for binding its property tracks. */
  clipColumns(clip: number): Uint8Array {
    const out = new Uint8Array(this.wasm.clip_column_bytes(clip));
    const written = this.wasm.clip_columns(clip, out);
    return written === out.length ? out : out.subarray(0, written);
  }

  /**
   * A copy of a clip's or graph's file bytes as the core holds them (the container's length word sizes it), or null for
   * a handle without bytes. The host reads a clip's track table from it (`features/properties/clipData.ts`), so clips
   * loaded any way (a file, an import made in memory) bind the same.
   */
  assetBytes(handle: number): Uint8Array | null {
    const at = this.wasm.asset_bytes_ptr(handle);
    if (at === 0) return null;
    const buffer = this.memory();
    if (at + 32 > buffer.byteLength) return null;
    const length = new DataView(buffer).getUint32(at + 16, true);
    if (length < 32 || at + length > buffer.byteLength) return null;
    return new Uint8Array(buffer, at, length).slice();
  }

  /** The IK goals of a retarget map. */
  retargetGoalCount(map: number): number {
    return this.wasm.retarget_goal_count(map);
  }

  // --- Instances --------------------------------------------------------------------------------------------------

  /** Creates an instance in World `world` (graph 0: the implicit graph). Returns its handle, or 0 (`lastStatus`). */
  createInstance(world: number, skeleton: number, graph = 0): number {
    const h = this.wasm.create_instance(world, skeleton, graph);
    if (h !== 0) this.instances.add(h);
    return h;
  }

  /** Destroys an instance. Returns a status (`STATUS_STALE_HANDLE` for one already gone). */
  destroyInstance(handle: number): number {
    if (!this.instances.delete(handle)) return STATUS_STALE_HANDLE;
    return this.wasm.destroy_instance(handle);
  }

  /** An instance's state (graph state, playheads, fades, poses; not its input row) as bytes, or null for a stale handle. */
  snapshot(handle: number): Uint8Array | null {
    const n = this.wasm.snapshot_bytes(handle);
    if (n === 0) return null;
    const out = new Uint8Array(n);
    return this.wasm.snapshot(handle, out) === STATUS_OK ? out : null;
  }

  /** Restores a snapshot into an instance of the same graph and skeleton. Returns a status. */
  restore(handle: number, bytes: Uint8Array): number {
    return this.wasm.restore(handle, bytes);
  }

  // --- Tweens and timelines (D44: direct exports, one record each; their outputs are cleared by `writeInputs`) ------

  /** Creates a tween (`TWEEN_CREATE`). Returns its handle, or 0 (`lastStatus`). */
  tweenCreate(values: RecordValues<typeof TWEEN_CREATE>): number {
    return this.wasm.tween_create(encodeRecord(TWEEN_CREATE, values));
  }

  /** Pauses, resumes, kills or marks destroyed a tween (`TWEEN_CONTROL`'s `op`). Returns a status. */
  tweenControl(handle: number, op: number): number {
    return this.wasm.tween_control(encodeRecord(TWEEN_CONTROL, { handle, op }));
  }

  /** This frame's tween rows: row `i` is column `columns[i]` and the four floats at `values[4i]` (valid until the next call). */
  tweenRows(): { readonly count: number; readonly columns: Uint32Array; readonly values: Float32Array } {
    const n = this.wasm.tween_values_count();
    const buffer = this.memory();
    return { count: n, columns: new Uint32Array(buffer, this.wasm.tween_columns_ptr(), n), values: new Float32Array(buffer, this.wasm.tween_values_ptr(), n * 4) };
  }

  /** Tween state-change records waiting since the last `writeInputs`. */
  tweenChangeCount(): number {
    return this.wasm.tween_changes_count();
  }

  /** Tween state-change record `i` (`tween.TWEEN_CHANGE`). */
  tweenChange(i: number, out?: RecordFields<typeof TWEEN_CHANGE>): RecordFields<typeof TWEEN_CHANGE> {
    return getRecord(this.views().data, this.wasm.tween_changes_ptr() + i * TWEEN_CHANGE.stride, TWEEN_CHANGE, out);
  }

  /** Creates an instance of a clip used as a timeline (`TIMELINE_CREATE`). Returns its handle, or 0 (`lastStatus`). */
  timelineCreate(values: RecordValues<typeof TIMELINE_CREATE>): number {
    return this.wasm.timeline_create(encodeRecord(TIMELINE_CREATE, values));
  }

  /** Creates a sequence (`SEQ_CREATE` followed by its `SEQ_MEMBER` records). Returns its handle, or 0 (`lastStatus`). */
  timelineCreateSequence(bytes: Uint8Array): number {
    return this.wasm.timeline_create_sequence(bytes);
  }

  /** Controls a timeline instance (`TIMELINE_CONTROL`). Returns a status. */
  timelineControl(handle: number, op: number, value = 0): number {
    return this.wasm.timeline_control(encodeRecord(TIMELINE_CONTROL, { handle, op, value }));
  }

  /** Binds a timeline's subclip string id (of the clip `owner`'s string table) to a clip handle. Returns a status. */
  timelineBind(instance: number, owner: number, stringId: number, asset: number): number {
    return this.wasm.timeline_bind(instance, owner, stringId, asset);
  }

  /** Where an instance's outputs sit (`TIMELINE_INFO`), or null for a stale handle. Read again after a bind. */
  timelineInfo(instance: number): RecordFields<typeof TIMELINE_INFO> | null {
    const out = new Uint8Array(TIMELINE_INFO.stride);
    if (this.wasm.timeline_info(instance, out) !== TIMELINE_INFO.stride) return null;
    return getRecord(new DataView(out.buffer), 0, TIMELINE_INFO);
  }

  /** An instance's block table (`TIMELINE_BLOCK` records); empty for a stale handle. */
  timelineBlocks(instance: number): RecordFields<typeof TIMELINE_BLOCK>[] {
    const out = new Uint8Array(this.wasm.timeline_block_bytes(instance));
    const n = this.wasm.timeline_blocks(instance, out);
    const view = new DataView(out.buffer);
    const blocks: RecordFields<typeof TIMELINE_BLOCK>[] = [];
    for (let at = 0; at + TIMELINE_BLOCK.stride <= n; at += TIMELINE_BLOCK.stride) blocks.push(getRecord(view, at, TIMELINE_BLOCK));
    return blocks;
  }

  /** The handles of the timeline instances evaluated since the last `writeInputs` (a copy). */
  timelineActive(): Uint32Array {
    return new Uint32Array(this.memory(), this.wasm.timeline_active_ptr(), this.wasm.timeline_active_count()).slice();
  }

  /** Word views from the timeline value region's start, and the block weights (valid until the next call). */
  timelineOutputs(): { readonly f32: Float32Array; readonly u32: Uint32Array; readonly weights: Float32Array } {
    const buffer = this.memory();
    const v = this.wasm.timeline_values_ptr();
    const n = (buffer.byteLength - v) >> 2;
    const w = this.wasm.timeline_weights_ptr();
    return { f32: new Float32Array(buffer, v, n), u32: new Uint32Array(buffer, v, n), weights: new Float32Array(buffer, w, (buffer.byteLength - w) >> 2) };
  }

  /** The `tracks` family records the timelines wrote since the last `writeInputs`: a byte range of `views().data`. */
  timelineRecords(): { readonly at: number; readonly bytes: number; readonly count: number } {
    return { at: this.wasm.timeline_records_ptr(), bytes: this.wasm.timeline_records_len(), count: this.wasm.timeline_records_count() };
  }

  /** Timeline state-change records waiting since the last `writeInputs`. */
  timelineChangeCount(): number {
    return this.wasm.timeline_changes_count();
  }

  /** Timeline state-change record `i` (`timeline.TIMELINE_CHANGE`). */
  timelineChange(i: number, out?: RecordFields<typeof TIMELINE_CHANGE>): RecordFields<typeof TIMELINE_CHANGE> {
    return getRecord(this.views().data, this.wasm.timeline_changes_ptr() + i * TIMELINE_CHANGE.stride, TIMELINE_CHANGE, out);
  }

  // --- Physical animation (T44: the `physics` wire family; `features/physical.ts` is the only caller) ---------------

  /** The default ragdoll description of a `myco.skel@1` file (profile 0: Humanoid): `RAGDOLL_INFO` + `RAGDOLL_BONE` bytes, empty when refused (`lastStatus`). */
  ragdollBuild(skeleton: Uint8Array, profile = 0): Uint8Array {
    return this.wasm.ragdoll_build(skeleton, profile);
  }

  /** Sizes the physics rows and views (drops every row). Returns a status. */
  physicsConfigure(maxRows: number): number {
    return this.wasm.physics_configure(maxRows);
  }

  /** Gives an instance a physics row driven by a ragdoll asset: the row index, or `NONE` (`lastStatus`). */
  physicsAttach(instance: number, ragdoll: number): number {
    return this.wasm.physics_attach(instance, ragdoll);
  }

  /** Frees an instance's physics row. Returns a status. */
  physicsDetach(instance: number): number {
    return this.wasm.physics_detach(instance);
  }

  /** After the physics step: World `world`'s input rows into its instances' physical-pose nodes. Returns the rows applied. */
  physicsRead(world: number): number {
    return this.wasm.physics_read(world);
  }

  /** After the fixed evaluate: World `world`'s drive targets and get-up facing into the output rows. Returns the rows written. */
  physicsDrive(world: number): number {
    return this.wasm.physics_drive(world);
  }

  /** Get-up: an instance's physical-pose node into its pose-snapshot node (graph node indices). Returns a status. */
  physicsCapture(instance: number, physicalNode: number, snapshotNode: number): number {
    return this.wasm.physics_capture(instance, physicalNode, snapshotNode);
  }

  /** Where the physics views sit now (byte offsets in `views().data`, bytes per row): re-read after any call. */
  physicsViews(): { readonly input: number; readonly output: number; readonly inRowBytes: number; readonly outRowBytes: number } {
    const w = this.wasm;
    return { input: w.physics_in_ptr(), output: w.physics_out_ptr(), inRowBytes: w.physics_in_row_bytes(), outRowBytes: w.physics_out_row_bytes() };
  }

  // --- The frame --------------------------------------------------------------------------------------------------

  /** The command buffer's byte offset in memory (`COMMAND_BYTES` long). */
  commandsPtr(): number {
    return this.wasm.commands_ptr();
  }

  /** Applies the first `len` bytes of the command buffer (and the blackboard rows); clears the change records. */
  writeInputs(len: number): number {
    this.changeCount = 0;
    return this.wasm.write_inputs(len);
  }

  /** Evaluates World `world`'s instances of `pass` (`PASS_NORMAL`, `PASS_FIXED`). Returns the state-change records waiting. */
  evaluate(world: number, pass: number, dtScaled: number, dtUnscaled: number): number {
    this.changeCount = this.wasm.evaluate(world, pass, dtScaled, dtUnscaled);
    return this.changeCount;
  }

  /** State-change records waiting since the last `writeInputs` (as the last `evaluate` counted them). */
  stateChangeCount(): number {
    return this.changeCount;
  }

  /** State-change record `i` (`core.STATE_CHANGE`), into `out` when given. */
  stateChange(i: number, out?: RecordFields<typeof STATE_CHANGE>): RecordFields<typeof STATE_CHANGE> {
    return getRecord(this.views().data, this.wasm.changes_ptr() + i * STATE_CHANGE.stride, STATE_CHANGE, out);
  }

  /** State changes dropped this frame because the buffer was full. */
  stateChangesDropped(): number {
    return this.wasm.changes_dropped();
  }

  /** Graph state-change records waiting since the last `writeInputs`. */
  graphChangeCount(): number {
    return this.wasm.graph_change_count();
  }

  /** Graph state-change record `i` (`graph.GRAPH_CHANGE`), into `out` when given. */
  graphChange(i: number, out?: RecordFields<typeof GRAPH_CHANGE>): RecordFields<typeof GRAPH_CHANGE> {
    return getRecord(this.views().data, this.wasm.graph_changes_ptr() + i * GRAPH_CHANGE.stride, GRAPH_CHANGE, out);
  }

  /** Third-party node faults reported since the last `writeInputs` (T45t: each node instance's first fault). */
  pluginFaultCount(): number {
    return this.wasm.plugin_fault_count();
  }

  /** Third-party node fault record `i` (`plugin.PLUGIN_FAULT`), into `out` when given. */
  pluginFault(i: number, out?: RecordFields<typeof PLUGIN_FAULT>): RecordFields<typeof PLUGIN_FAULT> {
    return getRecord(this.views().data, this.wasm.plugin_faults_ptr() + i * PLUGIN_FAULT.stride, PLUGIN_FAULT, out);
  }

  /** Fault reports dropped since the last `writeInputs` because the buffer was full. */
  pluginFaultsDropped(): number {
    return this.wasm.plugin_faults_dropped();
  }

  /**
   * Writes the debug report of an instance flagged with the `graph` family's `DEBUG` command (the `debug` family's
   * records, as of its last evaluate) into the debug buffer. Returns the bytes written (0: not flagged, or stale).
   */
  debugWrite(handle: number): number {
    return this.wasm.debug_write(handle);
  }

  /** The debug buffer's byte offset in memory (`debug.DEBUG_BYTES` long). */
  debugPtr(): number {
    return this.wasm.debug_ptr();
  }

  /** The core's memory now (a load can replace it: re-read after any call). */
  buffer(): ArrayBuffer {
    return this.memory();
  }

  /** The views over the core's memory, rebuilt when it has moved (see the file header). */
  views(): AnimationViews {
    const buffer = this.memory();
    if (this.cached?.buffer === buffer) return this.cached;
    const w = this.wasm;
    const n = this.limits.maxInstances;
    this.cached = {
      buffer,
      data: new DataView(buffer),
      inputs: new DataView(buffer, w.inputs_ptr(), n * INPUT_STRIDE),
      blackboard: new DataView(buffer, w.blackboard_ptr(), n * BLACKBOARD_STRIDE),
      matrices: new Float32Array(buffer, w.matrices_ptr(), n * this.limits.maxBones * MATRIX_FLOATS),
      roots: new Float32Array(buffer, w.roots_ptr(), (n * ROOT_STRIDE) / 4),
      tracks: new DataView(buffer, w.tracks_ptr(), n * TRACK_STRIDE),
      rigInputs: new DataView(buffer, w.rig_inputs_ptr(), n * RIG_INPUT_STRIDE),
      rays: new DataView(buffer, w.rig_rays_ptr(), n * RAY_ROW_STRIDE),
    };
    return this.cached;
  }

  /** The float offset of instance `handle`'s first bone matrix in `views().matrices`. */
  matrixOffset(handle: number): number {
    return instanceRow(handle) * this.limits.maxBones * MATRIX_FLOATS;
  }

  /** The last `evaluate` call's counters (the profiler's Animation table; `core/frameMeter.ts`). */
  evaluateCounts(): EvaluateCounts {
    const d = this.views().data;
    const at = this.wasm.stats_ptr();
    const w = (i: number) => d.getUint32(at + i * 4, true);
    return { instances: w(0), culled: w(1), lodSkipped: w(2), evaluated: w(3), bones: w(4), skinned: w(5) };
  }

  stats(): AnimationCoreStats {
    let idle = 0;
    for (const e of this.byHandle.values()) if (e.refs === 0) idle++;
    return { assets: this.byHandle.size, idleAssets: idle, instances: this.instances.size, memoryBytes: this.memory().byteLength, neededBytes: this.neededBytes };
  }
}

