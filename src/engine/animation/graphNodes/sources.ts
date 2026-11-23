/**
 * Node family `sources` (`anim-graph/src/sources.rs`): clip players, blend spaces 1D and 2D, pose snapshot, reference
 * and bind pose. Each kind's parameter block follows the Rust module's word table. Internal: not public API.
 */
import { I, kind, P, type NodeFamilyCatalogue, type NodePacker, type NodeParamSchema } from "./schema";

/** `PLAYER_LOOP_SET` / `PLAYER_LOOP` per `loop` choice: the clip's own flag, loop, play once. */
const LOOP_FLAGS = [0, 1 | 2, 1];
/** Blend-space flags. */
const BS_SYNC = 1;
const BS_SPEED = 2;
/** At most `MAX_BLEND_INPUTS` samples blend. */
const MAX_SAMPLES = 32;

const blendSpaceParams = (dims: 1 | 2): NodeParamSchema[] => [
  P.parameter("x", ["float"], "The float parameter giving the x coordinate."),
  ...(dims === 2 ? [P.parameter("y", ["float"], "The float parameter giving the y coordinate.")] : []),
  P.parameter("speed", ["float"], "The float parameter with the character's speed (units per second), for `speedScale`."),
  P.float("glideMs", 0, "A change of the inputs glides linearly to the new value over this many milliseconds (0: none).", { min: 0 }),
  P.bool("sync", false, "Followers follow the heaviest sample's sync-marker phase (`BS_SYNC`)."),
  P.bool("speedScale", false, "Playback rate = the speed parameter ÷ the samples' blended root speed (`BS_SPEED`)."),
  P.float("rateMin", 0, "The rate's lower clamp (0: the core's 0.25).", { unit: "multiplier", min: 0 }),
  P.float("rateMax", 0, "The rate's upper clamp (0: the core's 4).", { unit: "multiplier", min: 0 }),
  P.list("coords", "floatList", dims === 1 ? "The samples' coordinates, one per input." : "The samples' coordinates, x then y per input."),
];

function packBlendSpace(p: NodePacker, dims: 1 | 2): void {
  p.push(p.parameter("x"), dims === 2 ? p.parameter("y") : 0xffffffff, p.parameter("speed"));
  p.f32(p.num("glideMs"));
  p.push((p.bool("sync") ? BS_SYNC : 0) | (p.bool("speedScale") ? BS_SPEED : 0));
  p.f32(p.num("rateMin"));
  p.f32(p.num("rateMax"));
  const coords = p.list("coords");
  const want = dims * p.inputCount;
  if (coords.length !== want) p.problem(`needs ${want} coordinates (${dims} per input), has ${coords.length}; ${coords.length < want ? "the rest are 0" : "the rest are dropped"}.`, "coords");
  for (let i = 0; i < want; i++) p.push(coords[i] ?? 0);
}

export const SOURCES_NODES: NodeFamilyCatalogue = {
  family: "sources",
  kinds: [
    kind("sources", "clipPlayer", 0, "Plays one clip.", I.none, [
      P.asset("clip", "clip", "The clip (none: set at runtime)."),
      P.float("speed", 1, "Playback speed.", { unit: "multiplier" }),
      P.enum("loop", ["clip", "loop", "once"], "Loop as the clip says, always, or never (`true`/`false` read as loop/once)."),
      P.float("start", 0, "Start time.", { unit: "seconds", min: 0 }),
      P.int("layer", null, "Layer index reported in state events (none: `NONE`).", { min: 0 }),
    ], (p) => {
      p.push(p.asset("clip"));
      p.f32(p.num("speed"));
      p.push(LOOP_FLAGS[p.choice("loop")]);
      p.f32(p.num("start"));
      p.push(p.int("layer") ?? 0xffffffff);
    }),
    kind("sources", "blendSpace1D", 1, "A 1D blend space over its samples (gated: only weighted samples advance).", I.range(1, MAX_SAMPLES, "samples"), blendSpaceParams(1), (p) => packBlendSpace(p, 1)),
    kind("sources", "blendSpace2D", 2, "A 2D blend space (Delaunay triangulation, audio Blend's rule).", I.range(1, MAX_SAMPLES, "samples"), blendSpaceParams(2), (p) => packBlendSpace(p, 2)),
    kind("sources", "poseSnapshot", 3, "A frozen pose (ragdoll get-up).", I.none, [
      P.enum("mode", ["onEnter", "command"], "Capture the instance's last output when initialised, or only by the `CAPTURE_POSE` command."),
    ]),
    kind("sources", "referencePose", 4, "The skeleton's rest pose (or the identity pose, an additive's zero).", I.none, [
      P.bool("identity", false, "Output the identity pose instead of the rest pose."),
    ]),
    kind("sources", "bindPose", 5, "The skeleton's bind pose.", I.none, []),
  ],
};
