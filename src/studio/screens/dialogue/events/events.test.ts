// ADR 0341 §7: the Events tab through its models — coverage as compact patterns (gaps, intended silence, per language,
// unused lines, CSV), the test bench's highlighting with reasons and Roll ×50 over a seeded generator, the path table
// and argument edits with their impact, tree grouping and lints.
import { describe, expect, it } from "vitest";
import { parseDialogue } from "../../../../engine/audio/dialogue/format";
import type { DialogueEvent } from "../../../../engine/audio/dialogue/types";
import { fixtureDialogue } from "../dialogueFixture";
import { parseCsv } from "../csv";
import { coverageCsv, eventCoverage, unnamedEvents, unusedLines } from "./coverage";
import {
  addEvent, addPath, applyArgumentChange, changeArgument, deleteEvent, duplicateEvent, eventList, pathLints, pathTree, renameEvent, setEventSettings, setPathEntry, setPathLines,
  usedEventNames, type EventContext,
} from "./eventsModel";
import { bench, FROM_GLOBAL, roll } from "./testBench";

const ctx: EventContext = { parameterLabels: (name) => (name === "weather" ? ["Clear", "Rain", "Fog"] : null) };
const spotted = (): DialogueEvent => fixtureDialogue().events[0];
const all = () => true;

describe("coverage", () => {
  it("reports the combinations with no line as compact patterns, and intended silence", () => {
    const c = eventCoverage(spotted(), ctx, [], all);
    expect(c.gaps).toEqual(["Captain · * · *", "Guard · Clear · Far", "Guard · Fog · Far"]);
    expect(c.silences).toEqual(["Sniper · * · *"]);
    expect(c.truncated).toBe(false);
  });

  it("merges sibling patterns that cover every label into *", () => {
    const e = parseDialogue({ format: "myco.dialogue@1", events: [{ name: "e", arguments: [{ name: "a", labels: ["X", "Y"] }, { name: "b", labels: ["P", "Q"] }], paths: [{ path: ["X", "P"], lines: [{ key: "k" }] }] }] }).dialogue.events[0];
    expect(eventCoverage(e, ctx, [], all).gaps).toEqual(["X · Q", "Y · *"]);
    const wide = parseDialogue({ format: "myco.dialogue@1", events: [{ name: "e", arguments: [{ name: "a", labels: ["X", "Y"] }, { name: "b", labels: ["P", "Q"] }], paths: [{ path: ["*", "P"], lines: [{ key: "k" }] }] }] }).dialogue.events[0];
    expect(eventCoverage(wide, ctx, [], all).gaps).toEqual(["* · Q"]);
  });

  it("lists, per language, combinations whose candidate lines are all missing in it", () => {
    const frHas = new Set(["intro_01"]);
    const c = eventCoverage(spotted(), ctx, ["fr", "en"], (key, code) => code === "en" || frHas.has(key));
    expect(c.languages.fr).toEqual(["Guard · Clear · Near", "Guard · Fog · Near"]);
    expect(c.languages.en).toEqual([]);
  });

  it("finds unused lines and events no script names, and exports CSV", () => {
    const docs = [{ path: "dialogue/barks.dialogue.json", asset: fixtureDialogue() }];
    expect(unusedLines(["intro_01", "intro_02", "guard_01", "breath_03"], docs)).toEqual(["breath_03"]);
    expect(unnamedEvents(docs, new Map([["scripts/a.ts", "Audio.say('other')"]]))).toEqual(["enemy_spotted"]);
    expect(unnamedEvents(docs, new Map([["scripts/a.ts", 'Audio.say("enemy_spotted", { args })']]))).toEqual([]);
    const rows = parseCsv(coverageCsv([eventCoverage(spotted(), ctx, [], all)], ["breath_03"], []));
    expect(rows[0]).toEqual(["event", "kind", "language", "pattern"]);
    expect(rows).toContainEqual(["enemy_spotted", "no line", "", "Captain · * · *"]);
    expect(rows).toContainEqual(["", "unused line", "", "breath_03"]);
  });
});

describe("test bench", () => {
  it("highlights the picked path and the fallbacks in order, with reasons", () => {
    const v = bench(spotted(), { speaker: "Guard", weather: "Rain", distance: "Near" }, { seed: 7 });
    // At the first argument where they differ (weather), Guard·Rain·* is exact and Guard·*·Near is `*`: Rain goes first.
    expect(v.rows.map((r) => [r.pathIndex, r.rank])).toEqual([[0, 2], [1, 1], [2, null]]);
    expect(v.rows[2]).toMatchObject({ role: "unmatched", reason: "Sniper isn't speaker = Guard" });
    // Path 1 has a 50% probability: some seeds pass it over, and path 0 then says the line.
    const roles = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const w = bench(spotted(), { speaker: "Guard", weather: "Rain", distance: "Near" }, { seed });
      roles.add(`${w.rows[1].role}/${w.rows[0].role}`);
      if (w.rows[1].role === "passed") expect(w.rows[1].reason).toBe("passed over by its probability (50%)");
      else expect(w.rows[0].reason).toBe("fallback 2: tried when the paths before it have no line to say");
    }
    expect([...roles].sort()).toEqual(["passed/picked", "picked/fallback"]);
    expect(v.summary).toMatch(/^Says (intro_01|guard_01|intro_02) \(path Guard · /);
  });

  it("passes over a path whose lines aren't available or recorded, and says why", () => {
    const v = bench(spotted(), { speaker: "Guard", weather: "Clear", distance: "Near" }, { seed: 1, recorded: (k) => k !== "guard_01" && k !== "intro_02" });
    expect(v.rows[0]).toMatchObject({ role: "passed", reason: "no line available (guard_01 not recorded, intro_02 not recorded)" });
    expect(v.result).toMatchObject({ none: "unavailable" });
    expect(v.summary).toContain("none has a line available");
  });

  it("stops at an explicit silence and leaves values that aren't labels to *", () => {
    const v = bench(spotted(), { speaker: "Sniper", weather: FROM_GLOBAL, distance: "Far" }, { seed: 1 });
    expect(v.result).toMatchObject({ none: "silence" });
    expect(v.rows[2]).toMatchObject({ role: "silence" });
    const odd = bench(spotted(), { speaker: "Nobody" }, { seed: 1 });
    expect(odd.rows[0].reason).toBe("speaker matches only *");
  });

  it("rolls ×50 from a seed: the same seed gives the same bars, avoid-repeat shapes them", () => {
    const e = spotted();
    const a = roll(e, { speaker: "Guard", weather: "Clear", distance: "Near" }, { seed: 42 });
    expect(a).toEqual(roll(e, { speaker: "Guard", weather: "Clear", distance: "Near" }, { seed: 42 }));
    expect(a.reduce((n, b) => n + b.count, 0)).toBe(50);
    // avoidRepeat 1 over two lines alternates them exactly.
    expect(a.map((b) => [b.outcome, b.count])).toEqual([["guard_01", 25], ["intro_02", 25]]);
    const once = roll({ ...e, avoidRepeat: 0 }, { speaker: "Guard", weather: "Clear", distance: "Near" }, { seed: 42 });
    expect(once[0].outcome).toBe("guard_01"); // weight 2 against 1
    expect(once[0].count).toBeGreaterThan(25);
    expect(roll(e, { speaker: "Captain" }, { seed: 3 })).toEqual([{ outcome: "noMatch", count: 50, share: 1, said: false }]);
  });
});

describe("path table and arguments", () => {
  it("edits events with project-unique names, and paths without duplicates", () => {
    const a = fixtureDialogue();
    const used = usedEventNames([{ path: "d.dialogue.json", asset: a }]);
    const added = addEvent(a, used);
    expect("next" in added && added.next.events[1].name).toBe("new_event");
    expect(renameEvent(a, "enemy_spotted", "new_event", new Set(["new_event"]))).toEqual({ refused: '"new_event" is already an event in this project' });
    const withRef = { ...a, events: [...a.events, { ...a.events[0], name: "b", onInterrupted: "enemy_spotted" }] };
    const renamed = renameEvent(withRef, "enemy_spotted", "spotted", new Set(["enemy_spotted", "b"]));
    expect("next" in renamed && renamed.next.events.map((e) => [e.name, e.onInterrupted])).toEqual([["spotted", null], ["b", "spotted"]]);
    expect("next" in duplicateEvent(a, "enemy_spotted", used) && (duplicateEvent(a, "enemy_spotted", used) as { next: typeof a }).next.events[1].name).toBe("enemy_spotted_2");
    expect("next" in deleteEvent(a, "enemy_spotted") && (deleteEvent(a, "enemy_spotted") as { next: typeof a }).next.events).toEqual([]);
    expect(addPath(a, "enemy_spotted", ["Sniper", "*", "*"])).toEqual({ refused: "the path Sniper · * · * is already in the table" });
    expect(setPathEntry(a, "enemy_spotted", 0, 1, "Rain")).toMatchObject({ next: expect.anything() });
    expect(setPathEntry(a, "enemy_spotted", 0, 0, "Sniper")).toMatchObject({ next: expect.anything() });
    expect(setPathLines(a, "enemy_spotted", 0, [{ key: "x", weight: 1 }, { key: "x", weight: 2 }])).toEqual({ refused: "a line is on the path twice" });
    expect(setEventSettings(a, "enemy_spotted", { chance: 2 })).toEqual({ refused: "chance is 0 to 1" });
    expect(eventList([{ path: "d.dialogue.json", asset: a }], "SPOT").map((r) => r.event.name)).toEqual(["enemy_spotted"]);
  });

  it("previews what an argument change does to the paths before applying it", () => {
    const e = spotted();
    const removeLabel = changeArgument(e, { kind: "labels", arg: 1, labels: ["Clear", "Fog"] }, ctx);
    expect("next" in removeLabel && removeLabel.next.impact).toEqual({ rewritten: [], removed: [{ index: 1, why: 'names "Rain", which is removed' }] });
    const renameLabel = changeArgument(e, { kind: "labels", arg: 1, labels: ["Clear", "Storm", "Fog"], renamed: { Rain: "Storm" } }, ctx);
    expect("next" in renameLabel && renameLabel.next.impact.rewritten).toEqual([{ index: 1, to: ["Guard", "Storm", "*"] }]);
    const drop = changeArgument(e, { kind: "remove", arg: 2 }, ctx);
    expect("next" in drop && drop.next.event.paths.map((p) => p.path)).toEqual([["Guard", "*"], ["Guard", "Rain"], ["Sniper", "*"]]);
    const move = applyArgumentChange(fixtureDialogue(), "enemy_spotted", { kind: "move", arg: 2, to: 0 }, ctx);
    expect("next" in move && move.next.events[0].paths[0].path).toEqual(["Near", "Guard", "*"]);
    const merge = changeArgument(e, { kind: "remove", arg: 0 }, ctx);
    expect("next" in merge && merge.next.impact.removed).toEqual([]);
    expect(changeArgument(e, { kind: "link", parameter: "weather" }, ctx)).toEqual({ refused: 'the event already has an argument "weather"' });
    expect(changeArgument(e, { kind: "link", parameter: "nope" }, ctx)).toEqual({ refused: '"nope" isn\'t a global labelled parameter' });
  });

  it("groups the table as a tree and lints it", () => {
    const e = spotted();
    const tree = pathTree(e, ctx);
    expect(tree.map((n) => [n.label, n.paths])).toEqual([["Guard", [0, 1]], ["Sniper", [2]]]);
    expect(tree[0].children.map((n) => n.label)).toEqual(["Rain", "*"]);
    const shadowed = { ...e, paths: [...e.paths, { path: ["Guard", "*", "*"], lines: [{ key: "ghost", weight: 1 }], probability: 1, weight: 1 }, { path: ["Guard", "Clear", "Far"], lines: [], probability: 1, weight: 1 }, { path: ["Guard", "Fog", "Far"], lines: [], probability: 1, weight: 1 }] };
    const lints = pathLints(shadowed, ctx, new Set(["guard_01", "intro_02", "intro_01"]));
    expect(lints).toContainEqual({ index: 3, message: 'no line "ghost"' });
    expect(lints).toContainEqual({ index: 3, message: "reached only as a fallback: every label under its * is taken by a more specific path" });
    expect(lints.some((l) => l.index === 0 && l.message.startsWith("reached only"))).toBe(false);
  });
});
