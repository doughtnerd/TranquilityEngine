// The graph Animators the live debugger can show (ADR 0373; T52, T60), named the same way whether the game runs in the
// editor's play session (`editor/debugger/localSource.ts`) or in a build connected through the debug link (`debugLink/
// topic.ts`): a target's id is its World's name and its node's entity, and a parameter edit from the debugger becomes
// the engine value `Animator.set` takes.
import type { World } from "../../../../../engine/core/World";
import { Quaternion, Vector2, Vector3 } from "../../../../../engine/core/math";
import type { Animator } from "../../components/Animator";
import type { AnimatorParameterValue } from "../../types";
import { animatorsOf } from "../instances";
import type { DebugParamValue } from "./frame";

/** @internal A graph Animator of a World, with its debugger id. */
export interface GraphAnimator {
  readonly world: World;
  readonly animator: Animator;
  readonly id: string;
}

/** @internal An Animator's debugger id. */
export const debugTargetId = (world: World, animator: Animator): string => `${world.name}#${animator.node.entity}`;

/** @internal The live Animators of `worlds` that run a graph. */
export function graphAnimators(worlds: readonly World[]): GraphAnimator[] {
  return worlds.flatMap((world) => [...animatorsOf(world)].filter((rt) => rt.animator.graph && rt.animator.node.isValid).map((rt) => ({ world, animator: rt.animator, id: debugTargetId(world, rt.animator) })));
}

/** @internal A debugger value as `Animator.set` takes it (vectors and quaternions as engine types). */
export function paramValue(v: DebugParamValue): AnimatorParameterValue {
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (v.length === 2) return new Vector2(v[0]!, v[1]!);
  if (v.length === 3) return new Vector3(v[0]!, v[1]!, v[2]!);
  return new Quaternion(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 1);
}

/** @internal A value from the wire as a debugger value, or null when it isn't one (a JSON number, boolean or number list). */
export function wireParamValue(v: unknown): DebugParamValue | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  if (Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every((x) => typeof x === "number" && Number.isFinite(x))) return v as number[];
  return null;
}
