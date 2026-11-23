/**
 * Node family `matching` (`anim-graph/src/matching.rs`): the motion-matching database node and its chooser-row tag
 * filter. Trajectory inputs come from graph parameters (D75); tag masks are three 128-bit sets (`required`,
 * `excluded`, `any`: tag `t` is bit `t % 32` of word `t / 32`). Internal: not public API.
 */
import { I, kind, NONE, P, type NodeFamilyCatalogue, type NodePacker, type NodeParamSchema } from "./schema";

const TAG_WORDS = 4;
const MAX_TAG = TAG_WORDS * 32;
const TAG_SETS = ["requiredTags", "excludedTags", "anyTags"] as const;

const tagParams = (): NodeParamSchema[] => [
  P.list("requiredTags", "intList", "Tags (bit indices, or names of the database's tags) every picked frame has.", { min: 0, max: MAX_TAG - 1 }),
  P.list("excludedTags", "intList", "Tags no picked frame has.", { min: 0, max: MAX_TAG - 1 }),
  P.list("anyTags", "intList", "Tags of which a picked frame has at least one.", { min: 0, max: MAX_TAG - 1 }),
];

/** The three masks' twelve words. */
function packTags(p: NodePacker): void {
  for (const set of TAG_SETS) {
    const words = [0, 0, 0, 0];
    // A tag the packer couldn't resolve comes back as NONE (reported) and sets nothing.
    for (const t of p.list(set)) if (t < MAX_TAG) words[t >>> 5] = (words[t >>> 5] | (1 << (t & 31))) >>> 0;
    p.push(...words);
  }
}

export const MATCHING_NODES: NodeFamilyCatalogue = {
  family: "matching",
  kinds: [
    kind("matching", "poseDatabase", 0, "Plays whatever the pose-database search picks (motion matching).", I.range(0, 1, "tagChooser"), [
      P.asset("database", "posedb", "The pose database."),
      P.bool("bruteForce", false, "Search every row instead of the KD-tree (same result)."),
      P.int("interval", 6, "Search every this many updates.", { min: 1 }),
      P.float("force", 2, "The trajectory cost that forces a search at once.", { min: 0 }),
      P.float("bias", 0.1, "How much cheaper the best frame must be to switch.", { min: 0 }),
      P.float("minSwitch", 0.2, "Seconds between switches.", { unit: "seconds", min: 0 }),
      P.int("neighbours", 6, "Frames either side of the playing frame a search skips.", { min: 0 }),
      P.float("velocityHalfLife", 0.3, "The trajectory spring's velocity half-life.", { unit: "seconds", min: 0 }),
      P.float("facingHalfLife", 0.2, "The trajectory spring's facing half-life.", { unit: "seconds", min: 0 }),
      P.float("blend", 0.2, "The inertialization requested on a switch.", { unit: "seconds", min: 0 }),
      P.parameter("position", ["vec2", "vec3"], "The character's world position (vec2 x z, or vec3)."),
      P.parameter("yaw", ["float"], "Its world yaw (radians about +Y, 0 faces +Z)."),
      P.parameter("velocity", ["vec2", "vec3"], "Its controller's world ground velocity."),
      P.parameter("desiredVelocity", ["vec2", "vec3"], "The desired world ground velocity (none: the velocity)."),
      P.parameter("desiredYaw", ["float"], "The desired yaw (none: the yaw)."),
      P.parameter("lod", ["int", "float"], "The LOD multiplier (≥ 1; the search runs every interval × it updates)."),
      ...tagParams(),
      P.list("tagParameters", "parameterList", "Up to 12 int parameters whose values OR into the mask words at the same positions (required 0–3, excluded 4–7, any 8–11; \"\" for none).", { parameterTypes: ["int"], maxItems: 12 }),
    ], (p) => {
      p.push(p.asset("database"), p.bool("bruteForce") ? 1 : 0, p.int("interval") ?? 6);
      for (const n of ["force", "bias", "minSwitch"]) p.f32(p.num(n));
      p.push(p.int("neighbours") ?? 6);
      for (const n of ["velocityHalfLife", "facingHalfLife", "blend"]) p.f32(p.num(n));
      for (const n of ["position", "yaw", "velocity", "desiredVelocity", "desiredYaw", "lod"]) p.push(p.parameter(n));
      packTags(p);
      const q = p.list("tagParameters");
      for (let i = 0; i < 12; i++) p.push(q[i] ?? NONE);
    }),
    kind("matching", "matchTags", 1, "A tag filter for a chooser row above a pose-database node (no pose).", I.none, tagParams(), packTags),
  ],
};
