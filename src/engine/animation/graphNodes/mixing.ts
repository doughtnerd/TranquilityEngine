/**
 * Node family `mixing` (`anim-graph/src/mixing.rs`): blends by weight, enum and bool; the timed crossfade; masked
 * layers; inertialization; additive; time scale; mirror. Internal: not public API.
 */
import { I, kind, P, type NodeFamilyCatalogue } from "./schema";

/** At most `MAX_BLEND_INPUTS` inputs blend. */
const MAX_INPUTS = 32;

export const MIXING_NODES: NodeFamilyCatalogue = {
  family: "mixing",
  kinds: [
    kind("mixing", "blend2", 0, "Blends `b` over `a` by a weight.", I.fixed("a", "b"), [
      P.animated("weight", 0, "The weight of `b`.", { unit: "ratio", min: 0, max: 1 }),
    ]),
    kind("mixing", "crossfade", 1, "A timed crossfade between `a` and `b` (driven by commands).", I.fixed("a", "b"), [
      P.enum("start", ["a", "b"], "The side shown at start."),
    ]),
    kind("mixing", "layer", 2, "The overlay over the base by a layer's weight, through a bone mask.", I.fixed("base", "overlay"), [
      P.name("layer", "The graph layer whose runtime weight it uses (none: only `weight`)."),
      P.enum("mode", ["override", "additive"], "Override, or add the overlay as a delta pose."),
      P.asset("mask", "mask", "The bone mask (none: full body)."),
      P.animated("weight", 1, "The weight when the instance sets none for the layer; a parameter scales it.", { unit: "ratio", min: 0, max: 1 }),
    ], (p) => {
      p.push(p.layerIndex("layer"), p.choice("mode"), p.asset("mask"));
      const [w, q] = p.animated("weight");
      p.f32(w);
      p.push(q);
    }),
    kind("mixing", "inertialize", 3, "Decays the pop of a switch requested below it (Bollo's quintic).", I.one("source"), []),
    kind("mixing", "blendEnum", 4, "One input per value of an int parameter; the picked input blends in.", I.range(1, MAX_INPUTS, "values"), [
      P.parameter("value", ["int"], "The int parameter that picks."),
      P.float("blendTime", 0, "Blend time (0 snaps).", { unit: "seconds", min: 0 }),
    ]),
    kind("mixing", "blendBool", 5, "`false` and `true` inputs picked by a bool parameter.", I.fixed("false", "true"), [
      P.parameter("value", ["bool"], "The bool parameter that picks."),
      P.float("blendTime", 0, "Blend time (0 snaps).", { unit: "seconds", min: 0 }),
    ]),
    kind("mixing", "additive", 6, "`source − reference` (or `source` as a delta) added onto the base.", I.range(2, 3, "base", "source", "reference"), [
      P.animated("weight", 1, "The additive's weight.", { unit: "ratio", min: 0, max: 1 }),
    ]),
    kind("mixing", "timeScale", 7, "Advances its child at `dt × scale` (negative plays backwards).", I.one("child"), [
      P.animated("scale", 1, "The time scale.", { unit: "multiplier" }),
    ]),
    kind("mixing", "mirror", 8, "The child's pose reflected through the left/right map.", I.one("child"), [
      P.enum("axis", ["x", "y", "z"], "The mirror plane's normal."),
      P.parameter("enabled", ["bool"], "A bool parameter that switches it on (none: always on)."),
      P.list("table", "intList", "One word per bone: the bone whose motion it takes, flips in bits 16–17 (`retarget_mirror_table`'s words)."),
    ]),
  ],
};
