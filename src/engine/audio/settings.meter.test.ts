// ADR 0171 §2.1 (Ld5): the metering parse of `audio`: `buses[].meter`, `loudnessTargets` and `loudnessResetOnPlay`,
// and the round trip through the model edit that writes `meter` (`applyOpToDraft`).
import { describe, expect, it } from "vitest";
import { applyOpToDraft, applyOpToSettings, opRefusal } from "./mixOps";
import { DEFAULT_LOUDNESS_TARGETS, parseAudioSettings } from "./settings";

const ROOT = { name: "Master" };

/** `n` non-root buses B1..Bn under Master, each with `meter: "loudness"`. */
const meteredBuses = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `B${i + 1}`, parent: "Master", meter: "loudness" }));

/** One valid target, with the given fields over it. */
const target = (over: Record<string, unknown> = {}) => ({ name: "t", integrated: -20, ...over });

const parseTargets = (list: unknown) => parseAudioSettings({ loudnessTargets: list });

describe("audio.buses[].meter parse (ADR 0171 §2.1)", () => {
  it("the ninth non-root metered bus is dropped with a problem; the first 8 in list order keep meter", () => {
    const { settings, problems } = parseAudioSettings({ buses: [ROOT, ...meteredBuses(9)] });
    expect(settings.buses.filter((b) => b.meter !== undefined).map((b) => b.name)).toEqual(["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"]);
    expect(settings.buses[9].meter).toBeUndefined();
    expect(problems).toEqual(["audio.buses[9].meter: at most 8 buses can be metered; dropped."]);
  });

  it("the root is not counted against the eight: Master metered plus eight others keeps all eight", () => {
    const { settings, problems } = parseAudioSettings({ buses: [{ ...ROOT, meter: "loudness" }, ...meteredBuses(8)] });
    expect(settings.buses.filter((b) => b.meter !== undefined).map((b) => b.name)).toEqual(["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"]);
    expect(problems).toEqual(["audio.buses[0].meter: Master is always metered; dropped."]);
  });

  it("the root with meter \"loudness\" is dropped with \"Master is always metered\"", () => {
    const { settings, problems } = parseAudioSettings({ buses: [{ ...ROOT, meter: "loudness" }, { name: "Music", parent: "Master" }] });
    expect(settings.buses[0]).not.toHaveProperty("meter");
    expect(problems).toEqual(["audio.buses[0].meter: Master is always metered; dropped."]);
  });

  it("meter \"rms\" and true on a bus are dropped with a problem; null is dropped silently", () => {
    const rms = parseAudioSettings({ buses: [ROOT, { name: "Music", parent: "Master", meter: "rms" }] });
    expect(rms.settings.buses[1]).not.toHaveProperty("meter");
    expect(rms.problems).toEqual([`audio.buses[1].meter: must be "loudness" or absent; dropped.`]);

    const bool = parseAudioSettings({ buses: [ROOT, { name: "Music", parent: "Master", meter: true }] });
    expect(bool.settings.buses[1]).not.toHaveProperty("meter");
    expect(bool.problems).toEqual([`audio.buses[1].meter: must be "loudness" or absent; dropped.`]);

    const nul = parseAudioSettings({ buses: [ROOT, { name: "Music", parent: "Master", meter: null }] });
    expect(nul.settings.buses[1]).not.toHaveProperty("meter");
    expect(nul.problems).toEqual([]);
  });

  it("a duplicate bus name counts only its first entry: a second entry's meter is ignored", () => {
    const first = parseAudioSettings({ buses: [ROOT, { name: "Music", parent: "Master", meter: "loudness" }, { name: "Music", parent: "Master", meter: "rms" }] });
    expect(first.settings.buses.map((b) => b.name)).toEqual(["Master", "Music"]);
    expect(first.settings.buses[1].meter).toBe("loudness");
    expect(first.problems.some((p) => p.includes("meter"))).toBe(false);

    const second = parseAudioSettings({ buses: [ROOT, { name: "Music", parent: "Master" }, { name: "Music", parent: "Master", meter: "loudness" }] });
    expect(second.settings.buses[1]).not.toHaveProperty("meter");
    expect(second.problems.some((p) => p.includes("meter"))).toBe(false);
  });

  it("a duplicate of a metered bus does not use up one of the eight slots", () => {
    const { settings, problems } = parseAudioSettings({ buses: [ROOT, ...meteredBuses(8), { name: "B1", parent: "Master", meter: "loudness" }] });
    expect(settings.buses.filter((b) => b.meter !== undefined)).toHaveLength(8);
    expect(problems.some((p) => p.includes("metered"))).toBe(false);
  });
});

describe("audio.loudnessTargets parse (ADR 0171 §2.1)", () => {
  it("integrated: -70 and 0 are kept; -70.1 and 0.1 are dropped with a problem", () => {
    for (const integrated of [-70, 0]) {
      const { settings, problems } = parseTargets([target({ integrated })]);
      expect(settings.loudnessTargets).toEqual([{ name: "t", integrated, tolerance: 2, truePeak: -1 }]);
      expect(problems).toEqual([]);
    }
    for (const integrated of [-70.1, 0.1]) {
      const { settings, problems } = parseTargets([target({ integrated })]);
      expect(settings.loudnessTargets).toBeUndefined();
      expect(problems).toEqual(["audio.loudnessTargets[0].integrated: must be a number of LUFS from -70 to 0; the target is dropped."]);
    }
  });

  it("tolerance: 0 and 12 are kept; 12.1 and -0.1 are dropped with a problem", () => {
    for (const tolerance of [0, 12]) {
      const { settings, problems } = parseTargets([target({ tolerance })]);
      expect(settings.loudnessTargets).toEqual([{ name: "t", integrated: -20, tolerance, truePeak: -1 }]);
      expect(problems).toEqual([]);
    }
    for (const tolerance of [12.1, -0.1]) {
      const { settings, problems } = parseTargets([target({ tolerance })]);
      expect(settings.loudnessTargets).toBeUndefined();
      expect(problems).toEqual(["audio.loudnessTargets[0].tolerance: must be a number of LU from 0 to 12; the target is dropped."]);
    }
  });

  it("truePeak: -20 and 0 are kept; -20.1 and 0.1 are dropped with a problem", () => {
    for (const truePeak of [-20, 0]) {
      const { settings, problems } = parseTargets([target({ truePeak })]);
      expect(settings.loudnessTargets).toEqual([{ name: "t", integrated: -20, tolerance: 2, truePeak }]);
      expect(problems).toEqual([]);
    }
    for (const truePeak of [-20.1, 0.1]) {
      const { settings, problems } = parseTargets([target({ truePeak })]);
      expect(settings.loudnessTargets).toBeUndefined();
      expect(problems).toEqual(["audio.loudnessTargets[0].truePeak: must be a number of dBTP from -20 to 0; the target is dropped."]);
    }
  });

  it("tolerance and truePeak absent give 2 and -1", () => {
    const { settings, problems } = parseTargets([{ name: "t", integrated: -20 }]);
    expect(settings.loudnessTargets).toEqual([{ name: "t", integrated: -20, tolerance: 2, truePeak: -1 }]);
    expect(problems).toEqual([]);
  });

  it("integrated absent or not a number drops only that entry, with a problem", () => {
    for (const bad of [undefined, "-20"]) {
      const { settings, problems } = parseTargets([{ name: "bad", integrated: bad }, target({ name: "ok" })]);
      expect(settings.loudnessTargets).toEqual([{ name: "ok", integrated: -20, tolerance: 2, truePeak: -1 }]);
      expect(problems).toEqual(["audio.loudnessTargets[0].integrated: must be a number of LUFS from -70 to 0; the target is dropped."]);
    }
  });

  it("a name that is empty, whitespace or 33 characters drops only that entry; 32 characters is kept", () => {
    const longName = "n".repeat(33), edge = "n".repeat(32);
    for (const bad of ["", "   ", longName]) {
      const { settings, problems } = parseTargets([target({ name: bad }), target({ name: "ok" })]);
      expect(settings.loudnessTargets).toEqual([{ name: "ok", integrated: -20, tolerance: 2, truePeak: -1 }]);
      expect(problems).toEqual(["audio.loudnessTargets[0]: name must be 1 to 32 characters; dropped."]);
    }
    const kept = parseTargets([target({ name: edge })]);
    expect(kept.settings.loudnessTargets?.[0].name).toBe(edge);
    expect(kept.problems).toEqual([]);
  });

  it("a duplicate name drops only the later entry, with a problem", () => {
    const { settings, problems } = parseTargets([target({ name: "a", integrated: -20 }), target({ name: "b" }), target({ name: "a", integrated: -30 })]);
    expect(settings.loudnessTargets?.map((t) => [t.name, t.integrated])).toEqual([["a", -20], ["b", -20]]);
    expect(problems).toEqual([`audio.loudnessTargets[2]: another target is already named "a"; dropped.`]);
  });

  it("more than 8 targets: the first 8 stay, with a problem", () => {
    const list = Array.from({ length: 9 }, (_, i) => target({ name: `t${i}` }));
    const { settings, problems } = parseTargets(list);
    expect(settings.loudnessTargets?.map((t) => t.name)).toEqual(["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7"]);
    expect(problems).toEqual(["audio.loudnessTargets: at most 8 targets; the rest are ignored."]);
  });

  it("an empty list, an all-bad list and a non-list give the default list (key absent)", () => {
    const empty = parseTargets([]);
    expect(empty.settings).not.toHaveProperty("loudnessTargets");
    expect(empty.problems).toEqual([]);

    const allBad = parseTargets([{ integrated: -20 }, { name: "x", integrated: 5 }]);
    expect(allBad.settings).not.toHaveProperty("loudnessTargets");
    expect(allBad.problems).toHaveLength(2);

    const notList = parseTargets("console");
    expect(notList.settings).not.toHaveProperty("loudnessTargets");
    expect(notList.problems).toEqual(["audio.loudnessTargets must be a list; using the defaults."]);
  });

  it("a list equal to the defaults is not written, even with tolerance and truePeak left out", () => {
    const explicit = DEFAULT_LOUDNESS_TARGETS.map((t) => ({ ...t }));
    expect(parseTargets(explicit).settings).not.toHaveProperty("loudnessTargets");
    const implicit = [{ name: "console", integrated: -24 }, { name: "mobile", integrated: -18 }];
    const parsed = parseTargets(implicit);
    expect(parsed.settings).not.toHaveProperty("loudnessTargets");
    expect(parsed.problems).toEqual([]);
  });

  it("a changed list is written in order, and so is a prefix of the defaults", () => {
    const swapped = parseTargets([{ name: "mobile", integrated: -18 }, { name: "console", integrated: -24 }]);
    expect(swapped.settings.loudnessTargets?.map((t) => t.name)).toEqual(["mobile", "console"]);
    const prefix = parseTargets([{ name: "console", integrated: -24 }]);
    expect(prefix.settings.loudnessTargets).toEqual([{ name: "console", integrated: -24, tolerance: 2, truePeak: -1 }]);
  });
});

describe("audio.loudnessResetOnPlay parse (ADR 0171 §2.1)", () => {
  it("false is kept", () => {
    const { settings, problems } = parseAudioSettings({ loudnessResetOnPlay: false });
    expect(settings.loudnessResetOnPlay).toBe(false);
    expect(problems).toEqual([]);
  });

  it("true is absent (the default), with no problem", () => {
    const { settings, problems } = parseAudioSettings({ loudnessResetOnPlay: true });
    expect(settings).not.toHaveProperty("loudnessResetOnPlay");
    expect(problems).toEqual([]);
  });

  it("a non-boolean gives a problem and is absent", () => {
    for (const bad of ["yes", 0, null]) {
      const { settings, problems } = parseAudioSettings({ loudnessResetOnPlay: bad });
      expect(settings).not.toHaveProperty("loudnessResetOnPlay");
      expect(problems).toEqual(["audio.loudnessResetOnPlay: must be true or false; using true."]);
    }
  });
});

describe("metering defaults are never written", () => {
  it("parsing {} gives no meter, loudnessTargets or loudnessResetOnPlay keys", () => {
    const { settings } = parseAudioSettings({});
    expect(settings.buses.every((b) => !("meter" in b))).toBe(true);
    expect(settings).not.toHaveProperty("loudnessTargets");
    expect(settings).not.toHaveProperty("loudnessResetOnPlay");
  });

  it("parsing the default values written out gives no such keys and no problems", () => {
    const input = {
      buses: [ROOT, { name: "Music", parent: "Master" }, { name: "SFX", parent: "Master", meter: undefined }],
      loudnessTargets: DEFAULT_LOUDNESS_TARGETS.map((t) => ({ ...t })),
      loudnessResetOnPlay: true,
    };
    const { settings, problems } = parseAudioSettings(input);
    expect(settings.buses.every((b) => !("meter" in b))).toBe(true);
    expect(settings).not.toHaveProperty("loudnessTargets");
    expect(settings).not.toHaveProperty("loudnessResetOnPlay");
    expect(problems).toEqual([]);
  });
});

describe("metering round trip through the model edit (ADR 0171 §2.1)", () => {
  it("turning meter on writes it, and the parse of the output gives the model's settings", () => {
    const base = { audio: { buses: [ROOT, { name: "Music", parent: "Master" }, { name: "SFX", parent: "Master" }] } };
    const op = { op: "setBus" as const, bus: "Music", key: "meter" as const, value: "loudness" };
    const edited = applyOpToDraft(base, op);
    expect(edited).not.toBe(base);
    expect(parseAudioSettings(edited.audio).problems).toEqual([]);
    expect(parseAudioSettings(edited.audio).settings).toEqual(applyOpToSettings(parseAudioSettings(base.audio).settings, op));
    expect(parseAudioSettings(edited.audio).settings.buses[1].meter).toBe("loudness");
  });

  it("turning meter off removes the key again, so the parse matches the untouched draft", () => {
    const base = { audio: { buses: [ROOT, { name: "Music", parent: "Master", meter: "loudness" }] } };
    const off = applyOpToDraft(base, { op: "setBus", bus: "Music", key: "meter", value: null });
    expect(parseAudioSettings(off.audio).settings.buses[1]).not.toHaveProperty("meter");
  });

  it("the ninth meter toggle is refused: the draft comes back unchanged with the message", () => {
    const base = { audio: { buses: [ROOT, ...meteredBuses(8), { name: "SFX", parent: "Master" }] } };
    const op = { op: "setBus" as const, bus: "SFX", key: "meter" as const, value: "loudness" };
    const settings = parseAudioSettings(base.audio).settings;
    expect(opRefusal(settings, op)).toBe("At most 8 buses can be metered");
    expect(applyOpToDraft(base, op)).toBe(base);
  });
});
