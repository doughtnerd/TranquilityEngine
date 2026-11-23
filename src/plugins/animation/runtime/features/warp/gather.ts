// `animation.Gather`'s warp sub-step (ADR 0372; T40t): each Animator's motion-warp requests (`../warp.ts`) as
// `WARP_TARGET` commands for its graph instance, in world space (the character frame's space). Runs after the ik
// sub-step, so the character frame it reads is this frame's.
import { GameObject } from "../../../../../engine/scene/GameObject";
import type { AnimationFrame } from "../../stages/frame";
import { WARP_CLEAR, WARP_TARGET } from "../../wasm/wire/rig";
import { graphMeta } from "../graph/runtime";
import { animatorsOf } from "../instances";
import { rigState } from "../ik/state";
import { existingWarpState, type WarpGoal } from "./state";

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** The target's world position and rotation, or null for a destroyed node. */
function resolve(goal: Exclude<WarpGoal, null>, character: { position: ArrayLike<number>; rotation: ArrayLike<number> }): number[] | null {
  if (goal instanceof GameObject) {
    const t = goal.isValid ? goal.transform : null;
    if (!t) return null;
    const p = t.worldPosition, q = t.worldRotation;
    return [p.x, p.y, p.z, q.x, q.y, q.z, q.w];
  }
  const p = goal.position ? [goal.position.x, goal.position.y, goal.position.z] : Array.from(character.position);
  const q = goal.rotation ? [goal.rotation.x, goal.rotation.y, goal.rotation.z, goal.rotation.w] : Array.from(character.rotation);
  return [...p, ...q];
}

/** @internal */
export function gatherWarps(frame: AnimationFrame): void {
  for (const rt of animatorsOf(frame.world)) {
    if (rt.instance === 0 || rt.ns !== frame.core || (rt.animator.updateMode === "fixed") !== frame.fixed) continue;
    const requests = existingWarpState(rt.animator);
    if (!requests?.size) continue;
    const meta = graphMeta(rt.animator);
    if (!meta) continue; // still loading (or no graph): the requests wait
    const s = rigState(rt.animator);
    if (s.instance !== rt.instance) s.frame.readNode(rt.skeleton?.component.node ?? rt.animator.node);
    for (const [window, req] of requests) {
      const node = meta.warps.get(window);
      if (node === undefined) {
        warnOnce(`warp:${rt.animator.graph}:${window}`, `[myco] ${rt.animator.node.name}: the graph "${rt.animator.graph}" has no motion-warp window "${window}"; Animator.warp ignored.`);
        requests.delete(window);
        continue;
      }
      if (req.target === null) {
        frame.core.commands.put(WARP_TARGET, { instance: rt.instance, node, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, rw: 1, flags: WARP_CLEAR });
        requests.delete(window);
        continue;
      }
      const v = resolve(req.target, s.frame);
      if (!v || !v.every(Number.isFinite)) continue;
      const key = `${rt.instance}:${v.map((x) => Math.fround(x)).join(",")}`;
      if (req.sent === key) continue;
      req.sent = key;
      const [px, py, pz, rx, ry, rz, rw] = v as [number, number, number, number, number, number, number];
      frame.core.commands.put(WARP_TARGET, { instance: rt.instance, node, px, py, pz, rx, ry, rz, rw, flags: 0 });
    }
  }
}
