// `animation.Apply` sub-step: rootMotion (T17). Each instance's root delta (the core's root view, in the character's
// frame at the step's start, D35) into the `RootMotion` buffer in every mode, then applied by `rootMotion` mode: the
// Transform, or (physics on) the CharacterController or RigidBody (ADR 0370, 0372; `features/playback/rootMotion.ts`).
// An editor preview in a scene being edited (ADR 0026, D135) poses the character in place: no root motion.
import { Quaternion, Vector3 } from "../../../../../engine/core/math";
import { RootMotion } from "../../buffers";
import { animatorsOf, inEditMode } from "../../features/instances";
import { applyRootDelta } from "../../features/playback/rootMotion";
import { HANDLE_INDEX_MASK, ROOT_STRIDE } from "../../wasm/wire/core";
import type { AnimationFrame } from "../frame";
import { inPass } from "../gather/playback";

const FLOATS = ROOT_STRIDE / 4;

/** @internal */
export function applyRootMotion(frame: AnimationFrame): void {
  for (const rt of animatorsOf(frame.world)) {
    if (!inPass(frame, rt) || inEditMode(rt)) continue;
    const roots = frame.core.core.views().roots;
    const at = (rt.instance & HANDLE_INDEX_MASK) * FLOATS;
    const position = new Vector3(roots[at]!, roots[at + 1]!, roots[at + 2]!);
    const rotation = new Quaternion(roots[at + 3]!, roots[at + 4]!, roots[at + 5]!, roots[at + 6]!);
    RootMotion.push({ node: rt.animator.node, delta: { position, rotation } });
    const dt = rt.animator.updateMode === "unscaled" ? frame.unscaledDt : frame.dt;
    applyRootDelta(rt, position, rotation, dt);
  }
}
