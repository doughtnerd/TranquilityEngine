// The graph parameters motion matching reads (ADR 0372; T42t, D75): each `matching/poseDatabase` node names the
// parameters its trajectory query comes from. The host fills the character's own ones every frame (`gather.ts`):
// `position`, `yaw` and `velocity` from the CharacterController (or the node's motion without one), and `lod` from
// the Animator's `lodSearchMultiplier`. `desiredVelocity` and `desiredYaw` are gameplay's (`anim.set`), never written
// here. A pure library over the graph source and the compiler's parameter table.
import type { AnimGraph, GraphParamType } from "../../../../../engine/animation/animGraph";

/** @internal A parameter the host writes: its index and kind. */
export interface HostParameter {
  readonly index: number;
  readonly type: GraphParamType;
}

/** @internal The host-written parameters of a graph's pose-database nodes (each parameter once). */
export interface MatchingInputs {
  readonly position: readonly HostParameter[];
  readonly yaw: readonly HostParameter[];
  readonly velocity: readonly HostParameter[];
  readonly lod: readonly HostParameter[];
}

/** @internal The parameters `graph`'s pose-database nodes read from the host, or null when it has none. */
export function matchingInputs(graph: AnimGraph, parameters: readonly string[]): MatchingInputs | null {
  const types = new Map(graph.parameters.map((p) => [p.name, p.type]));
  const out = { position: [] as HostParameter[], yaw: [] as HostParameter[], velocity: [] as HostParameter[], lod: [] as HostParameter[] };
  const seen = new Set<number>();
  let any = false;
  for (const n of graph.nodes) {
    if (n.family !== "matching" || n.kind !== "poseDatabase") continue;
    any = true;
    for (const key of ["position", "yaw", "velocity", "lod"] as const) {
      const name = n.params[key];
      if (typeof name !== "string" || !name) continue;
      const index = parameters.indexOf(name);
      const type = types.get(name);
      if (index < 0 || !type || seen.has(index)) continue;
      seen.add(index);
      out[key].push({ index, type });
    }
  }
  return any ? out : null;
}
