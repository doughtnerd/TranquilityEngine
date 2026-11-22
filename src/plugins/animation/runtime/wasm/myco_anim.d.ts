/* tslint:disable */
/* eslint-disable */

/**
 * The byte offset of a clip's or graph's file bytes in memory (0 for none).
 */
export function asset_bytes_ptr(handle: number): number;

/**
 * The blackboard view's byte offset in memory (`graph` family, `BLACKBOARD_STRIDE` bytes per
 * instance index).
 */
export function blackboard_ptr(): number;

/**
 * State changes dropped this frame because the buffer was full.
 */
export function changes_dropped(): number;

/**
 * The state-change records' byte offset in memory.
 */
export function changes_ptr(): number;

/**
 * Bytes of a clip's `COLUMN` records.
 */
export function clip_column_bytes(clip: number): number;

/**
 * Writes a clip's `COLUMN` records into `out`; returns the bytes written.
 */
export function clip_columns(clip: number, out: Uint8Array): number;

/**
 * The command buffer's byte offset in memory (`COMMAND_BYTES` long).
 */
export function commands_ptr(): number;

/**
 * Creates an instance; returns its handle, or 0.
 */
export function create_instance(world: number, skeleton: number, graph: number): number;

/**
 * The debug buffer's byte offset in memory (`debug` family, `DEBUG_BYTES` long).
 */
export function debug_ptr(): number;

/**
 * Writes an instance's debug report into the debug buffer; returns its byte length (0 unless the
 * instance is flagged for debugging).
 */
export function debug_write(handle: number): number;

/**
 * Destroys an instance; returns a status.
 */
export function destroy_instance(handle: number): number;

/**
 * Evaluates a World's instances in a pass; returns the state-change records waiting.
 */
export function evaluate(world: number, pass: number, dt_scaled: number, dt_unscaled: number): number;

/**
 * Binds a graph's string id to a clip or mask handle (0 unbinds); returns a status.
 */
export function graph_bind(graph: number, string_id: number, asset: number): number;

/**
 * The number of graph state-change records waiting (since the last `write_inputs`).
 */
export function graph_change_count(): number;

/**
 * The graph state-change records' byte offset in memory.
 */
export function graph_changes_ptr(): number;

/**
 * Guesses a profile's bone map for a skeleton file; returns the role count (0: see `last_status`).
 */
export function guess_bone_map(skeleton: Uint8Array | number[], profile: number, bones: Uint16Array, confidence: Float32Array): number;

/**
 * Reads an `INIT` record and returns a `MEMORY_NEEDED` record (both `anim-wire` family `core`);
 * on `STATUS_OK` the core restarts with those limits. Never throws: a malformed record is
 * answered with `STATUS_BAD_RECORD`.
 */
export function init(record: Uint8Array | number[]): Uint8Array;

/**
 * The input view's byte offset in memory.
 */
export function inputs_ptr(): number;

/**
 * Why the last call returning a handle returned 0 (`STATUS_*`).
 */
export function last_status(): number;

/**
 * Loads a `myco.anim@1` file (copied in); returns its handle, or 0.
 */
export function load_clip(bytes: Uint8Array | number[]): number;

/**
 * Loads a `myco.animgraph@1` file (copied in); returns its handle, or 0.
 */
export function load_graph(bytes: Uint8Array | number[]): number;

/**
 * Loads a bone mask (one weight per bone); returns its handle, or 0.
 */
export function load_mask(weights: Float32Array | number[]): number;

/**
 * Loads a `myco.skel@1` file (copied in); returns its handle, or 0 (see `last_status`).
 */
export function load_skeleton(bytes: Uint8Array | number[]): number;

/**
 * The bone-matrix view's byte offset in memory.
 */
export function matrices_ptr(): number;

/**
 * Gives an instance a physics row; returns its index or `NONE` (see `last_status`).
 */
export function physics_attach(instance: number, ragdoll: number): number;

/**
 * Get-up: the physical pose into a pose-snapshot node; returns a status.
 */
export function physics_capture(instance: number, physical_node: number, snapshot_node: number): number;

/**
 * Sizes the physics rows and views; returns a status.
 */
export function physics_configure(max_rows: number): number;

/**
 * Frees an instance's physics row; returns a status.
 */
export function physics_detach(instance: number): number;

/**
 * After the fixed evaluate: the drive targets into the output view. Returns rows written.
 */
export function physics_drive(world: number): number;

/**
 * The byte offset of the physics input view.
 */
export function physics_in_ptr(): number;

/**
 * The input view's bytes per row.
 */
export function physics_in_row_bytes(): number;

/**
 * The byte offset of the physics output view.
 */
export function physics_out_ptr(): number;

/**
 * The output view's bytes per row.
 */
export function physics_out_row_bytes(): number;

/**
 * After the physics step: the simulated bodies into the physical-pose nodes. Returns rows applied.
 */
export function physics_read(world: number): number;

/**
 * Decodes a custom skeleton profile; returns its handle, or 0 (see `last_status`).
 */
export function profile_decode(bytes: Uint8Array | number[]): number;

/**
 * The default ragdoll description of a skeleton file (empty: see `last_status`).
 */
export function ragdoll_build(skeleton: Uint8Array | number[], profile: number): Uint8Array;

/**
 * Creates a ragdoll description asset for a skeleton; its handle, or 0 (see `last_status`).
 */
export function ragdoll_create(skeleton: number, bytes: Uint8Array | number[]): number;

/**
 * Releases an asset; returns a status.
 */
export function release(handle: number): number;

/**
 * Restores an instance from a snapshot; returns a status.
 */
export function restore(handle: number, bytes: Uint8Array | number[]): number;

/**
 * Bakes a clip through a retarget map into a raw clip (empty: see `last_status`).
 */
export function retarget_bake(map: number, clip: Uint8Array | number[], root_axes: number, ik_weights: Float32Array | number[]): Uint8Array;

/**
 * The IK goals of a retarget map.
 */
export function retarget_goal_count(map: number): number;

/**
 * Creates a retarget map asset; returns its handle, or 0 (see `last_status`).
 */
export function retarget_map_create(src_skeleton: number, src_profile: number, src_map: Uint16Array | number[], tgt_skeleton: number, tgt_profile: number, tgt_map: Uint16Array | number[], flags: number): number;

/**
 * Writes the `MIRROR` node's bone words for a skeleton file; returns the bone count (0: failure).
 */
export function retarget_mirror_table(skeleton: Uint8Array | number[], profile: number, map: Uint16Array | number[], out: Uint32Array): number;

/**
 * The rig input view's byte offset in memory (`rig` family, `RIG_INPUT_STRIDE` bytes per
 * instance index; T40).
 */
export function rig_inputs_ptr(): number;

/**
 * The ray output view's byte offset in memory (`rig` family, `RAY_ROW_STRIDE` bytes per instance
 * index; T40).
 */
export function rig_rays_ptr(): number;

/**
 * The root-motion view's byte offset in memory.
 */
export function roots_ptr(): number;

/**
 * Writes an instance's snapshot into `out`; returns a status.
 */
export function snapshot(handle: number, out: Uint8Array): number;

/**
 * The byte length of an instance's snapshot (0 for a stale handle).
 */
export function snapshot_bytes(handle: number): number;

/**
 * The source hash the module was built from, as 32 lowercase hex digits.
 */
export function source_hash(): string;

/**
 * Timeline instances evaluated this frame.
 */
export function timeline_active_count(): number;

/**
 * The byte offset of the evaluated instances' handles (`u32` each).
 */
export function timeline_active_ptr(): number;

/**
 * Binds a subclip string id of `owner`'s string table to a clip handle; returns a status. The
 * instance's outputs may move: read `timeline_info` after binding.
 */
export function timeline_bind(instance: number, owner: number, string_id: number, asset: number): number;

/**
 * Bytes of an instance's `TIMELINE_BLOCK` records.
 */
export function timeline_block_bytes(instance: number): number;

/**
 * Writes an instance's `TIMELINE_BLOCK` records into `out`; returns the bytes written.
 */
export function timeline_blocks(instance: number, out: Uint8Array): number;

/**
 * `TIMELINE_CHANGE` records this frame.
 */
export function timeline_changes_count(): number;

/**
 * Timeline changes dropped this frame because the buffer was full.
 */
export function timeline_changes_dropped(): number;

/**
 * The byte offset of the timeline change records.
 */
export function timeline_changes_ptr(): number;

/**
 * Applies a `TIMELINE_CONTROL` record; returns a status.
 */
export function timeline_control(record: Uint8Array | number[]): number;

/**
 * Creates an instance of a clip used as a timeline (`TIMELINE_CREATE`); returns its handle or 0.
 */
export function timeline_create(record: Uint8Array | number[]): number;

/**
 * Creates a sequence (`SEQ_CREATE` then its `SEQ_MEMBER` records); returns its handle or 0.
 */
export function timeline_create_sequence(bytes: Uint8Array | number[]): number;

/**
 * Writes an instance's `TIMELINE_INFO` into `out`; returns the bytes written (0: stale or short).
 */
export function timeline_info(instance: number, out: Uint8Array): number;

/**
 * How many `tracks` records the timelines wrote this frame.
 */
export function timeline_records_count(): number;

/**
 * How many `tracks` records did not fit this frame.
 */
export function timeline_records_dropped(): number;

/**
 * Bytes of `tracks` records the timelines wrote this frame.
 */
export function timeline_records_len(): number;

/**
 * The byte offset of the timelines' `tracks` records.
 */
export function timeline_records_ptr(): number;

/**
 * The byte offset of the timeline value words.
 */
export function timeline_values_ptr(): number;

/**
 * The byte offset of the timeline block weights (`f32` each).
 */
export function timeline_weights_ptr(): number;

/**
 * Resizes the timeline table and the frame record buffer; drops every instance. Returns a status.
 */
export function timelines_configure(max_timelines: number, record_bytes: number): number;

/**
 * The track regions' byte offset in memory (`TRACK_STRIDE` bytes per instance index).
 */
export function tracks_ptr(): number;

/**
 * `TWEEN_CHANGE` records this frame.
 */
export function tween_changes_count(): number;

/**
 * Tween changes dropped this frame because the buffer was full.
 */
export function tween_changes_dropped(): number;

/**
 * The byte offset of the tween change records.
 */
export function tween_changes_ptr(): number;

/**
 * The byte offset of the tween rows' column ids (`u32` each).
 */
export function tween_columns_ptr(): number;

/**
 * Applies a `TWEEN_CONTROL` record (pause, resume, kill, destroyed); returns a status.
 */
export function tween_control(record: Uint8Array | number[]): number;

/**
 * Creates a tween from a `TWEEN_CREATE` record; returns its handle, or 0 (see `last_status`).
 */
export function tween_create(record: Uint8Array | number[]): number;

/**
 * Tween output rows this frame.
 */
export function tween_values_count(): number;

/**
 * The byte offset of the tween rows' values (four `f32` each).
 */
export function tween_values_ptr(): number;

/**
 * Resizes the tween table (`DEFAULT_MAX_TWEENS` by default); drops every tween. Returns a status.
 */
export function tweens_configure(max_tweens: number): number;

/**
 * Applies the first `len` bytes of the command buffer; returns the commands applied.
 */
export function write_inputs(len: number): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly asset_bytes_ptr: (a: number) => number;
    readonly blackboard_ptr: () => number;
    readonly changes_dropped: () => number;
    readonly changes_ptr: () => number;
    readonly clip_column_bytes: (a: number) => number;
    readonly clip_columns: (a: number, b: number, c: number, d: any) => number;
    readonly commands_ptr: () => number;
    readonly create_instance: (a: number, b: number, c: number) => number;
    readonly debug_ptr: () => number;
    readonly debug_write: (a: number) => number;
    readonly destroy_instance: (a: number) => number;
    readonly evaluate: (a: number, b: number, c: number, d: number) => number;
    readonly graph_bind: (a: number, b: number, c: number) => number;
    readonly graph_change_count: () => number;
    readonly graph_changes_ptr: () => number;
    readonly guess_bone_map: (a: number, b: number, c: number, d: number, e: number, f: any, g: number, h: number, i: any) => number;
    readonly init: (a: number, b: number) => [number, number];
    readonly inputs_ptr: () => number;
    readonly last_status: () => number;
    readonly load_clip: (a: number, b: number) => number;
    readonly load_graph: (a: number, b: number) => number;
    readonly load_mask: (a: number, b: number) => number;
    readonly load_skeleton: (a: number, b: number) => number;
    readonly matrices_ptr: () => number;
    readonly physics_attach: (a: number, b: number) => number;
    readonly physics_capture: (a: number, b: number, c: number) => number;
    readonly physics_configure: (a: number) => number;
    readonly physics_detach: (a: number) => number;
    readonly physics_drive: (a: number) => number;
    readonly physics_in_ptr: () => number;
    readonly physics_in_row_bytes: () => number;
    readonly physics_out_ptr: () => number;
    readonly physics_out_row_bytes: () => number;
    readonly physics_read: (a: number) => number;
    readonly profile_decode: (a: number, b: number) => number;
    readonly ragdoll_build: (a: number, b: number, c: number) => [number, number];
    readonly ragdoll_create: (a: number, b: number, c: number) => number;
    readonly release: (a: number) => number;
    readonly restore: (a: number, b: number, c: number) => number;
    readonly retarget_bake: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly retarget_goal_count: (a: number) => number;
    readonly retarget_map_create: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly retarget_mirror_table: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: any) => number;
    readonly rig_inputs_ptr: () => number;
    readonly rig_rays_ptr: () => number;
    readonly roots_ptr: () => number;
    readonly snapshot: (a: number, b: number, c: number, d: any) => number;
    readonly snapshot_bytes: (a: number) => number;
    readonly source_hash: () => [number, number];
    readonly timeline_active_count: () => number;
    readonly timeline_active_ptr: () => number;
    readonly timeline_bind: (a: number, b: number, c: number, d: number) => number;
    readonly timeline_block_bytes: (a: number) => number;
    readonly timeline_blocks: (a: number, b: number, c: number, d: any) => number;
    readonly timeline_changes_count: () => number;
    readonly timeline_changes_dropped: () => number;
    readonly timeline_changes_ptr: () => number;
    readonly timeline_control: (a: number, b: number) => number;
    readonly timeline_create: (a: number, b: number) => number;
    readonly timeline_create_sequence: (a: number, b: number) => number;
    readonly timeline_info: (a: number, b: number, c: number, d: any) => number;
    readonly timeline_records_count: () => number;
    readonly timeline_records_dropped: () => number;
    readonly timeline_records_len: () => number;
    readonly timeline_records_ptr: () => number;
    readonly timeline_values_ptr: () => number;
    readonly timeline_weights_ptr: () => number;
    readonly timelines_configure: (a: number, b: number) => number;
    readonly tracks_ptr: () => number;
    readonly tween_changes_count: () => number;
    readonly tween_changes_dropped: () => number;
    readonly tween_changes_ptr: () => number;
    readonly tween_columns_ptr: () => number;
    readonly tween_control: (a: number, b: number) => number;
    readonly tween_create: (a: number, b: number) => number;
    readonly tween_values_count: () => number;
    readonly tween_values_ptr: () => number;
    readonly tweens_configure: (a: number) => number;
    readonly write_inputs: (a: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
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
