/* @ts-self-types="./myco_nav.d.ts" */

/**
 * A chunk's baker (see the module doc).
 */
export class NavBaker {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        NavBakerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_navbaker_free(ptr, 0);
    }
    /**
     * Bakes the chunk; returns its `myco.nav@1` bytes.
     * @param {string} input_json
     * @param {Float32Array | number[]} positions
     * @param {Uint32Array | number[]} indices
     * @param {string} mesh_table_json
     * @returns {Uint8Array}
     */
    bakeChunk(input_json, positions, indices, mesh_table_json) {
        let ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3;
        try {
            ptr0 = passStringToWasm0(input_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
            len1 = WASM_VECTOR_LEN;
            ptr2 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
            len2 = WASM_VECTOR_LEN;
            ptr3 = passStringToWasm0(mesh_table_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len3 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr3) { wasm.__wbindgen_free(ptr3, len3 * 1, 1); }
            if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 4, 4); }
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 4, 4); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.navbaker_bakeChunk(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v5 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v5;
    }
    /**
     * Drops the caches (the next bake is a full one).
     */
    clearCaches() {
        wasm.navbaker_clearCaches(this.__wbg_ptr);
    }
    /**
     * The last bake's report as JSON (empty before the first bake).
     * @returns {string}
     */
    lastBakeReport() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.navbaker_lastBakeReport(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    constructor() {
        const ret = wasm.navbaker_new();
        this.__wbg_ptr = ret;
        NavBakerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) NavBaker.prototype[Symbol.dispose] = NavBaker.prototype.free;

/**
 * A World's navigation runtime (see the module doc and `runtime.ts`).
 */
export class NavRuntime {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        NavRuntimeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_navruntime_free(ptr, 0);
    }
    /**
     * Queues an agent (live from the next tick); returns its handle. `desc_json`: `AgentDescDto`.
     * @param {string} desc_json
     * @returns {number}
     */
    addAgent(desc_json) {
        const ptr0 = passStringToWasm0(desc_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.navruntime_addAgent(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * Queues an avoidance obstacle at a position; returns its handle (its row in the obstacle buffer).
     * @param {string} desc_json
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {number}
     */
    addObstacle(desc_json, x, y, z) {
        const val2 = +x;
        const val3 = +y;
        const val4 = +z;
        const ptr0 = passStringToWasm0(desc_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.navruntime_addObstacle(this.__wbg_ptr, ptr0, len0, val2, val3, val4);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * Rows in the agent buffers (agent slots ever made).
     * @returns {number}
     */
    agentRows() {
        const ret = wasm.navruntime_agentRows(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    agentStatePtr() {
        const ret = wasm.navruntime_agentStatePtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * `[kind, pathState, mode, flags, position xyz, rotation xyzw, up xyz, velocity xyz, desired xyz, remaining,
     * chunk entry]` (22), or empty for a stale or not yet live handle.
     * @param {number} agent_handle
     * @returns {Float32Array}
     */
    agentState(agent_handle) {
        const ret = wasm.navruntime_agentState(this.__wbg_ptr, agent_handle);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Byte offsets of the boundary buffers in `memory()` (see `nav_crowd::boundary`); they move when `epoch` changes.
     * @returns {number}
     */
    agentsInPtr() {
        const ret = wasm.navruntime_agentsInPtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    agentsOutPtr() {
        const ret = wasm.navruntime_agentsOutPtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Chases another agent; `repath_distance` 0 = the default.
     * @param {number} agent_handle
     * @param {number} target_agent
     * @param {number} repath_distance
     */
    chaseAgent(agent_handle, target_agent, repath_distance) {
        wasm.navruntime_chaseAgent(this.__wbg_ptr, agent_handle, target_agent, repath_distance);
    }
    /**
     * Chases a host target (positions from `setTargetPositions`).
     * @param {number} agent_handle
     * @param {number} target_id
     * @param {number} repath_distance
     */
    chaseTarget(agent_handle, target_id, repath_distance) {
        wasm.navruntime_chaseTarget(this.__wbg_ptr, agent_handle, target_id, repath_distance);
    }
    /**
     * @param {number} agent_handle
     */
    clearAreaCosts(agent_handle) {
        wasm.navruntime_clearAreaCosts(this.__wbg_ptr, agent_handle);
    }
    /**
     * Every live agent's current path as segments: stride 7 (a xyz, b xyz, agent row).
     * @returns {Float32Array}
     */
    debugAgentPaths() {
        const ret = wasm.navruntime_debugAgentPaths(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * A loaded chunk's landing links for an agent type: stride 6 (ground xyz, air xyz).
     * @param {string} chunk_id
     * @param {string} agent_type
     * @returns {Float32Array}
     */
    debugLandingLinks(chunk_id, agent_type) {
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passStringToWasm0(chunk_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(agent_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.navruntime_debugLandingLinks(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        var v3 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v3;
    }
    /**
     * A loaded chunk's navmesh for an agent type: segments, stride 7 (see `debug.rs`).
     * @param {string} chunk_id
     * @param {string} agent_type
     * @returns {Float32Array}
     */
    debugNavmeshLines(chunk_id, agent_type) {
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passStringToWasm0(chunk_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(agent_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.navruntime_debugNavmeshLines(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        var v3 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v3;
    }
    /**
     * A loaded chunk's navmesh polygons as triangles, stride 11 (a, b, c, bin, area).
     * @param {string} chunk_id
     * @param {string} agent_type
     * @returns {Float32Array}
     */
    debugNavmeshTriangles(chunk_id, agent_type) {
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passStringToWasm0(chunk_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(agent_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.navruntime_debugNavmeshTriangles(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        var v3 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v3;
    }
    /**
     * The live seams' links: stride 7.
     * @returns {Float32Array}
     */
    debugSeams() {
        const ret = wasm.navruntime_debugSeams(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * A loaded chunk's flight leaves for an agent type: stride 5 (min xyz, size, area).
     * @param {string} chunk_id
     * @param {string} agent_type
     * @returns {Float32Array}
     */
    debugVolumeLeaves(chunk_id, agent_type) {
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passStringToWasm0(chunk_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(agent_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.navruntime_debugVolumeLeaves(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        var v3 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v3;
    }
    /**
     * Log lines since the last drain (JSON array of strings).
     * @returns {string}
     */
    drainLogs() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.navruntime_drainLogs(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Warnings since the last drain (JSON array of strings).
     * @returns {string}
     */
    drainWarnings() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.navruntime_drainWarnings(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Changes whenever the buffers were reallocated (views must be rebuilt).
     * @returns {number}
     */
    epoch() {
        const ret = wasm.navruntime_epoch(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * `[status, (x, y, z, nx, ny, nz, flags)...]`: status 0 full path, 1 partial, 2 none. Flags: waypoint flag bits,
     * 0x80 on flight points.
     * @param {string} agent_type
     * @param {number} fx
     * @param {number} fy
     * @param {number} fz
     * @param {number} tx
     * @param {number} ty
     * @param {number} tz
     * @returns {Float32Array}
     */
    findPath(agent_type, fx, fy, fz, tx, ty, tz) {
        const val2 = +fx;
        const val3 = +fy;
        const val4 = +fz;
        const val5 = +tx;
        const val6 = +ty;
        const val7 = +tz;
        const ptr0 = passStringToWasm0(agent_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.navruntime_findPath(this.__wbg_ptr, ptr0, len0, val2, val3, val4, val5, val6, val7);
        var v8 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v8;
    }
    /**
     * @param {number} agent_handle
     * @returns {boolean}
     */
    isLive(agent_handle) {
        const ret = wasm.navruntime_isLive(this.__wbg_ptr, agent_handle);
        return ret !== 0;
    }
    /**
     * True if a full path exists.
     * @param {string} agent_type
     * @param {number} fx
     * @param {number} fy
     * @param {number} fz
     * @param {number} tx
     * @param {number} ty
     * @param {number} tz
     * @returns {boolean}
     */
    isReachable(agent_type, fx, fy, fz, tx, ty, tz) {
        const val2 = +fx;
        const val3 = +fy;
        const val4 = +fz;
        const val5 = +tx;
        const val6 = +ty;
        const val7 = +tz;
        const ptr0 = passStringToWasm0(agent_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.navruntime_isReachable(this.__wbg_ptr, ptr0, len0, val2, val3, val4, val5, val6, val7);
        return ret !== 0;
    }
    /**
     * @param {number} agent_handle
     * @param {number} group_handle
     */
    joinGroup(agent_handle, group_handle) {
        wasm.navruntime_joinGroup(this.__wbg_ptr, agent_handle, group_handle);
    }
    /**
     * Leaves its group; with `has_goal`, walks on to (x, y, z).
     * @param {number} agent_handle
     * @param {boolean} has_goal
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    leaveGroup(agent_handle, has_goal, x, y, z) {
        wasm.navruntime_leaveGroup(this.__wbg_ptr, agent_handle, has_goal, x, y, z);
    }
    /**
     * Loads (or replaces) a chunk from its `myco.nav@1` bytes; `id` is its chunk id (hex from `chunkId`).
     * @param {string} id
     * @param {Uint8Array | number[]} bytes
     */
    loadChunk(id, bytes) {
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.navruntime_loadChunk(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * The loaded chunks' ids (hex), as a JSON array.
     * @returns {string}
     */
    loadedChunks() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.navruntime_loadedChunks(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * `[x, y, z, nx, ny, nz]` or empty.
     * @param {string} agent_type
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} max_distance
     * @returns {Float32Array}
     */
    nearestPoint(agent_type, x, y, z, max_distance) {
        const val2 = +x;
        const val3 = +y;
        const val4 = +z;
        const val5 = +max_distance;
        const ptr0 = passStringToWasm0(agent_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.navruntime_nearestPoint(this.__wbg_ptr, ptr0, len0, val2, val3, val4, val5);
        var v6 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v6;
    }
    /**
     * `settings_json`: the `navigation` project settings section (agent types, areas, runtime budgets).
     * @param {string} settings_json
     */
    constructor(settings_json) {
        const ptr0 = passStringToWasm0(settings_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.navruntime_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        NavRuntimeFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    obstacleRows() {
        const ret = wasm.navruntime_obstacleRows(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    obstaclesInPtr() {
        const ret = wasm.navruntime_obstaclesInPtr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * The agent's current path: position xyz, normal xyz, flags per waypoint (copied).
     * @param {number} agent_handle
     * @returns {Float32Array}
     */
    pathWaypoints(agent_handle) {
        const ret = wasm.navruntime_pathWaypoints(this.__wbg_ptr, agent_handle);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * `[t, reached, x, y, z, nx, ny, nz]` or empty (start off the navmesh).
     * @param {string} agent_type
     * @param {number} fx
     * @param {number} fy
     * @param {number} fz
     * @param {number} tx
     * @param {number} ty
     * @param {number} tz
     * @returns {Float32Array}
     */
    raycast(agent_type, fx, fy, fz, tx, ty, tz) {
        const val2 = +fx;
        const val3 = +fy;
        const val4 = +fz;
        const val5 = +tx;
        const val6 = +ty;
        const val7 = +tz;
        const ptr0 = passStringToWasm0(agent_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.navruntime_raycast(this.__wbg_ptr, ptr0, len0, val2, val3, val4, val5, val6, val7);
        var v8 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v8;
    }
    /**
     * @param {number} agent_handle
     */
    removeAgent(agent_handle) {
        wasm.navruntime_removeAgent(this.__wbg_ptr, agent_handle);
    }
    /**
     * @param {number} obstacle_handle
     */
    removeObstacle(obstacle_handle) {
        wasm.navruntime_removeObstacle(this.__wbg_ptr, obstacle_handle);
    }
    /**
     * @param {number} target_id
     */
    removeTarget(target_id) {
        wasm.navruntime_removeTarget(this.__wbg_ptr, target_id);
    }
    /**
     * An agent's own area cost (`cost` < 0: the area's default).
     * @param {number} agent_handle
     * @param {string} area
     * @param {number} cost
     * @param {boolean} excluded
     */
    setAreaCost(agent_handle, area, cost, excluded) {
        const val2 = +agent_handle;
        const val3 = +cost;
        const val4 = +excluded;
        const ptr0 = passStringToWasm0(area, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.navruntime_setAreaCost(this.__wbg_ptr, val2, ptr0, len0, val3, val4);
    }
    /**
     * @param {number} agent_handle
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    setDestination(agent_handle, x, y, z) {
        wasm.navruntime_setDestination(this.__wbg_ptr, agent_handle, x, y, z);
    }
    /**
     * A flow goal on a host target (`move_threshold` 0 = the default), or none with `enabled` false.
     * @param {number} target_id
     * @param {boolean} enabled
     * @param {number} move_threshold
     */
    setFlowGoal(target_id, enabled, move_threshold) {
        wasm.navruntime_setFlowGoal(this.__wbg_ptr, target_id, enabled, move_threshold);
    }
    /**
     * @param {string} gate_id
     * @param {boolean} open
     */
    setGate(gate_id, open) {
        const val2 = +open;
        const ptr0 = passStringToWasm0(gate_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.navruntime_setGate(this.__wbg_ptr, ptr0, len0, val2);
    }
    /**
     * @param {number} agent_handle
     * @param {boolean} joining
     */
    setGroupJoining(agent_handle, joining) {
        wasm.navruntime_setGroupJoining(this.__wbg_ptr, agent_handle, joining);
    }
    /**
     * A group body's painted shape: `width` x `height` bits, row 0 the front, 64 bits per word.
     * @param {number} group_handle
     * @param {BigUint64Array | bigint[]} bits
     * @param {number} width
     * @param {number} height
     */
    setGroupMask(group_handle, bits, width, height) {
        const val2 = +group_handle;
        const val3 = +width;
        const val4 = +height;
        const ptr0 = passArray64ToWasm0(bits, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.navruntime_setGroupMask(this.__wbg_ptr, val2, ptr0, len0, val3, val4);
    }
    /**
     * Replaces the agent types and runtime budgets (agents keep the settings they were added with).
     * @param {string} settings_json
     */
    setSettings(settings_json) {
        const ptr0 = passStringToWasm0(settings_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.navruntime_setSettings(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} agent_handle
     * @param {number} speed
     * @param {number} turn_speed
     */
    setSpeed(agent_handle, speed, turn_speed) {
        wasm.navruntime_setSpeed(this.__wbg_ptr, agent_handle, speed, turn_speed);
    }
    /**
     * Host targets' positions for the next tick: `ids[i]` at `positions[3i..3i+3]`. Unlisted targets keep theirs.
     * @param {Uint32Array | number[]} ids
     * @param {Float32Array | number[]} positions
     */
    setTargetPositions(ids, positions) {
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passArray32ToWasm0(ids, wasm.__wbindgen_malloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passArrayF32ToWasm0(positions, wasm.__wbindgen_malloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 4, 4); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 4, 4); }
            throw e;
        }
        wasm.navruntime_setTargetPositions(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    }
    /**
     * Surround slots on a host target (`NavSurround` JSON), or none with an empty string.
     * @param {number} target_id
     * @param {string} surround_json
     */
    setTargetSurround(target_id, surround_json) {
        const val2 = +target_id;
        const ptr0 = passStringToWasm0(surround_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.navruntime_setTargetSurround(this.__wbg_ptr, val2, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * The World's override of an area's cost (`Navigation.setAreaCost`), under every agent's own.
     * @param {string} area
     * @param {number} cost
     * @param {boolean} excluded
     */
    setWorldAreaCost(area, cost, excluded) {
        const val2 = +cost;
        const val3 = +excluded;
        const ptr0 = passStringToWasm0(area, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.navruntime_setWorldAreaCost(this.__wbg_ptr, ptr0, len0, val2, val3);
    }
    /**
     * @param {number} agent_handle
     */
    stopChase(agent_handle) {
        wasm.navruntime_stopChase(this.__wbg_ptr, agent_handle);
    }
    /**
     * @param {number} agent_handle
     */
    stop(agent_handle) {
        wasm.navruntime_stop(this.__wbg_ptr, agent_handle);
    }
    /**
     * What the last tick did, as JSON (`tick`, `agents`, `paused`, `commands`, `chunks`).
     * @returns {string}
     */
    tickStats() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.navruntime_tickStats(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * One runtime tick (`engine.NavStep`): reads `agentsIn` / `obstaclesIn`, applies the commands, writes
     * `agentsOut` / `agentState`.
     * @param {number} dt
     * @param {number} time
     */
    tick(dt, time) {
        wasm.navruntime_tick(this.__wbg_ptr, dt, time);
    }
    /**
     * @param {string} id
     * @returns {boolean}
     */
    unloadChunk(id) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.navruntime_unloadChunk(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * @param {number} agent_handle
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    warp(agent_handle, x, y, z) {
        wasm.navruntime_warp(this.__wbg_ptr, agent_handle, x, y, z);
    }
}
if (Symbol.dispose) NavRuntime.prototype[Symbol.dispose] = NavRuntime.prototype.free;

/**
 * A summary of a `myco.nav@1` bake file as JSON (for the editor's asset inspector and tests):
 * `{ "packageVersion", "signature", "sections": [{ "kind", "group", "group2", "length", "fingerprint" }] }`,
 * or `{ "error" }`. With `verify`, the whole file is parsed and every section's fingerprint checked.
 * @param {Uint8Array | number[]} bytes
 * @param {boolean} verify
 * @returns {string}
 */
export function bakeInfo(bytes, verify) {
    let deferred3_0;
    let deferred3_1;
    try {
        const val2 = +verify;
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.bakeInfo(ptr0, len0, val2);
        deferred3_0 = ret[0];
        deferred3_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Strides of the boundary buffers: `[agentsIn, agentsOut, agentState, obstaclesIn, waypoint]`.
 * @returns {Uint32Array}
 */
export function bufferStrides() {
    const ret = wasm.bufferStrides();
    var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
}

/**
 * A chunk's id (hex) from its scene's project path (forward slashes) and the chunk node's id.
 * @param {string} scene_path
 * @param {string} chunk_node_id
 * @returns {string}
 */
export function chunkId(scene_path, chunk_node_id) {
    let deferred3_0;
    let deferred3_1;
    try {
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passStringToWasm0(scene_path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(chunk_node_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.chunkId(ptr0, len0, ptr1, len1);
        deferred3_0 = ret[0];
        deferred3_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A bake's flight volume (section `group`) leaves: stride 5 (min xyz, size, area).
 * @param {Uint8Array | number[]} bytes
 * @param {number} group
 * @returns {Float32Array}
 */
export function debugBakeLeaves(bytes, group) {
    const val2 = +group;
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.debugBakeLeaves(ptr0, len0, val2);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v3;
}

/**
 * A bake's navmesh (section `group`) as line segments, without a runtime (the editor's scene view): stride 7, see
 * `debug::navmesh_lines`.
 * @param {Uint8Array | number[]} bytes
 * @param {number} group
 * @returns {Float32Array}
 */
export function debugBakeLines(bytes, group) {
    const val2 = +group;
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.debugBakeLines(ptr0, len0, val2);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v3;
}

/**
 * A bake's navmesh polygons as triangles: stride 11 (a, b, c, bin, area).
 * @param {Uint8Array | number[]} bytes
 * @param {number} group
 * @returns {Float32Array}
 */
export function debugBakeTriangles(bytes, group) {
    const val2 = +group;
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.debugBakeTriangles(ptr0, len0, val2);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v3;
}

/**
 * A string id as the runtime and bakes see it (32 hex digits; see `dto::parse_id`).
 * @param {string} id
 * @returns {string}
 */
export function navId(id) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.navId(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * The crate's version, for the loader to check against the TypeScript side.
 * @returns {string}
 */
export function version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * The module's memory, for typed-array views of the boundary buffers.
 * @returns {any}
 */
export function wasmMemory() {
    const ret = wasm.wasmMemory();
    return ret;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_208446807d0d1e30: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_memory_17a1178bc3328ea3: function() {
            const ret = wasm.memory;
            return ret;
        },
        __wbg___wbindgen_throw_4c88d8bf264fd984: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
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
        "./myco_nav_bg.js": import0,
    };
}

const NavBakerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_navbaker_free(ptr, 1));
const NavRuntimeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_navruntime_free(ptr, 1));

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedBigUint64ArrayMemory0 = null;
function getBigUint64ArrayMemory0() {
    if (cachedBigUint64ArrayMemory0 === null || cachedBigUint64ArrayMemory0.byteLength === 0) {
        cachedBigUint64ArrayMemory0 = new BigUint64Array(wasm.memory.buffer);
    }
    return cachedBigUint64ArrayMemory0;
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

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getBigUint64ArrayMemory0().set(arg, ptr / 8);
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

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
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

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedBigUint64ArrayMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
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
