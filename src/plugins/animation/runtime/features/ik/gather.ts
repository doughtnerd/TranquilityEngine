// The rig stack's per-frame inputs (ADR 0370 frame order, 0372; T40t, D41, D65): what `animation.Gather` writes into a
// graph instance's row of the `rig` input view, and what `animation.Apply` keeps of its grounder rays.
//
// - **Character frame:** the Skeleton node's world transform (the Animator's node without a Skeleton): the rig's model
//   space is the skeleton root's. World-space IK targets and motion-warp targets convert through it in the core.
// - **IK targets:** each of the compiled graph's `ikTargets` slots, by name, from `Animator.ik(name).target(...)`
//   (`../ik.ts`), else from the Animator's `ikTargets`/`ikTargetNodes` binding (position weight 1, the end bone keeps
//   its animated rotation), else off (weight 0). Node targets are read at their world transform from the previous
//   propagation (ADR 0370), plus their current local change.
// - **Teleports:** when the character frame jumps farther than `TELEPORT_METRES` (or `TELEPORT_SPEED` × dt) in one
//   gather, the instance gets `RIG_RESET` (every rig node: springs restart on the animated pose, damping and grounder
//   smoothing snap) and last frame's rays are dropped. This is automatic; there is no Animator method (none in 0372).
// - **Rig LOD:** level 0, or `RIG_LOD_OFF` while the Skeleton is farther than the Animator's `rigCullDistance` (> 0)
//   from the main camera (the enabled Camera with the lowest depth; no camera: 0). Every rig node whose `lodSkip` is
//   ≥ 1 then switches off; a node with `lodSkip` 0 always runs.
// - **Grounder rays** (D41): `collectRigRays` (Apply) converts the ray requests the evaluate wrote (model space) to
//   world space with the frame that evaluate used. The next gather casts them through the World's 3D ray query (the
//   physics service's `raycast`, what `Physics.raycast` answers with, while the physics plugin is on: `./physics.ts`)
//   and writes the hits back in model space with *that* frame's character frame. A one-frame-old hit is standard
//   (Final IK). Without physics, or before the first evaluate, every hit is a miss.
import { _worldRaycast, type WorldRayHit } from "../../../../../engine/core/worldServices";
import { Mat4 } from "../../../../../engine/core/math";
import { GameObject } from "../../../../../engine/scene/GameObject";
import type { AnimationFrame } from "../../stages/frame";
import { HANDLE_INDEX_MASK } from "../../wasm/wire/core";
import {
  HIT_FLAGS,
  HIT_NORMAL,
  HIT_POINT,
  HIT_STRIDE,
  HIT_VALID,
  NODE_ALL,
  RAY_DIRECTION,
  RAY_FLAGS,
  RAY_LENGTH,
  RAY_ORIGIN,
  RAY_ROW_STRIDE,
  RAY_STRIDE,
  RAY_VALID,
  RIG_CHARACTER_POSITION,
  RIG_CHARACTER_ROTATION,
  RIG_CHARACTER_SCALE,
  RIG_HITS,
  RIG_INPUT_STRIDE,
  RIG_LOD,
  RIG_MAX_RAYS,
  RIG_MAX_TARGETS,
  RIG_RESET,
  RIG_TARGETS,
  TARGET_FLAGS,
  TARGET_POSITION,
  TARGET_POSITION_WEIGHT,
  TARGET_ROTATION,
  TARGET_ROTATION_WEIGHT,
  TARGET_STRIDE,
  TARGET_WORLD,
} from "../../wasm/wire/rig";
import { graphMeta } from "../graph/runtime";
import { animatorsOf, type AnimatorRuntime } from "../instances";
import { cameraViews, type CameraViews } from "../playback/view";
import { CharacterFrame } from "./frame";
import { rigPhysics } from "./physics";
import { RAY_FLOATS, rigState, type GoalTarget, type RigState } from "./state";

/** A jump farther than this in one gather is a teleport (metres)… */
const TELEPORT_METRES = 2;
/** …or faster than this (metres per second), whichever is larger. */
const TELEPORT_SPEED = 50;
/** The rig LOD level past `rigCullDistance`: every node with a `lodSkip` switches off. */
const RIG_LOD_OFF = 0xffffffff;

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** Whether `rt` takes part in `frame` (it has an instance in this World, and its update mode matches the pass). */
const inPass = (frame: AnimationFrame, rt: AnimatorRuntime): boolean => rt.instance !== 0 && rt.ns === frame.core && (rt.animator.updateMode === "fixed") === frame.fixed;

const characterNode = (rt: AnimatorRuntime): GameObject => rt.skeleton?.component.node ?? rt.animator.node;

const scratch = new CharacterFrame();
const v3 = new Float64Array(3);

function isNode(t: GoalTarget): t is GameObject {
  return t instanceof GameObject;
}

/** `worldPoint`'s answer for a node (reused: read it before the next call). */
const nodePoint = { x: 0, y: 0, z: 0 };
/** `nodeRotation`'s answer and its decomposition scratch (f32, as `Transform.worldRotation` decomposes: the same bits). */
const nodeQuat = { x: 0, y: 0, z: 0, w: 1 };
const decomposed = { p: new Float32Array(3), q: new Float32Array(4), s: new Float32Array(3) };

/** A node's world rotation (`Transform.worldRotation`'s numbers, in a reused object), or null without a Transform. */
function nodeRotation(t: GameObject): { x: number; y: number; z: number; w: number } | null {
  if (!t.transform) return null;
  const e = t.entity;
  Mat4.decompose(t.world.worldMatrix(e), e * 16, decomposed.p, 0, decomposed.q, 0, decomposed.s, 0);
  const q = decomposed.q;
  nodeQuat.x = q[0]!;
  nodeQuat.y = q[1]!;
  nodeQuat.z = q[2]!;
  nodeQuat.w = q[3]!;
  return nodeQuat;
}

/** A goal target's world position (a node's: `worldPosition`'s numbers, in a reused object), or null for a destroyed node. */
function worldPoint(t: GoalTarget): { x: number; y: number; z: number } | null {
  if (!isNode(t)) return t;
  if (!t.isValid || !t.transform) return null;
  const e = t.entity;
  const m = t.world.worldMatrix(e), o = e * 16;
  nodePoint.x = m[o + 12]!;
  nodePoint.y = m[o + 13]!;
  nodePoint.z = m[o + 14]!;
  return nodePoint;
}

const NO_ROTATION = { x: 0, y: 0, z: 0, w: 1 } as const;

function writeSlot(view: DataView, at: number, p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number } | null, weight: number, rotationWeight: number): void {
  view.setFloat32(at + TARGET_POSITION, p.x, true);
  view.setFloat32(at + TARGET_POSITION + 4, p.y, true);
  view.setFloat32(at + TARGET_POSITION + 8, p.z, true);
  const r = q ?? NO_ROTATION;
  view.setFloat32(at + TARGET_ROTATION, r.x, true);
  view.setFloat32(at + TARGET_ROTATION + 4, r.y, true);
  view.setFloat32(at + TARGET_ROTATION + 8, r.z, true);
  view.setFloat32(at + TARGET_ROTATION + 12, r.w, true);
  view.setFloat32(at + TARGET_POSITION_WEIGHT, weight, true);
  view.setFloat32(at + TARGET_ROTATION_WEIGHT, q ? rotationWeight : 0, true);
  view.setUint32(at + TARGET_FLAGS, TARGET_WORLD, true);
}

function clearSlot(view: DataView, at: number): void {
  view.setFloat32(at + TARGET_POSITION_WEIGHT, 0, true);
  view.setFloat32(at + TARGET_ROTATION_WEIGHT, 0, true);
}

/** Which target slots `writeTargets` filled (reused: cleared on each call). */
const filled = new Uint8Array(RIG_MAX_TARGETS);

/** Writes the IK target slots of `rt`'s graph (see the file header). */
function writeTargets(view: DataView, row: number, rt: AnimatorRuntime, s: RigState, names: readonly string[]): void {
  const a = rt.animator;
  filled.fill(0);
  // Slot `k` is at `row + RIG_TARGETS + k * TARGET_STRIDE` (no closures made: this runs per character per frame).
  const base = row + RIG_TARGETS;
  for (const [name, goal] of s.goals) {
    const slot = names.indexOf(name);
    if (slot < 0 || slot >= RIG_MAX_TARGETS) {
      warnOnce(`ik:${a.graph}:${name}`, `[myco] ${a.node.name}: the graph "${a.graph}" has no IK target "${name}"; Animator.ik("${name}") does nothing.`);
      continue;
    }
    const p = goal.target ? worldPoint(goal.target) : null;
    if (!p) continue;
    let q: { x: number; y: number; z: number; w: number } | null = goal.rotation;
    if (!q && goal.rotationWeight > 0 && goal.target && isNode(goal.target)) q = nodeRotation(goal.target);
    writeSlot(view, base + slot * TARGET_STRIDE, p, q, goal.weight, goal.rotationWeight);
    filled[slot] = 1;
    if (goal.hint) {
      const pole = names.indexOf(`${name}Pole`);
      const h = worldPoint(goal.hint);
      if (pole < 0 || pole >= RIG_MAX_TARGETS) warnOnce(`ikhint:${a.graph}:${name}`, `[myco] ${a.node.name}: the graph "${a.graph}" has no pole slot "${name}Pole"; the hint of Animator.ik("${name}") is ignored.`);
      else if (h && !s.goals.has(`${name}Pole`)) {
        writeSlot(view, base + pole * TARGET_STRIDE, h, null, 1, 0);
        filled[pole] = 1;
      }
    }
  }
  const bound = a.ikTargets;
  for (let i = 0; i < bound.length; i++) {
    const slot = names.indexOf(bound[i]!);
    const node = a.ikTargetNodes[i];
    if (slot < 0 || slot >= RIG_MAX_TARGETS || filled[slot] || !node) continue;
    const p = worldPoint(node);
    if (!p) continue;
    writeSlot(view, base + slot * TARGET_STRIDE, p, null, 1, 0);
    filled[slot] = 1;
  }
  for (let slot = 0; slot < RIG_MAX_TARGETS; slot++) if (!filled[slot]) clearSlot(view, base + slot * TARGET_STRIDE);
}

/** The rig LOD level for `rt` (see the file header). */
function rigLod(rt: AnimatorRuntime, cams: CameraViews, at: Float64Array): number {
  const cull = rt.animator.rigCullDistance;
  const main = cams.main;
  if (!(cull > 0) || !main || !main.placed) return 0;
  return Math.hypot(at[0]! - main.px, at[1]! - main.py, at[2]! - main.pz) > cull ? RIG_LOD_OFF : 0;
}

/** The ray's origin and direction handed to the query (reused: the query copies them), and a hit converted to model space. */
const rayOrigin = { x: 0, y: 0, z: 0 };
const rayDirection = { x: 0, y: 0, z: 0 };
const out3 = new Float64Array(3);

/**
 * Casts last frame's rays of `rt` and writes the hits in this frame's model space; misses without physics. The rays go
 * through the World's 3D ray query (`_worldRaycast`: the 3D physics service's `raycast`, the one `Physics.raycast` calls
 * for the World, so the same hits) without `Physics.raycast`'s current-World switch and result objects.
 */
function writeHits(view: DataView, row: number, frame: AnimationFrame, s: RigState, instance: number): void {
  const cast = rigPhysics() !== null && s.rayInstance === instance;
  for (let i = 0; i < RIG_MAX_RAYS; i++) {
    const hit = row + RIG_HITS + i * HIT_STRIDE;
    view.setUint32(hit + HIT_FLAGS, 0, true);
    if (!cast || !s.rayValid[i]) continue;
    const r = i * RAY_FLOATS;
    const ray = s.rays;
    rayOrigin.x = ray[r]!;
    rayOrigin.y = ray[r + 1]!;
    rayOrigin.z = ray[r + 2]!;
    rayDirection.x = ray[r + 3]!;
    rayDirection.y = ray[r + 4]!;
    rayDirection.z = ray[r + 5]!;
    let result: WorldRayHit | null = null;
    try {
      result = _worldRaycast(frame.world, rayOrigin, rayDirection, ray[r + 6]!);
    } catch {
      result = null; // the physics query failed: a miss
    }
    if (!result) continue; // no 3D physics running in this World, or nothing hit: a miss
    const p = result.point, n = result.normal;
    s.frame.pointToModel3(p.x, p.y, p.z, out3);
    for (let k = 0; k < 3; k++) view.setFloat32(hit + HIT_POINT + 4 * k, out3[k]!, true);
    s.frame.normalToModel3(n.x, n.y, n.z, out3);
    for (let k = 0; k < 3; k++) view.setFloat32(hit + HIT_NORMAL + 4 * k, out3[k]!, true);
    view.setUint32(hit + HIT_FLAGS, HIT_VALID, true);
  }
}

/** @internal `animation.Gather`'s ik sub-step (see the file header). */
export function gatherRig(frame: AnimationFrame): void {
  let cams: CameraViews | null = null;
  for (const rt of animatorsOf(frame.world)) {
    if (!inPass(frame, rt)) continue;
    const meta = graphMeta(rt.animator);
    if (!meta) continue; // the implicit graph has no rig nodes
    const s = rigState(rt.animator);
    const instance = rt.instance;
    scratch.readNode(characterNode(rt));
    if (s.instance === instance) {
      const moved = Math.hypot(scratch.position[0]! - s.frame.position[0]!, scratch.position[1]! - s.frame.position[1]!, scratch.position[2]! - s.frame.position[2]!);
      if (moved > Math.max(TELEPORT_METRES, TELEPORT_SPEED * frame.dt)) {
        frame.core.commands.put(RIG_RESET, { instance, node: NODE_ALL });
        s.rayInstance = 0;
      }
    }
    s.frame.copy(scratch);
    s.instance = instance;
    const view = frame.core.core.views().rigInputs;
    const row = (instance & HANDLE_INDEX_MASK) * RIG_INPUT_STRIDE;
    for (let k = 0; k < 3; k++) {
      view.setFloat32(row + RIG_CHARACTER_POSITION + 4 * k, s.frame.position[k]!, true);
      view.setFloat32(row + RIG_CHARACTER_SCALE + 4 * k, s.frame.scale[k]!, true);
    }
    for (let k = 0; k < 4; k++) view.setFloat32(row + RIG_CHARACTER_ROTATION + 4 * k, s.frame.rotation[k]!, true);
    cams ??= cameraViews(frame.world);
    view.setUint32(row + RIG_LOD, rigLod(rt, cams, s.frame.position), true);
    writeTargets(view, row, rt, s, meta.compiled.ikTargets);
    writeHits(view, row, frame, s, instance);
  }
}

/** @internal `animation.Apply`'s ik sub-step: keeps the evaluate's grounder rays in world space for the next gather. */
export function collectRigRays(frame: AnimationFrame): void {
  for (const rt of animatorsOf(frame.world)) {
    if (!inPass(frame, rt)) continue;
    const meta = graphMeta(rt.animator);
    if (!meta || meta.compiled.rays === 0) continue;
    const s = rigState(rt.animator);
    if (s.instance !== rt.instance) continue;
    const view = frame.core.core.views().rays;
    const row = (rt.instance & HANDLE_INDEX_MASK) * RAY_ROW_STRIDE;
    s.rayInstance = rt.instance;
    for (let i = 0; i < RIG_MAX_RAYS; i++) {
      const at = row + i * RAY_STRIDE;
      const valid = (view.getUint32(at + RAY_FLAGS, true) & RAY_VALID) !== 0;
      s.rayValid[i] = valid ? 1 : 0;
      if (!valid) continue;
      const r = i * RAY_FLOATS;
      s.frame.pointToWorld3(view.getFloat32(at + RAY_ORIGIN, true), view.getFloat32(at + RAY_ORIGIN + 4, true), view.getFloat32(at + RAY_ORIGIN + 8, true), s.rays, r);
      s.frame.vectorToWorld3(view.getFloat32(at + RAY_DIRECTION, true), view.getFloat32(at + RAY_DIRECTION + 4, true), view.getFloat32(at + RAY_DIRECTION + 8, true), v3);
      const scale = Math.hypot(v3[0]!, v3[1]!, v3[2]!);
      const length = view.getFloat32(at + RAY_LENGTH, true) * scale;
      if (!(scale > 0) || !(length > 0)) {
        s.rayValid[i] = 0;
        continue;
      }
      for (let k = 0; k < 3; k++) s.rays[r + 3 + k] = v3[k]! / scale;
      s.rays[r + 6] = length;
    }
  }
}
