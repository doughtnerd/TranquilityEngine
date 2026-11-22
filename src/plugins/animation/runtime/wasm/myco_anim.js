/* @ts-self-types="./myco_anim.d.ts" */

/**
 * The byte offset of a clip's or graph's file bytes in memory (0 for none).
 * @param {number} handle
 * @returns {number}
 */
export function asset_bytes_ptr(handle) {
    const ret = wasm.asset_bytes_ptr(handle);
    return ret >>> 0;
}

/**
 * The blackboard view's byte offset in memory (`graph` family, `BLACKBOARD_STRIDE` bytes per
 * instance index).
 * @returns {number}
 */
export function blackboard_ptr() {
    const ret = wasm.blackboard_ptr();
    return ret >>> 0;
}

/**
 * State changes dropped this frame because the buffer was full.
 * @returns {number}
 */
export function changes_dropped() {
    const ret = wasm.changes_dropped();
    return ret >>> 0;
}

/**
 * The state-change records' byte offset in memory.
 * @returns {number}
 */
export function changes_ptr() {
    const ret = wasm.changes_ptr();
    return ret >>> 0;
}

/**
 * Bytes of a clip's `COLUMN` records.
 * @param {number} clip
 * @returns {number}
 */
export function clip_column_bytes(clip) {
    const ret = wasm.clip_column_bytes(clip);
    return ret >>> 0;
}

/**
 * Writes a clip's `COLUMN` records into `out`; returns the bytes written.
 * @param {number} clip
 * @param {Uint8Array} out
 * @returns {number}
 */
export function clip_columns(clip, out) {
    const val2 = +clip;
    var ptr0 = passArray8ToWasm0(out, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    const ret = wasm.clip_columns(val2, ptr0, len0, out);
    return ret >>> 0;
}

/**
 * The command buffer's byte offset in memory (`COMMAND_BYTES` long).
 * @returns {number}
 */
export function commands_ptr() {
    const ret = wasm.commands_ptr();
    return ret >>> 0;
}

/**
 * Creates an instance; returns its handle, or 0.
 * @param {number} world
 * @param {number} skeleton
 * @param {number} graph
 * @returns {number}
 */
export function create_instance(world, skeleton, graph) {
    const ret = wasm.create_instance(world, skeleton, graph);
    return ret >>> 0;
}

/**
 * The debug buffer's byte offset in memory (`debug` family, `DEBUG_BYTES` long).
 * @returns {number}
 */
export function debug_ptr() {
    const ret = wasm.debug_ptr();
    return ret >>> 0;
}

/**
 * Writes an instance's debug report into the debug buffer; returns its byte length (0 unless the
 * instance is flagged for debugging).
 * @param {number} handle
 * @returns {number}
 */
export function debug_write(handle) {
    const ret = wasm.debug_write(handle);
    return ret >>> 0;
}

/**
 * Destroys an instance; returns a status.
 * @param {number} handle
 * @returns {number}
 */
export function destroy_instance(handle) {
    const ret = wasm.destroy_instance(handle);
    return ret >>> 0;
}

/**
 * Evaluates a World's instances in a pass; returns the state-change records waiting.
 * @param {number} world
 * @param {number} pass
 * @param {number} dt_scaled
 * @param {number} dt_unscaled
 * @returns {number}
 */
export function evaluate(world, pass, dt_scaled, dt_unscaled) {
    const ret = wasm.evaluate(world, pass, dt_scaled, dt_unscaled);
    return ret >>> 0;
}

/**
 * Binds a graph's string id to a clip or mask handle (0 unbinds); returns a status.
 * @param {number} graph
 * @param {number} string_id
 * @param {number} asset
 * @returns {number}
 */
export function graph_bind(graph, string_id, asset) {
    const ret = wasm.graph_bind(graph, string_id, asset);
    return ret >>> 0;
}

/**
 * The number of graph state-change records waiting (since the last `write_inputs`).
 * @returns {number}
 */
export function graph_change_count() {
    const ret = wasm.graph_change_count();
    return ret >>> 0;
}

/**
 * The graph state-change records' byte offset in memory.
 * @returns {number}
 */
export function graph_changes_ptr() {
    const ret = wasm.graph_changes_ptr();
    return ret >>> 0;
}

/**
 * Guesses a profile's bone map for a skeleton file; returns the role count (0: see `last_status`).
 * @param {Uint8Array | number[]} skeleton
 * @param {number} profile
 * @param {Uint16Array} bones
 * @param {Float32Array} confidence
 * @returns {number}
 */
export function guess_bone_map(skeleton, profile, bones, confidence) {
    const val4 = +profile;
    let ptr0, len0, ptr1, len1, ptr2, len2;
    try {
        ptr0 = passArray8ToWasm0(skeleton, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArray16ToWasm0(bones, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
        ptr2 = passArrayF32ToWasm0(confidence, wasm.__wbindgen_malloc);
        len2 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 4, 4); }
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 2, 2); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
        throw e;
    }
    const ret = wasm.guess_bone_map(ptr0, len0, val4, ptr1, len1, bones, ptr2, len2, confidence);
    return ret >>> 0;
}

/**
 * Reads an `INIT` record and returns a `MEMORY_NEEDED` record (both `anim-wire` family `core`);
 * on `STATUS_OK` the core restarts with those limits. Never throws: a malformed record is
 * answered with `STATUS_BAD_RECORD`.
 * @param {Uint8Array | number[]} record
 * @returns {Uint8Array}
 */
export function init(record) {
    const ptr0 = passArray8ToWasm0(record, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.init(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * The input view's byte offset in memory.
 * @returns {number}
 */
export function inputs_ptr() {
    const ret = wasm.inputs_ptr();
    return ret >>> 0;
}

/**
 * Why the last call returning a handle returned 0 (`STATUS_*`).
 * @returns {number}
 */
export function last_status() {
    const ret = wasm.last_status();
    return ret >>> 0;
}

/**
 * Loads a `myco.anim@1` file (copied in); returns its handle, or 0.
 * @param {Uint8Array | number[]} bytes
 * @returns {number}
 */
export function load_clip(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.load_clip(ptr0, len0);
    return ret >>> 0;
}

/**
 * Loads a `myco.animgraph@1` file (copied in); returns its handle, or 0.
 * @param {Uint8Array | number[]} bytes
 * @returns {number}
 */
export function load_graph(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.load_graph(ptr0, len0);
    return ret >>> 0;
}

/**
 * Loads a bone mask (one weight per bone); returns its handle, or 0.
 * @param {Float32Array | number[]} weights
 * @returns {number}
 */
export function load_mask(weights) {
    const ptr0 = passArrayF32ToWasm0(weights, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.load_mask(ptr0, len0);
    return ret >>> 0;
}

/**
 * Loads a `myco.skel@1` file (copied in); returns its handle, or 0 (see `last_status`).
 * @param {Uint8Array | number[]} bytes
 * @returns {number}
 */
export function load_skeleton(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.load_skeleton(ptr0, len0);
    return ret >>> 0;
}

/**
 * The bone-matrix view's byte offset in memory.
 * @returns {number}
 */
export function matrices_ptr() {
    const ret = wasm.matrices_ptr();
    return ret >>> 0;
}

/**
 * Gives an instance a physics row; returns its index or `NONE` (see `last_status`).
 * @param {number} instance
 * @param {number} ragdoll
 * @returns {number}
 */
export function physics_attach(instance, ragdoll) {
    const ret = wasm.physics_attach(instance, ragdoll);
    return ret >>> 0;
}

/**
 * Get-up: the physical pose into a pose-snapshot node; returns a status.
 * @param {number} instance
 * @param {number} physical_node
 * @param {number} snapshot_node
 * @returns {number}
 */
export function physics_capture(instance, physical_node, snapshot_node) {
    const ret = wasm.physics_capture(instance, physical_node, snapshot_node);
    return ret >>> 0;
}

/**
 * Sizes the physics rows and views; returns a status.
 * @param {number} max_rows
 * @returns {number}
 */
export function physics_configure(max_rows) {
    const ret = wasm.physics_configure(max_rows);
    return ret >>> 0;
}

/**
 * Frees an instance's physics row; returns a status.
 * @param {number} instance
 * @returns {number}
 */
export function physics_detach(instance) {
    const ret = wasm.physics_detach(instance);
    return ret >>> 0;
}

/**
 * After the fixed evaluate: the drive targets into the output view. Returns rows written.
 * @param {number} world
 * @returns {number}
 */
export function physics_drive(world) {
    const ret = wasm.physics_drive(world);
    return ret >>> 0;
}

/**
 * The byte offset of the physics input view.
 * @returns {number}
 */
export function physics_in_ptr() {
    const ret = wasm.physics_in_ptr();
    return ret >>> 0;
}

/**
 * The input view's bytes per row.
 * @returns {number}
 */
export function physics_in_row_bytes() {
    const ret = wasm.physics_in_row_bytes();
    return ret >>> 0;
}

/**
 * The byte offset of the physics output view.
 * @returns {number}
 */
export function physics_out_ptr() {
    const ret = wasm.physics_out_ptr();
    return ret >>> 0;
}

/**
 * The output view's bytes per row.
 * @returns {number}
 */
export function physics_out_row_bytes() {
    const ret = wasm.physics_out_row_bytes();
    return ret >>> 0;
}

/**
 * After the physics step: the simulated bodies into the physical-pose nodes. Returns rows applied.
 * @param {number} world
 * @returns {number}
 */
export function physics_read(world) {
    const ret = wasm.physics_read(world);
    return ret >>> 0;
}

/**
 * Decodes a custom skeleton profile; returns its handle, or 0 (see `last_status`).
 * @param {Uint8Array | number[]} bytes
 * @returns {number}
 */
export function profile_decode(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.profile_decode(ptr0, len0);
    return ret >>> 0;
}

/**
 * The default ragdoll description of a skeleton file (empty: see `last_status`).
 * @param {Uint8Array | number[]} skeleton
 * @param {number} profile
 * @returns {Uint8Array}
 */
export function ragdoll_build(skeleton, profile) {
    const val2 = +profile;
    const ptr0 = passArray8ToWasm0(skeleton, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ragdoll_build(ptr0, len0, val2);
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * Creates a ragdoll description asset for a skeleton; its handle, or 0 (see `last_status`).
 * @param {number} skeleton
 * @param {Uint8Array | number[]} bytes
 * @returns {number}
 */
export function ragdoll_create(skeleton, bytes) {
    const val2 = +skeleton;
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ragdoll_create(val2, ptr0, len0);
    return ret >>> 0;
}

/**
 * Releases an asset; returns a status.
 * @param {number} handle
 * @returns {number}
 */
export function release(handle) {
    const ret = wasm.release(handle);
    return ret >>> 0;
}

/**
 * Restores an instance from a snapshot; returns a status.
 * @param {number} handle
 * @param {Uint8Array | number[]} bytes
 * @returns {number}
 */
export function restore(handle, bytes) {
    const val2 = +handle;
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.restore(val2, ptr0, len0);
    return ret >>> 0;
}

/**
 * Bakes a clip through a retarget map into a raw clip (empty: see `last_status`).
 * @param {number} map
 * @param {Uint8Array | number[]} clip
 * @param {number} root_axes
 * @param {Float32Array | number[]} ik_weights
 * @returns {Uint8Array}
 */
export function retarget_bake(map, clip, root_axes, ik_weights) {
    const val3 = +map;
    const val4 = +root_axes;
    let ptr0, len0, ptr1, len1;
    try {
        ptr0 = passArray8ToWasm0(clip, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArrayF32ToWasm0(ik_weights, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 4, 4); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
        throw e;
    }
    const ret = wasm.retarget_bake(val3, ptr0, len0, val4, ptr1, len1);
    var v5 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v5;
}

/**
 * The IK goals of a retarget map.
 * @param {number} map
 * @returns {number}
 */
export function retarget_goal_count(map) {
    const ret = wasm.retarget_goal_count(map);
    return ret >>> 0;
}

/**
 * Creates a retarget map asset; returns its handle, or 0 (see `last_status`).
 * @param {number} src_skeleton
 * @param {number} src_profile
 * @param {Uint16Array | number[]} src_map
 * @param {number} tgt_skeleton
 * @param {number} tgt_profile
 * @param {Uint16Array | number[]} tgt_map
 * @param {number} flags
 * @returns {number}
 */
export function retarget_map_create(src_skeleton, src_profile, src_map, tgt_skeleton, tgt_profile, tgt_map, flags) {
    const val3 = +src_skeleton;
    const val4 = +src_profile;
    const val5 = +tgt_skeleton;
    const val6 = +tgt_profile;
    const val7 = +flags;
    let ptr0, len0, ptr1, len1;
    try {
        ptr0 = passArray16ToWasm0(src_map, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArray16ToWasm0(tgt_map, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 2, 2); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 2, 2); }
        throw e;
    }
    const ret = wasm.retarget_map_create(val3, val4, ptr0, len0, val5, val6, ptr1, len1, val7);
    return ret >>> 0;
}

/**
 * Writes the `MIRROR` node's bone words for a skeleton file; returns the bone count (0: failure).
 * @param {Uint8Array | number[]} skeleton
 * @param {number} profile
 * @param {Uint16Array | number[]} map
 * @param {Uint32Array} out
 * @returns {number}
 */
export function retarget_mirror_table(skeleton, profile, map, out) {
    const val4 = +profile;
    let ptr0, len0, ptr1, len1, ptr2, len2;
    try {
        ptr0 = passArray8ToWasm0(skeleton, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArray16ToWasm0(map, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
        ptr2 = passArray32ToWasm0(out, wasm.__wbindgen_malloc);
        len2 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 4, 4); }
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 2, 2); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
        throw e;
    }
    const ret = wasm.retarget_mirror_table(ptr0, len0, val4, ptr1, len1, ptr2, len2, out);
    return ret >>> 0;
}

/**
 * The rig input view's byte offset in memory (`rig` family, `RIG_INPUT_STRIDE` bytes per
 * instance index; T40).
 * @returns {number}
 */
export function rig_inputs_ptr() {
    const ret = wasm.rig_inputs_ptr();
    return ret >>> 0;
}

/**
 * The ray output view's byte offset in memory (`rig` family, `RAY_ROW_STRIDE` bytes per instance
 * index; T40).
 * @returns {number}
 */
export function rig_rays_ptr() {
    const ret = wasm.rig_rays_ptr();
    return ret >>> 0;
}

/**
 * The root-motion view's byte offset in memory.
 * @returns {number}
 */
export function roots_ptr() {
    const ret = wasm.roots_ptr();
    return ret >>> 0;
}

/**
 * Writes an instance's snapshot into `out`; returns a status.
 * @param {number} handle
 * @param {Uint8Array} out
 * @returns {number}
 */
export function snapshot(handle, out) {
    const val2 = +handle;
    var ptr0 = passArray8ToWasm0(out, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    const ret = wasm.snapshot(val2, ptr0, len0, out);
    return ret >>> 0;
}

/**
 * The byte length of an instance's snapshot (0 for a stale handle).
 * @param {number} handle
 * @returns {number}
 */
export function snapshot_bytes(handle) {
    const ret = wasm.snapshot_bytes(handle);
    return ret >>> 0;
}

/**
 * The source hash the module was built from, as 32 lowercase hex digits.
 * @returns {string}
 */
export function source_hash() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.source_hash();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Timeline instances evaluated this frame.
 * @returns {number}
 */
export function timeline_active_count() {
    const ret = wasm.timeline_active_count();
    return ret >>> 0;
}

/**
 * The byte offset of the evaluated instances' handles (`u32` each).
 * @returns {number}
 */
export function timeline_active_ptr() {
    const ret = wasm.timeline_active_ptr();
    return ret >>> 0;
}

/**
 * Binds a subclip string id of `owner`'s string table to a clip handle; returns a status. The
 * instance's outputs may move: read `timeline_info` after binding.
 * @param {number} instance
 * @param {number} owner
 * @param {number} string_id
 * @param {number} asset
 * @returns {number}
 */
export function timeline_bind(instance, owner, string_id, asset) {
    const ret = wasm.timeline_bind(instance, owner, string_id, asset);
    return ret >>> 0;
}

/**
 * Bytes of an instance's `TIMELINE_BLOCK` records.
 * @param {number} instance
 * @returns {number}
 */
export function timeline_block_bytes(instance) {
    const ret = wasm.timeline_block_bytes(instance);
    return ret >>> 0;
}

/**
 * Writes an instance's `TIMELINE_BLOCK` records into `out`; returns the bytes written.
 * @param {number} instance
 * @param {Uint8Array} out
 * @returns {number}
 */
export function timeline_blocks(instance, out) {
    const val2 = +instance;
    var ptr0 = passArray8ToWasm0(out, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    const ret = wasm.timeline_blocks(val2, ptr0, len0, out);
    return ret >>> 0;
}

/**
 * `TIMELINE_CHANGE` records this frame.
 * @returns {number}
 */
export function timeline_changes_count() {
    const ret = wasm.timeline_changes_count();
    return ret >>> 0;
}

/**
 * Timeline changes dropped this frame because the buffer was full.
 * @returns {number}
 */
export function timeline_changes_dropped() {
    const ret = wasm.timeline_changes_dropped();
    return ret >>> 0;
}

/**
 * The byte offset of the timeline change records.
 * @returns {number}
 */
export function timeline_changes_ptr() {
    const ret = wasm.timeline_changes_ptr();
    return ret >>> 0;
}

/**
 * Applies a `TIMELINE_CONTROL` record; returns a status.
 * @param {Uint8Array | number[]} record
 * @returns {number}
 */
export function timeline_control(record) {
    const ptr0 = passArray8ToWasm0(record, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.timeline_control(ptr0, len0);
    return ret >>> 0;
}

/**
 * Creates an instance of a clip used as a timeline (`TIMELINE_CREATE`); returns its handle or 0.
 * @param {Uint8Array | number[]} record
 * @returns {number}
 */
export function timeline_create(record) {
    const ptr0 = passArray8ToWasm0(record, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.timeline_create(ptr0, len0);
    return ret >>> 0;
}

/**
 * Creates a sequence (`SEQ_CREATE` then its `SEQ_MEMBER` records); returns its handle or 0.
 * @param {Uint8Array | number[]} bytes
 * @returns {number}
 */
export function timeline_create_sequence(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.timeline_create_sequence(ptr0, len0);
    return ret >>> 0;
}

/**
 * Writes an instance's `TIMELINE_INFO` into `out`; returns the bytes written (0: stale or short).
 * @param {number} instance
 * @param {Uint8Array} out
 * @returns {number}
 */
export function timeline_info(instance, out) {
    const val2 = +instance;
    var ptr0 = passArray8ToWasm0(out, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    const ret = wasm.timeline_info(val2, ptr0, len0, out);
    return ret >>> 0;
}

/**
 * How many `tracks` records the timelines wrote this frame.
 * @returns {number}
 */
export function timeline_records_count() {
    const ret = wasm.timeline_records_count();
    return ret >>> 0;
}

/**
 * How many `tracks` records did not fit this frame.
 * @returns {number}
 */
export function timeline_records_dropped() {
    const ret = wasm.timeline_records_dropped();
    return ret >>> 0;
}

/**
 * Bytes of `tracks` records the timelines wrote this frame.
 * @returns {number}
 */
export function timeline_records_len() {
    const ret = wasm.timeline_records_len();
    return ret >>> 0;
}

/**
 * The byte offset of the timelines' `tracks` records.
 * @returns {number}
 */
export function timeline_records_ptr() {
    const ret = wasm.timeline_records_ptr();
    return ret >>> 0;
}

/**
 * The byte offset of the timeline value words.
 * @returns {number}
 */
export function timeline_values_ptr() {
    const ret = wasm.timeline_values_ptr();
    return ret >>> 0;
}

/**
 * The byte offset of the timeline block weights (`f32` each).
 * @returns {number}
 */
export function timeline_weights_ptr() {
    const ret = wasm.timeline_weights_ptr();
    return ret >>> 0;
}

/**
 * Resizes the timeline table and the frame record buffer; drops every instance. Returns a status.
 * @param {number} max_timelines
 * @param {number} record_bytes
 * @returns {number}
 */
export function timelines_configure(max_timelines, record_bytes) {
    const ret = wasm.timelines_configure(max_timelines, record_bytes);
    return ret >>> 0;
}

/**
 * The track regions' byte offset in memory (`TRACK_STRIDE` bytes per instance index).
 * @returns {number}
 */
export function tracks_ptr() {
    const ret = wasm.tracks_ptr();
    return ret >>> 0;
}

/**
 * `TWEEN_CHANGE` records this frame.
 * @returns {number}
 */
export function tween_changes_count() {
    const ret = wasm.tween_changes_count();
    return ret >>> 0;
}

/**
 * Tween changes dropped this frame because the buffer was full.
 * @returns {number}
 */
export function tween_changes_dropped() {
    const ret = wasm.tween_changes_dropped();
    return ret >>> 0;
}

/**
 * The byte offset of the tween change records.
 * @returns {number}
 */
export function tween_changes_ptr() {
    const ret = wasm.tween_changes_ptr();
    return ret >>> 0;
}

/**
 * The byte offset of the tween rows' column ids (`u32` each).
 * @returns {number}
 */
export function tween_columns_ptr() {
    const ret = wasm.tween_columns_ptr();
    return ret >>> 0;
}

/**
 * Applies a `TWEEN_CONTROL` record (pause, resume, kill, destroyed); returns a status.
 * @param {Uint8Array | number[]} record
 * @returns {number}
 */
export function tween_control(record) {
    const ptr0 = passArray8ToWasm0(record, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.tween_control(ptr0, len0);
    return ret >>> 0;
}

/**
 * Creates a tween from a `TWEEN_CREATE` record; returns its handle, or 0 (see `last_status`).
 * @param {Uint8Array | number[]} record
 * @returns {number}
 */
export function tween_create(record) {
    const ptr0 = passArray8ToWasm0(record, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.tween_create(ptr0, len0);
    return ret >>> 0;
}

/**
 * Tween output rows this frame.
 * @returns {number}
 */
export function tween_values_count() {
    const ret = wasm.tween_values_count();
    return ret >>> 0;
}

/**
 * The byte offset of the tween rows' values (four `f32` each).
 * @returns {number}
 */
export function tween_values_ptr() {
    const ret = wasm.tween_values_ptr();
    return ret >>> 0;
}

/**
 * Resizes the tween table (`DEFAULT_MAX_TWEENS` by default); drops every tween. Returns a status.
 * @param {number} max_tweens
 * @returns {number}
 */
export function tweens_configure(max_tweens) {
    const ret = wasm.tweens_configure(max_tweens);
    return ret >>> 0;
}

/**
 * Applies the first `len` bytes of the command buffer; returns the commands applied.
 * @param {number} len
 * @returns {number}
 */
export function write_inputs(len) {
    const ret = wasm.write_inputs(len);
    return ret >>> 0;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_copy_to_typed_array_680b191e71920dc1: function(arg0, arg1, arg2) {
            new Uint8Array(arg2.buffer, arg2.byteOffset, arg2.byteLength).set(getArrayU8FromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            table.set(0, undefined);
            table.set(1024, undefined);
            table.set(1025, null);
            table.set(1026, true);
            table.set(1027, false);
        },
    };
    return {
        __proto__: null,
        "./myco_anim_bg.js": import0,
    };
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let cachedUint16ArrayMemory0 = null;
function getUint16ArrayMemory0() {
    if (cachedUint16ArrayMemory0 === null || cachedUint16ArrayMemory0.byteLength === 0) {
        cachedUint16ArrayMemory0 = new Uint16Array(wasm.memory.buffer);
    }
    return cachedUint16ArrayMemory0;
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray16ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 2, 2) >>> 0;
    getUint16ArrayMemory0().set(arg, ptr / 2);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(bytes) {
    numBytesDecoded += bytes.length;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
        cachedTextDecoder.decode();
        numBytesDecoded = bytes.length;
    }
    return cachedTextDecoder.decode(bytes);
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedUint16ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

let __wbg_init_promise;
async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;
    if (__wbg_init_promise === undefined) {
        __wbg_init_promise = __wbg_init_once(module_or_path);
        __wbg_init_promise.catch(() => { __wbg_init_promise = undefined; });
    }
    return __wbg_init_promise;
}

async function __wbg_init_once(module_or_path) {

    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }


    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
