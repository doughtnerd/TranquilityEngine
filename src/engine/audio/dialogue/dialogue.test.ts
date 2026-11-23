import { describe, expect, it } from "vitest";
import { argumentValues, candidateOrder, compareBestMatch, decide, rememberLine, type DecideContext } from "./decide";
import { dialogueToJson, emptyDialogueEvent, formatDialogue, parseDialogue, DIALOGUE_LIMITS } from "./format";
import type { DialogueEvent } from "./types";

/** A seeded generator (mulberry32), as the World's. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A generator that returns the given numbers in turn (then 0). */
const scripted = (...values: number[]) => () => values.shift() ?? 0;

const ADR = {
  format: "myco.dialogue@1",
  events: [{
    name: "enemy_spotted",
    arguments: [
      { name: "speaker", labels: ["Guard", "Captain", "Sniper"] },
      { parameter: "weather" },
      { name: "distance", labels: ["Near", "Far"], default: "Near" },
    ],
    mode: "bestMatch",
    paths: [
      { path: ["Guard", "*", "Near"], lines: [{ key: "guard_spot_near_01", weight: 2 }, { key: "guard_spot_near_02" }] },
      { path: ["Guard", "Rain", "*"], lines: [{ key: "guard_spot_rain_01" }], probability: 0.5 },
      { path: ["Sniper", "*", "*"], lines: [] },
      { path: ["*", "*", "*"], lines: [{ key: "generic_spot_01" }, { key: "generic_spot_02" }] },
    ],
    priority: 60,
    whenBusy: "queue",
    interrupt: "lower",
    maxWait: 2.5,
    cooldown: 4,
    avoidRepeat: 2,
  }],
};

const event = (): DialogueEvent => parseDialogue(ADR).dialogue.events[0];
const weather = (label: string | null): Pick<DecideContext, "parameter" | "parameterLabels"> => ({ parameter: () => label, parameterLabels: () => ["Clear", "Rain", "Snow"] });

describe("dialogue format", () => {
  it("parses the record's example and round-trips", () => {
    const { dialogue, problems } = parseDialogue(ADR, "audio/barks.dialogue.json");
    expect(problems).toEqual([]);
    const e = dialogue.events[0];
    expect(e.arguments).toEqual([
      { kind: "local", name: "speaker", labels: ["Guard", "Captain", "Sniper"], default: "Guard" },
      { kind: "parameter", parameter: "weather" },
      { kind: "local", name: "distance", labels: ["Near", "Far"], default: "Near" },
    ]);
    expect(e.paths[2].lines).toEqual([]);
    expect(e).toMatchObject({ priority: 60, maxWait: 2.5, cooldown: 4, chance: 1, avoidRepeat: 2, skipMissing: true, onInterrupted: null });
    expect(parseDialogue(dialogueToJson(dialogue))).toEqual({ dialogue, problems: [] });
    // Defaults are left out: the mode, whenBusy and interrupt, and a default that is the first label.
    const { mode: _m, whenBusy: _w, interrupt: _i, ...written } = ADR.events[0];
    expect(dialogueToJson(dialogue).events).toEqual([{ ...written, arguments: [written.arguments[0], written.arguments[1], { name: "distance", labels: ["Near", "Far"] }] }]);
    expect(formatDialogue({ format: "myco.dialogue@1", events: [emptyDialogueEvent("x")] })).toBe('{\n  "format": "myco.dialogue@1",\n  "events": [\n    {\n      "name": "x",\n      "arguments": [],\n      "paths": []\n    }\n  ]\n}\n');
  });

  it("repairs events, arguments and paths, one problem each", () => {
    const { dialogue, problems } = parseDialogue({
      format: "myco.dialogue@1",
      events: [
        { name: "bad name!" },
        {
          name: "e",
          arguments: [{ name: "a", labels: ["X", "X", "*", "Y"], default: "Z" }, { name: "a", labels: ["Q"] }, { parameter: "" }, { name: "b", labels: [] }],
          paths: [{ path: ["X", "extra"], lines: ["k1", { key: "k 2" }] }, { path: ["X"], lines: [] }, { path: [] }, { path: ["W"], lines: [{ key: "k", weight: 500 }] }],
          avoidRepeat: 20, onInterrupted: "e", whenBusy: "never",
        },
        { name: "e" },
      ],
    }, "d");
    const e = dialogue.events[0];
    expect(dialogue.events).toHaveLength(1);
    expect(e.arguments).toEqual([{ kind: "local", name: "a", labels: ["X", "Y"], default: "X" }]);
    expect(e.paths.map((p) => p.path)).toEqual([["X"], ["*"], ["W"]]);
    expect(e.paths[0].lines).toEqual([{ key: "k1", weight: 1 }]);
    expect(e.paths[2].lines).toEqual([{ key: "k", weight: 100 }]);
    expect(e.avoidRepeat).toBe(DIALOGUE_LIMITS.avoidRepeat);
    expect(problems).toEqual([
      'd.events[0].name: "bad name!" isn\'t an event name (letters, digits, _ . -, at most 64); dropped.',
      'd.events[1].arguments[0].labels[1]: "X" is listed twice; dropped.',
      "d.events[1].arguments[0].labels[2]: must be a label (not empty, not *); dropped.",
      'd.events[1].arguments[0].default: "Z" isn\'t one of its labels; using "X".',
      'd.events[1].arguments[1].name: "a" is already an argument of this event; dropped.',
      "d.events[1].arguments[2].parameter: must name a global labelled parameter; dropped.",
      "d.events[1].arguments[3].labels: a local argument needs at least one label; dropped.",
      "d.events[1].paths[0].path: has 2 entries for 1 arguments; the rest are dropped.",
      "d.events[1].paths[0].lines[1]: must be { key, weight } with a line key; dropped.",
      "d.events[1].paths[1]: [X] is already a path of this event; dropped.",
      "d.events[1].paths[2].path: has 0 entries for 1 arguments; filled with *.",
      "d.events[1].paths[2].lines: missing; read as [] (an explicit silence).",
      'd.events[1].paths[3].path[0]: "W" isn\'t a label of "a"; it matches nothing.',
      "d.events[1].paths[3].lines[0].weight: 500 is outside 0..100; using 100.",
      'd.events[1].whenBusy: must be one of queue, interrupt, drop; using "queue".',
      `d.events[1].avoidRepeat: 20 is outside 0..${DIALOGUE_LIMITS.avoidRepeat}; using ${DIALOGUE_LIMITS.avoidRepeat}.`,
      "d.events[1].onInterrupted: an event can't follow its own interruption; using null.",
      'd.events[2].name: "e" is used twice; dropped.',
    ]);
  });

  it("never throws on junk", () => {
    for (const junk of [null, 1, "x", [], { events: {} }, { events: [null, { name: "a", arguments: "x", paths: [1, { path: "x" }] }] }]) {
      expect(() => parseDialogue(junk)).not.toThrow();
    }
  });
});

describe("decide: values and best-match order", () => {
  it("takes args, then the global's label, then the default; a bad value matches only *", () => {
    const warnings: string[] = [];
    expect(argumentValues(event(), { speaker: "Captain" }, { ...weather("Snow"), warn: (w) => warnings.push(w) })).toEqual({ speaker: "Captain", weather: "Snow", distance: "Near" });
    expect(argumentValues(event(), { speaker: "Pirate", weather: "Fog" }, { ...weather("Rain"), warn: (w) => warnings.push(w) })).toEqual({ speaker: null, weather: null, distance: "Near" });
    expect(warnings).toEqual(['enemy_spotted: "Pirate" isn\'t a label of "speaker"; it matches only *.', 'enemy_spotted: "Fog" isn\'t a label of "weather"; it matches only *.']);
    expect(argumentValues(event(), {}, {})).toEqual({ speaker: "Guard", weather: null, distance: "Near" });
  });

  it("puts an exact label before * at the first argument where paths differ", () => {
    const table: [string[], string[], number][] = [
      [["Guard", "*", "*"], ["*", "Rain", "Near"], -1],
      [["*", "Rain", "Near"], ["Guard", "*", "*"], 1],
      [["Guard", "Rain", "*"], ["Guard", "*", "Near"], -1],
      [["Guard", "*", "Near"], ["Guard", "*", "*"], -1],
      [["*", "*", "*"], ["*", "*", "Near"], 1],
      [["Guard", "Rain", "Near"], ["Guard", "Rain", "Near"], 0],
    ];
    for (const [a, b, want] of table) expect(Math.sign(compareBestMatch(a, b)), `${a} vs ${b}`).toBe(want);
  });

  it("orders the candidates of the record's example", () => {
    const e = event();
    expect(candidateOrder(e, { speaker: "Guard", weather: "Rain", distance: "Near" }, Math.random)).toEqual([1, 0, 3]);
    expect(candidateOrder(e, { speaker: "Guard", weather: "Clear", distance: "Far" }, Math.random)).toEqual([3]);
    expect(candidateOrder(e, { speaker: "Sniper", weather: null, distance: "Near" }, Math.random)).toEqual([2, 3]);
    expect(candidateOrder(e, { speaker: null, weather: "Rain", distance: "Near" }, Math.random)).toEqual([3]);
  });
});

describe("decide: picks", () => {
  it("takes the best match when its probability passes, else falls back", () => {
    // Guard, Rain, Near: [Guard, Rain, *] first (probability 0.5), then [Guard, *, Near].
    const pass = decide(event(), { speaker: "Guard", distance: "Near" }, { ...weather("Rain"), rng: scripted(0.2, 0.1) });
    expect(pass).toMatchObject({ key: "guard_spot_rain_01", pathIndex: 1 });
    const fail = decide(event(), { speaker: "Guard", distance: "Near" }, { ...weather("Rain"), rng: scripted(0.7, 0.9) });
    expect(fail).toMatchObject({ key: "guard_spot_near_02", pathIndex: 0 });
    expect(fail.trace.tried).toEqual([{ pathIndex: 1, outcome: "probability" }, { pathIndex: 0, outcome: "picked" }]);
  });

  it("ends with an explicit silence, and reports no match", () => {
    expect(decide(event(), { speaker: "Sniper" }, { rng: Math.random })).toMatchObject({ none: "silence", pathIndex: 2 });
    const noGeneric = { ...event(), paths: event().paths.slice(0, 2) };
    expect(decide(noGeneric, { speaker: "Captain" }, { rng: Math.random })).toMatchObject({ none: "noMatch", pathIndex: null });
  });

  it("falls back past unavailable and unrecorded lines (skipMissing), and reports unavailable", () => {
    const args = { speaker: "Guard", distance: "Near" };
    const recordedOnly = (keys: string[]) => (k: string) => keys.includes(k);
    const r1 = decide(event(), args, { ...weather("Clear"), rng: seeded(1), recorded: recordedOnly(["generic_spot_02"]) });
    expect(r1).toMatchObject({ key: "generic_spot_02", pathIndex: 3 });
    expect(r1.trace.tried).toEqual([{ pathIndex: 0, outcome: "unavailable" }, { pathIndex: 3, outcome: "picked" }]);
    const lenient = { ...event(), skipMissing: false };
    expect(decide(lenient, args, { ...weather("Clear"), rng: seeded(1), recorded: () => false })).toMatchObject({ pathIndex: 0 });
    expect(decide(event(), args, { ...weather("Clear"), rng: seeded(1), available: () => false })).toMatchObject({ none: "unavailable", pathIndex: null });
  });

  it("draws lines by weight from the seeded generator", () => {
    const counts: Record<string, number> = {};
    const rng = seeded(42);
    const e = { ...event(), avoidRepeat: 0 };
    for (let i = 0; i < 3000; i++) {
      const r = decide(e, { speaker: "Guard", distance: "Near" }, { ...weather("Clear"), rng });
      if ("key" in r) counts[r.key] = (counts[r.key] ?? 0) + 1;
    }
    expect(counts.guard_spot_near_01 / 3000).toBeCloseTo(2 / 3, 1);
    expect(counts.guard_spot_near_02 / 3000).toBeCloseTo(1 / 3, 1);
  });

  it("avoids repeating the event's last lines, as the Queue pick does", () => {
    const e = { ...event(), avoidRepeat: 1 };
    const args = { speaker: "Captain" };
    let history: string[] = [];
    const rng = seeded(7);
    const spoken: string[] = [];
    for (let i = 0; i < 40; i++) {
      const r = decide(e, args, { rng, history });
      if (!("key" in r)) throw new Error("expected a line");
      spoken.push(r.key);
      history = rememberLine(history, r.key);
    }
    // Two lines and avoid-repeat 1: they alternate.
    expect(spoken.every((k, i) => i === 0 || k !== spoken[i - 1])).toBe(true);
    expect(rememberLine(Array.from({ length: 8 }, (_, i) => `k${i}`), "new")).toEqual(["k1", "k2", "k3", "k4", "k5", "k6", "k7", "new"]);
  });

  it("lets the ban give way when only banned lines are available", () => {
    const r = decide({ ...event(), avoidRepeat: 2 }, { speaker: "Captain" }, { rng: seeded(3), history: ["generic_spot_01"], available: (k) => k === "generic_spot_01" });
    expect(r).toMatchObject({ key: "generic_spot_01" });
  });

  it("draws a weighted-mode path by weight, the rest after it in best-match order", () => {
    const e: DialogueEvent = {
      ...emptyDialogueEvent("w"), mode: "weighted", avoidRepeat: 0,
      arguments: [{ kind: "local", name: "a", labels: ["X", "Y"], default: "X" }],
      paths: [
        { path: ["X"], lines: [{ key: "exact", weight: 1 }], probability: 1, weight: 1 },
        { path: ["*"], lines: [{ key: "any", weight: 1 }], probability: 1, weight: 3 },
      ],
    };
    const rng = seeded(99);
    const counts = { exact: 0, any: 0 };
    for (let i = 0; i < 4000; i++) {
      const r = decide(e, {}, { rng });
      if ("key" in r) counts[r.key as "exact" | "any"]++;
    }
    expect(counts.any / 4000).toBeCloseTo(0.75, 1);
    expect(candidateOrder(e, { a: "X" }, scripted(0.9))).toEqual([1, 0]);
    expect(candidateOrder(e, { a: "X" }, scripted(0.1))).toEqual([0, 1]);
    // Falls back to the other path when the drawn one has nothing available.
    expect(decide(e, {}, { rng: scripted(0.9, 0), available: (k) => k === "exact" })).toMatchObject({ key: "exact" });
  });

  it("is deterministic for a seed and the same data", () => {
    const run = (seed: number) => {
      const rng = seeded(seed);
      let history: string[] = [];
      const out: string[] = [];
      for (const speaker of ["Guard", "Captain", "Guard", "Sniper", "Guard", "Captain", "Guard", "Guard"]) {
        const r = decide(event(), { speaker, distance: "Near" }, { ...weather("Rain"), rng, history });
        out.push("key" in r ? r.key : `(${r.none})`);
        if ("key" in r) history = rememberLine(history, r.key);
      }
      return out;
    };
    expect(run(2026)).toEqual(run(2026));
    expect(run(2026)).not.toEqual(run(1));
  });
});
