/**
 * The node catalogue's registry (ADR 0372 "One node catalogue"): one family file per node family
 * (`graphNodes/<family>.ts`), collected here once. A later task adds or extends a family by editing its own file; the
 * compiler, the graph editor's cards and the third-party node cards all look kinds up through `nodeKindSchema`.
 *
 * Internal: not public API.
 */
import { GRAPH_FAMILIES, type GraphFamily } from "../animGraph";
import { LOGIC_NODES } from "./logic";
import { MATCHING_NODES } from "./matching";
import { MIXING_NODES } from "./mixing";
import { PHYSICS_NODES } from "./physics";
import { PLUGIN_NODES } from "./plugin";
import { RETARGET_NODES } from "./retarget";
import { RIG_NODES } from "./rig";
import type { NodeFamilyCatalogue, NodeKindSchema } from "./schema";
import { SLOTS_NODES } from "./slots";
import { SOURCES_NODES } from "./sources";
import { SYNC_NODES } from "./sync";

export * from "./schema";

/** @internal Every family's catalogue, in `GRAPH_FAMILIES` (family id) order. */
export const NODE_CATALOGUE: readonly NodeFamilyCatalogue[] = [SOURCES_NODES, LOGIC_NODES, MIXING_NODES, SLOTS_NODES, SYNC_NODES, RIG_NODES, RETARGET_NODES, MATCHING_NODES, PHYSICS_NODES, PLUGIN_NODES];

const byKind = new Map<string, NodeKindSchema>(NODE_CATALOGUE.flatMap((f) => f.kinds.map((k) => [`${f.family}/${k.kind}`, k] as const)));

/** @internal A kind's schema, or undefined when no family file declares it. */
export function nodeKindSchema(family: GraphFamily, kind: string): NodeKindSchema | undefined {
  return byKind.get(`${family}/${kind}`);
}

/** @internal A family's id (`anim-format`'s `family` ids). */
export const familyId = (family: GraphFamily): number => GRAPH_FAMILIES.indexOf(family);
