// ADR 0175: one row per bus capability rule, asserting together what used to be checked in several places: the parse's
// severity and text, the live answer on the core (`LiveMix` through
// `mixer.apply`, counted; ADR 0221: the production assembly on the loopback) and on the fallback's capabilities, and the
// one message. The wire's `BUS_SLOT_MAX_EFFECTS` is held equal to the rule's limit here, from the plugin side (the engine
// can't import the wire).
import { afterEach, describe, expect, it } from "vitest";
import {
  BUS_RULES, FALLBACK_LIVE_CAPS, MAX_BUSES, MAX_CORE_BUS_EFFECTS, atBusLimit, reasonMessage, type BusRule,
} from "../../../engine/audio/busCapability";
import { Mixer, type MixOpTarget } from "../../../engine/audio/mixer";
import { opRefusal, type ApplyResult, type MixOp } from "../../../engine/audio/mixOps";
import { parseAudioSettings, type BusEffect } from "../../../engine/audio/settings";
import { BUS_SLOT_MAX_EFFECTS } from "../runtime/wire.generated";
import { closeLoopbackAudio, loopbackAudio } from "../runtime/testing";

/**
 * ADR 0221: the core as production assembles it, on the loopback (`loopbackAudio`), over the page's mixer configured with
 * `audio` and the backend registered, so the refusal count is read where callers read it (`Audio.debug().mix.liveRefused`).
 * Null when the wasm can't be loaded here.
 */
function coreRig(audio: object) {
  return loopbackAudio({ settings: parseAudioSettings(audio).settings });
}

afterEach(closeLoopbackAudio);

/** The fallback's answers: a mixer whose target has `FALLBACK_LIVE_CAPS` and applies what it is sent. */
function fallbackApply(audio: object, op: MixOp): ApplyResult {
  const mixer = new Mixer(parseAudioSettings(audio).settings);
  const target: MixOpTarget = { liveCaps: FALLBACK_LIVE_CAPS, sendOp: (o, cls) => (mixer._applyLive(o), { ok: true, class: cls }) };
  mixer._setOpTarget(target);
  return mixer.apply(op);
}

const lp: BusEffect = { type: "lowpass", frequency: 1000, q: 1 };
const comp: BusEffect = { type: "compressor", threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 };
const bus = (effects: BusEffect[]) => ({ buses: [{ name: "Master" }, { name: "Fx", parent: "Master", effects }] });
const many = (n: number) => ({ buses: [{ name: "Master" }, ...Array.from({ length: n - 1 }, (_, i) => ({ name: `B${i + 1}`, parent: "Master" }))] });

interface Row {
  rule: BusRule;
  /** A section past the limit (the parse's case), and its finding. */
  over: object;
  finding: string;
  /** A section at the limit and the ops that take it past (each with the class the core answers). */
  at: object;
  ops: [MixOp, ApplyResult["class"]][];
}

const CAPPED_BY_INSERTS: BusRule[] = ["effectsPerBus", "compressorsPerBus"];

const ROWS: Row[] = [
  {
    rule: "busCount",
    over: many(MAX_BUSES + 1),
    finding: `audio.buses: at most ${MAX_BUSES} buses; the rest are ignored.`,
    at: many(MAX_BUSES),
    ops: [[{ op: "addBus", name: "Late", parent: "Master" }, "none"]],
  },
  {
    rule: "insertsPerBus",
    over: bus([lp, lp, lp, lp, lp, lp, lp, lp, lp]),
    finding: "audio.buses[1]: a bus holds at most 8 effects; the rest are ignored.",
    at: bus([lp, lp, lp, lp, lp, lp, lp, lp]),
    ops: [[{ op: "addEffect", bus: "Fx", index: 8, effect: lp }, "none"]],
  },
  {
    // ADR 0344 (ABI 4.7): the core's post-fader sends a bus. The live case is `audio.json`'s (a send names a return).
    rule: "sendsPerBus",
    over: { buses: [{ name: "Master" }, { name: "Fx", parent: "Master", sends: ["R1", "R2", "R3", "R4", "R5"].map((to) => ({ to, level: 0.5 })) }, ...["R1", "R2", "R3", "R4", "R5"].map((name) => ({ name, parent: "Master" }))] },
    finding: "audio.buses[1]: a bus runs at most 4 sends; the edit is saved and applies at the next Play, where only the first 4 sends of the list run.",
    at: {
      mix: {
        format: "myco.audio@1",
        buses: [{ name: "Master" }, { name: "Fx", parent: "Master", sends: ["R1", "R2", "R3", "R4"].map((to) => ({ to, levelDb: -6 })) }],
        returns: ["R1", "R2", "R3", "R4", "R5"].map((name) => ({ name, output: "Master" })),
      },
    },
    ops: [[{ op: "setSend", bus: "Fx", to: "R5", levelDb: -6 }, "direct"]],
  },
];

describe("bus capability rules (ADR 0175)", () => {
  it("the core's effect limit is the wire's BUS_SLOT_MAX_EFFECTS", () => {
    expect(MAX_CORE_BUS_EFFECTS).toBe(BUS_SLOT_MAX_EFFECTS);
    expect(BUS_RULES.effectsPerBus.limit).toBe(BUS_SLOT_MAX_EFFECTS);
  });

  it("covers every rule", () => {
    expect([...ROWS.map((r) => r.rule), ...CAPPED_BY_INSERTS].sort()).toEqual(Object.keys(BUS_RULES).sort());
  });

  // ABI 4.6 (ADR 0345): the core runs 8 effects a bus and any number of compressors, so these two limits equal the insert
  // cap and its refusal always comes first; they stay as rules (a warning a smaller backend could raise) but never fire here.
  it.for(CAPPED_BY_INSERTS)("%s: its limit is the insert cap, so a full chain reports only the insert cap", (rule) => {
    expect(BUS_RULES[rule].limit).toBe(BUS_RULES.insertsPerBus.limit);
    const full = parseAudioSettings(bus([comp, comp, comp, comp, comp, comp, comp, comp]));
    expect([...full.problems, ...full.warnings]).toEqual([]);
    const over = parseAudioSettings(bus([comp, comp, comp, comp, comp, comp, comp, comp, comp]));
    expect(over.problems).toEqual(["audio.buses[1]: a bus holds at most 8 effects; the rest are ignored."]);
    expect(over.warnings).toEqual([]);
  });

  it.for(ROWS)("$rule: parse severity, the live answer on the core and the fallback, and the message", { timeout: 30_000 }, async ({ rule, over, finding, at, ops }, ctx) => {
    const spec = BUS_RULES[rule];
    // The parse: a problem drops the rest; a warning keeps the section as authored (R10).
    const parsed = parseAudioSettings(over);
    expect(spec.parse === "problem" ? parsed.problems : parsed.warnings).toEqual([finding]);
    expect(spec.parse === "problem" ? parsed.warnings : parsed.problems).toEqual([]);
    expect(finding).toContain(spec.message);
    // At the limit the rule reports nothing (and nothing at all, but the core's own limit under the insert cap's).
    const atLimit = parseAudioSettings(at);
    expect([...atLimit.problems, ...atLimit.warnings].some((m) => m.includes(spec.message))).toBe(false);
    expect(atLimit.problems).toEqual([]);
    if (rule !== "insertsPerBus") expect(atLimit.warnings).toEqual([]);

    for (const [op, cls] of ops) {
      const core = await coreRig(at);
      if (!core) return ctx.skip();
      const { Audio, mixer } = core;
      const before = mixer.audioSettings;
      const r = mixer.apply(op);
      expect(mixer.audioSettings, "the running model is untouched").toBe(before);
      expect(Audio.debug().mix!.liveRefused, "counted (Audio.debug().mix.liveRefused)").toBe(1);
      const fallback = fallbackApply(at, op);
      if (spec.live === "refused") {
        expect(r).toEqual({ ok: false, class: "none" });
        expect(opRefusal(before, op)).toBe(`${spec.message[0]!.toUpperCase()}${spec.message.slice(1)}.`);
        expect(fallback).toEqual({ ok: false, class: "none" });
      } else {
        expect(r).toEqual({ ok: false, class: cls, reason: rule });
        expect(reasonMessage(r.reason!)).toBe(spec.message);
        // Only the core has the limit: the fallback runs every effect.
        expect(fallback).toEqual(spec.coreOnly ? { ok: true, class: cls } : r);
      }
      await core.close();
    }
  });

  it("atBusLimit follows the bus count rule", () => {
    expect(atBusLimit(parseAudioSettings(many(MAX_BUSES - 1)).settings)).toBe(false);
    expect(atBusLimit(parseAudioSettings(many(MAX_BUSES)).settings)).toBe(true);
  });
});
