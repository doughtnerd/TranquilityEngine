// ADR 0171 §2.1 and §2.2 (amended by ADR 0172 §1.7): the ducking-rule parse. Skeleton from Sa1; L-Sa1a fills the cases.
import { describe, it } from "vitest";
// import { parseAudioSettings, MAX_DUCK_RULES, MAX_LEVEL_RULES } from "./settings";

describe("audio.ducking parse (L-Sa1a)", () => {
  describe("mode", () => {
    it.skip("presence rule is kept with mode presence and no detector or threshold", () => {});
    it.skip("level rule is kept with mode level", () => {});
    it.skip("absent or unknown mode drops the rule with a problem", () => {});
  });
  describe("detector", () => {
    it.skip("level rule: peak is kept", () => {});
    it.skip("level rule: rms is kept", () => {});
    it.skip("level rule: absent defaults to rms; an unknown value falls back to rms with a problem", () => {});
    it.skip("presence rule: a detector is ignored with a problem", () => {});
  });
  describe("threshold", () => {
    it.skip("level rule: -80, -30 and 0 are kept; absent defaults to -30", () => {});
    it.skip("level rule: out-of-range values clamp to -80..0 with a problem; a non-number gives -30 with a problem", () => {});
    it.skip("presence rule: a threshold is ignored with a problem", () => {});
  });
  describe("amount, attack, release", () => {
    it.skip("defaults 0.4, 0.1, 0.5 and the clamps, in both modes", () => {});
  });
  describe("ancestor trigger", () => {
    it.skip("a trigger above the target drops the rule (either mode) with the section 2.2 message", () => {});
    it.skip("a trigger below the target, or a sibling, is kept", () => {});
  });
  describe("level-rule cycles", () => {
    it.skip("A ducks B and B ducks A: the closing rule is dropped, the message names both rules", () => {});
    it.skip("A to B to C to A across three rules names all three", () => {});
    it.skip("a cycle through the tree edges (parent and child buses) is refused", () => {});
    it.skip("presence rules add no edge: the same pair as presence rules is kept", () => {});
    it.skip("a level rule opposite a presence rule is kept", () => {});
  });
  describe("counts", () => {
    it.skip("32 rules are kept; the 33rd is ignored with a problem", () => {});
    it.skip("8 level rules are kept; the 9th is dropped with a problem, a presence rule after it is kept", () => {});
  });
});
