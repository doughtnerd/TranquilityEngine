// ADR 0171 §2.1 and §2.2 (amended by ADR 0172 §1.7): the ducking-rule parse. Skeleton from Sa1; L-Sa1a fills the cases.
import { describe, expect, it } from "vitest";
import { parseAudioSettings, MAX_DUCK_RULES, MAX_LEVEL_RULES } from "./settings";

/** Parses a `ducking` list on the default buses (all under Master) unless `buses` is given. */
const parse = (ducking: unknown[], buses?: unknown[]) => parseAudioSettings(buses ? { buses, ducking } : { ducking });

/** Voice is above Music: Voice under Master, Music under Voice. */
const VOICE_ABOVE_MUSIC = [{ name: "Master" }, { name: "Voice", parent: "Master" }, { name: "Music", parent: "Voice" }];

/** Music and SFX under Master, Voice under Music: a tree edge (Voice to Music) joins the level rules. */
const MUSIC_WITH_VOICE_CHILD = [
  { name: "Master" },
  { name: "Music", parent: "Master" },
  { name: "SFX", parent: "Master" },
  { name: "Voice", parent: "Music" },
];

describe("audio.ducking parse (L-Sa1a)", () => {
  describe("mode", () => {
    it("presence rule is kept with mode presence and no detector or threshold", () => {
      const { settings, problems } = parse([{ target: "Music", trigger: "Voice", mode: "presence" }]);
      expect(problems).toEqual([]);
      expect(settings.ducking).toEqual([{ target: "Music", trigger: "Voice", mode: "presence", amount: 0.4, attack: 0.1, release: 0.5 }]);
      expect(settings.ducking[0]).not.toHaveProperty("detector");
      expect(settings.ducking[0]).not.toHaveProperty("threshold");
    });

    it("level rule is kept with mode level", () => {
      const { settings, problems } = parse([{ target: "Music", trigger: "Voice", mode: "level" }]);
      expect(problems).toEqual([]);
      expect(settings.ducking).toEqual([
        { target: "Music", trigger: "Voice", mode: "level", detector: "rms", threshold: -30, amount: 0.4, attack: 0.1, release: 0.5 },
      ]);
    });

    it("absent or unknown mode drops the rule with a problem", () => {
      const rules = [{ target: "Music", trigger: "Voice" }, { target: "Music", trigger: "Voice", mode: "ducking" }];
      for (const rule of rules) {
        const { settings, problems } = parse([rule]);
        expect(settings.ducking).toEqual([]);
        expect(problems).toEqual(['audio.ducking[0]: mode must be "level" or "presence"; the rule is dropped.']);
      }
    });
  });

  describe("detector", () => {
    it("level rule: peak is kept", () => {
      const { settings, problems } = parse([{ target: "Music", trigger: "Voice", mode: "level", detector: "peak" }]);
      expect(problems).toEqual([]);
      expect(settings.ducking[0]).toMatchObject({ detector: "peak", threshold: -30 });
    });

    it("level rule: rms is kept", () => {
      const { settings, problems } = parse([{ target: "Music", trigger: "Voice", mode: "level", detector: "rms" }]);
      expect(problems).toEqual([]);
      expect(settings.ducking[0]).toMatchObject({ detector: "rms" });
    });

    it("level rule: absent defaults to rms; an unknown value falls back to rms with a problem", () => {
      const absent = parse([{ target: "Music", trigger: "Voice", mode: "level" }]);
      expect(absent.problems).toEqual([]);
      expect(absent.settings.ducking[0]).toMatchObject({ detector: "rms" });

      const unknown = parse([{ target: "Music", trigger: "Voice", mode: "level", detector: "sine" }]);
      expect(unknown.settings.ducking[0]).toMatchObject({ detector: "rms" });
      expect(unknown.problems).toEqual(['audio.ducking[0].detector: must be one of peak, rms; using "rms".']);
    });

    it("presence rule: a detector is ignored with a problem", () => {
      const { settings, problems } = parse([{ target: "Music", trigger: "Voice", mode: "presence", detector: "peak" }]);
      expect(problems).toEqual(["audio.ducking[0]: detector applies to level rules only; ignored."]);
      expect(settings.ducking[0]).not.toHaveProperty("detector");
    });
  });

  describe("threshold", () => {
    it("level rule: -80, -30 and 0 are kept; absent defaults to -30", () => {
      for (const threshold of [-80, -30, 0]) {
        const { settings, problems } = parse([{ target: "Music", trigger: "Voice", mode: "level", threshold }]);
        expect(problems).toEqual([]);
        expect(settings.ducking[0]).toMatchObject({ threshold });
      }
      const absent = parse([{ target: "Music", trigger: "Voice", mode: "level" }]);
      expect(absent.problems).toEqual([]);
      expect(absent.settings.ducking[0]).toMatchObject({ threshold: -30 });
    });

    it("level rule: out-of-range values clamp to -80..0 with a problem; a non-number gives -30 with a problem", () => {
      const low = parse([{ target: "Music", trigger: "Voice", mode: "level", threshold: -100 }]);
      expect(low.settings.ducking[0]).toMatchObject({ threshold: -80 });
      expect(low.problems).toEqual(["audio.ducking[0].threshold: -100 is outside -80..0; using -80."]);

      const high = parse([{ target: "Music", trigger: "Voice", mode: "level", threshold: 5 }]);
      expect(high.settings.ducking[0]).toMatchObject({ threshold: 0 });
      expect(high.problems).toEqual(["audio.ducking[0].threshold: 5 is outside -80..0; using 0."]);

      const text = parse([{ target: "Music", trigger: "Voice", mode: "level", threshold: "loud" }]);
      expect(text.settings.ducking[0]).toMatchObject({ threshold: -30 });
      expect(text.problems).toEqual(["audio.ducking[0].threshold: must be a number of dBFS from -80 to 0; using -30."]);
    });

    it("presence rule: a threshold is ignored with a problem", () => {
      const { settings, problems } = parse([{ target: "Music", trigger: "Voice", mode: "presence", threshold: -40 }]);
      expect(problems).toEqual(["audio.ducking[0]: threshold applies to level rules only; ignored."]);
      expect(settings.ducking[0]).not.toHaveProperty("threshold");
    });
  });

  describe("amount, attack, release", () => {
    it("defaults 0.4, 0.1, 0.5 and the clamps, in both modes", () => {
      for (const mode of ["level", "presence"] as const) {
        const base = { target: "Music", trigger: "Voice", mode };
        expect(parse([base]).settings.ducking[0]).toMatchObject({ amount: 0.4, attack: 0.1, release: 0.5 });

        const high = parse([{ ...base, amount: 2, attack: 20, release: 11 }]).settings.ducking[0];
        expect(high).toMatchObject({ amount: 1, attack: 10, release: 10 });

        const low = parse([{ ...base, amount: -1, attack: -1, release: -1 }]).settings.ducking[0];
        expect(low).toMatchObject({ amount: 0, attack: 0, release: 0 });
      }
    });
  });

  describe("ancestor trigger", () => {
    it("a trigger above the target drops the rule (either mode) with the section 2.2 message", () => {
      for (const mode of ["presence", "level"] as const) {
        const { settings, problems } = parse([{ target: "Music", trigger: "Voice", mode }], VOICE_ABOVE_MUSIC);
        expect(settings.ducking).toEqual([]);
        expect(problems).toEqual([
          "audio.ducking[0]: Voice is above Music in the tree, so its level can't be measured before Music is mixed.",
        ]);
      }
    });

    it("a trigger below the target, or a sibling, is kept", () => {
      for (const mode of ["presence", "level"] as const) {
        const below = parse([{ target: "Voice", trigger: "Music", mode }], VOICE_ABOVE_MUSIC);
        expect(below.problems).toEqual([]);
        expect(below.settings.ducking).toHaveLength(1);

        const sibling = parse([{ target: "Music", trigger: "SFX", mode }]);
        expect(sibling.problems).toEqual([]);
        expect(sibling.settings.ducking).toHaveLength(1);
      }
    });
  });

  describe("level-rule cycles", () => {
    it("A ducks B and B ducks A: the closing rule is dropped, the message names both rules", () => {
      const { settings, problems } = parse([
        { target: "Music", trigger: "Voice", mode: "level" },
        { target: "Voice", trigger: "Music", mode: "level" },
      ]);
      expect(settings.ducking).toEqual([expect.objectContaining({ target: "Music", trigger: "Voice" })]);
      expect(problems).toEqual([
        "audio.ducking[1]: level rules can't form a cycle, so the rule is dropped: ducking[0] (Voice ducks Music), ducking[1] (Music ducks Voice).",
      ]);
    });

    it("A to B to C to A across three rules names all three", () => {
      const { settings, problems } = parse([
        { target: "Music", trigger: "Voice", mode: "level" },
        { target: "SFX", trigger: "Music", mode: "level" },
        { target: "Voice", trigger: "SFX", mode: "level" },
      ]);
      expect(settings.ducking).toHaveLength(2);
      expect(problems).toEqual([
        "audio.ducking[2]: level rules can't form a cycle, so the rule is dropped: ducking[0] (Voice ducks Music), ducking[1] (Music ducks SFX), ducking[2] (SFX ducks Voice).",
      ]);
    });

    it("a cycle through the tree edges (parent and child buses) is refused", () => {
      // Voice mixes into Music, so Voice to Music is a tree edge; Music ducks SFX, then SFX ducks Voice closes the loop.
      const { settings, problems } = parse(
        [
          { target: "SFX", trigger: "Music", mode: "level" },
          { target: "Voice", trigger: "SFX", mode: "level" },
        ],
        MUSIC_WITH_VOICE_CHILD,
      );
      expect(settings.ducking).toHaveLength(1);
      expect(problems).toEqual([
        "audio.ducking[1]: level rules can't form a cycle, so the rule is dropped: ducking[0] (Music ducks SFX), ducking[1] (SFX ducks Voice).",
      ]);
    });

    it("presence rules add no edge: the same pair as presence rules is kept", () => {
      const { settings, problems } = parse([
        { target: "Music", trigger: "Voice", mode: "presence" },
        { target: "Voice", trigger: "Music", mode: "presence" },
      ]);
      expect(problems).toEqual([]);
      expect(settings.ducking).toHaveLength(2);
    });

    it("a level rule opposite a presence rule is kept", () => {
      const { settings, problems } = parse([
        { target: "Music", trigger: "Voice", mode: "level" },
        { target: "Voice", trigger: "Music", mode: "presence" },
      ]);
      expect(problems).toEqual([]);
      expect(settings.ducking.map((r) => r.mode)).toEqual(["level", "presence"]);
    });
  });

  describe("counts", () => {
    it("32 rules are kept; the 33rd is ignored with a problem", () => {
      expect(MAX_DUCK_RULES).toBe(32);
      const presence = { target: "Music", trigger: "Voice", mode: "presence" };

      const exact = parse(Array.from({ length: 32 }, () => presence));
      expect(exact.settings.ducking).toHaveLength(32);
      expect(exact.problems).toEqual([]);

      const over = parse(Array.from({ length: 33 }, () => presence));
      expect(over.settings.ducking).toHaveLength(32);
      expect(over.problems).toEqual(["audio.ducking: at most 32 rules; the rest are ignored."]);
    });

    it("8 level rules are kept; the 9th is dropped with a problem, a presence rule after it is kept", () => {
      expect(MAX_LEVEL_RULES).toBe(8);
      const level = { target: "Music", trigger: "Voice", mode: "level" };
      const presence = { target: "Music", trigger: "Voice", mode: "presence" };

      const exact = parse(Array.from({ length: 8 }, () => level));
      expect(exact.settings.ducking).toHaveLength(8);
      expect(exact.problems).toEqual([]);

      const over = parse([...Array.from({ length: 8 }, () => level), level, presence]);
      expect(over.settings.ducking.map((r) => r.mode)).toEqual([...Array.from({ length: 8 }, () => "level"), "presence"]);
      expect(over.problems).toEqual(["audio.ducking[8]: at most 8 level rules; the rule is dropped."]);
    });
  });
});
