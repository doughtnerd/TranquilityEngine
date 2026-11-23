/**
 * Node family `sync` (`anim-graph/src/sync.rs`): sync groups and notify weights. Internal: not public API.
 */
import { I, kind, P, type NodeFamilyCatalogue } from "./schema";

export const SYNC_NODES: NodeFamilyCatalogue = {
  family: "sync",
  kinds: [
    kind("sync", "syncGroup", 0, "Every clip player under it follows the heaviest one's phase by sync markers (D20).", I.one("child"), []),
    kind("sync", "notifyGate", 1, "Scales the weight its sub-graph's notifies see.", I.one("child"), [
      P.animated("factor", 1, "The notify weight factor.", { unit: "multiplier", min: 0 }),
    ]),
  ],
};
