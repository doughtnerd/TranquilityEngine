/**
 * Node family `slots` (`anim-graph/src/slots.rs`): slots with sections (a `SLOTS` record names the node) and linked
 * graphs (a `LINKED` record names the node, with declared capacities, D56). Internal: not public API.
 */
import { I, kind, P, type NodeFamilyCatalogue } from "./schema";

export const SLOTS_NODES: NodeFamilyCatalogue = {
  family: "slots",
  kinds: [
    kind("slots", "slot", 0, "Passes its source through until code plays a clip into the slot (its `slot`).", I.one("source"), [
      P.asset("mask", "mask", "The bone mask of the slot's plays (none: full body)."),
    ], undefined, "slot"),
    kind("slots", "linked", 1, "Runs another graph inside its own state words, swapped per instance (its `linked`).", I.none, [
      P.int("stateWords", 4096, "State capacity: fixed words.", { min: 0 }),
      P.int("stateWordsPerGroup", 1024, "State capacity: words per group of four bones.", { min: 0 }),
      P.int("depth", 4, "Extra pose-stack levels.", { min: 0, max: 64 }),
      P.int("parameters", 64, "Parameter capacity.", { min: 0, max: 1024 }),
    ], undefined, "linked"),
  ],
};
