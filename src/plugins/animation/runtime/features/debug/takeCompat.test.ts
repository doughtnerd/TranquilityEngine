// What changed since a take recorded an Animator (T73): each kind of change gets its sentence, and poses are offered only
// when the graph's bytes and the bone count are as they were.
import { describe, expect, it } from "vitest";
import type { CompiledAnimGraph } from "../../../../../engine/animation/graphCompile";
import { compareGraph } from "./takeCompat";
import type { TakeTargetInfo } from "./takeRecords";

const tables = (over: Partial<CompiledAnimGraph> = {}): CompiledAnimGraph => ({
  bytes: null, ok: true, problems: [], strings: [], bindings: [], nodes: [], parameters: ["x", "moving"], machines: [{ node: "m", states: ["Idle", "Walk"] }],
  slots: [], linked: [], layers: ["Base"], ikTargets: [], rays: 0, transitions: [], conditions: [], ...over,
});
const recorded: TakeTargetInfo = { id: 0, label: "Hero", graph: "hero.animgraph.json", graphHash: 11, bones: 12, tables: tables() };

describe("compareGraph", () => {
  it("is quiet and allows poses when the graph is as recorded", () => {
    expect(compareGraph(recorded, { graphHash: 11, tables: tables(), bones: 12 })).toEqual({ poses: true, notes: [] });
  });

  it("names parameters, layers, slots and states that went or came, and refuses poses", () => {
    const now = tables({ parameters: ["x", "speed"], layers: ["Base", "Upper"], machines: [{ node: "m", states: ["Idle", "Run"] }], slots: ["Attack"] });
    const r = compareGraph(recorded, { graphHash: 12, tables: now, bones: 12 });
    expect(r.poses).toBe(false);
    expect(r.notes).toEqual(expect.arrayContaining([
      'The parameter "moving" is gone from the graph.',
      'The graph has a new parameter "speed".',
      'The graph has a new layer "Upper".',
      'The graph has a new slot "Attack".',
      'The state "m/Walk" is gone from the graph.',
      'The graph has a new state "m/Run".',
    ]));
    expect(r.notes.at(-1)).toContain("Poses can't be re-evaluated");
  });

  it("says the logic changed when only the bytes differ", () => {
    const r = compareGraph(recorded, { graphHash: 99, tables: tables(), bones: 12 });
    expect(r.poses).toBe(false);
    expect(r.notes[0]).toContain("logic changed");
  });

  it("refuses poses for another bone count, and shows the recorded states for a graph that is gone or changed while recording", () => {
    const bones = compareGraph(recorded, { graphHash: 11, tables: tables(), bones: 20 });
    expect(bones.poses).toBe(false);
    expect(bones.notes[0]).toContain("20 bones");
    const gone = compareGraph(recorded, null);
    expect(gone.poses).toBe(false);
    expect(gone.notes[0]).toContain("isn't loaded");
    expect(compareGraph(recorded, { graphHash: 11, tables: tables(), bones: 12 }, true).notes[0]).toContain("changed while the take was recording");
  });
});
