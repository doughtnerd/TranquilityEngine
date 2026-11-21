import { describe, expect, it } from "vitest";
import { TextHistory } from "./TextHistory";

/** The text of every state, by visiting each. */
function texts(h: TextHistory): Map<number, string> {
  const back = h.current;
  const out = new Map<number, string>();
  for (const s of h.allStates) {
    if (s.seq !== h.current) expect(h.jumpTo(s.seq)).toBe(true);
    out.set(s.seq, h.text);
  }
  h.jumpTo(back);
  return out;
}

describe("TextHistory (ADR 0027 over an asset's text)", () => {
  it("records steps as text patches and undoes and redoes them", () => {
    const h = new TextHistory('{"n":1}', "a.json");
    expect(h.record("one", '{"n":1}')).toBe(false); // no change
    h.record("two", '{"n":2}');
    h.record("three", '{"n":3}');
    expect(h.allStates.at(-1)!.files).toEqual([{ path: "a.json", start: 5, before: "2", after: "3" }]);
    expect(h.undo()).toBe(true);
    expect(h.text).toBe('{"n":2}');
    h.undo();
    expect([h.text, h.canUndo, h.canRedo]).toEqual(['{"n":1}', false, true]);
    h.redo();
    h.redo();
    expect([h.text, h.canRedo]).toEqual(['{"n":3}', false]);
  });

  it("keeps the undone branch when editing after undo, and jumps between branches", () => {
    const h = new TextHistory("a", "f");
    h.record("b", "ab");
    h.record("c", "abc");
    h.undo();
    h.record("d", "abd");
    expect(h.allStates.map((s) => [s.seq, s.parent])).toEqual([[0, -1], [1, 0], [2, 1], [3, 1]]);
    expect(h.childrenOf(1)).toEqual([2, 3]);
    expect(h.jumpTo(2)).toBe(true);
    expect(h.text).toBe("abc");
    h.undo();
    h.redo(); // the child last visited
    expect(h.text).toBe("abc");
    expect(h.forward()).toBe(true);
    expect(h.text).toBe("abd");
    expect(h.back()).toBe(true);
    expect(h.text).toBe("abc");
  });

  it("amends the current state's text without disturbing the others", () => {
    const h = new TextHistory("one two three", "f");
    h.record("a", "one 2 three");
    h.record("b", "one 2 3");
    h.undo();
    h.amend("ONE 2 three"); // a view change on the middle state
    expect(texts(h)).toEqual(new Map([[0, "one two three"], [1, "ONE 2 three"], [2, "one 2 3"]]));
    expect(h.allStates[1].hash).not.toBe(new TextHistory("one 2 three", "f").allStates[0].hash);
    expect(h.allStates[1].hash).toBe(new TextHistory("ONE 2 three", "f").allStates[0].hash);
  });

  it("rewrites every state's text, branches included, keeping the tree, the labels and the current state (ADR 0302)", () => {
    const h = new TextHistory("old a", "f");
    h.record("one", "old ab");
    h.record("two", "old abc");
    h.undo();
    h.record("three", "old abd");
    h.undo(); // at "one", with two branches below
    const shape = h.allStates.map((s) => [s.seq, s.parent, s.label]);
    expect(h.rewrite((t) => t.replace("old", "new"))).toBe(true);
    expect(h.allStates.map((s) => [s.seq, s.parent, s.label])).toEqual(shape);
    expect(h.text).toBe("new ab");
    expect(h.current).toBe(1);
    expect(texts(h)).toEqual(new Map([[0, "new a"], [1, "new ab"], [2, "new abc"], [3, "new abd"]]));
    expect(h.allStates[2].hash).toBe(new TextHistory("new abc", "f").allStates[0].hash);
    expect(h.undoLabel).toBe("one");
    expect(h.rewrite((t) => t)).toBe(false);
  });

  it("round-trips through a history file, matching the text to a state", () => {
    const h = new TextHistory("x", "old.json");
    h.record("y", "xy");
    h.record("z", "xyz");
    h.undo();
    h.markSaved();
    h.path = "new.json";
    const file = JSON.parse(JSON.stringify(h.toFile()));
    expect(file.scene).toBe("new.json");
    expect(file.states[1].files[0].path).toBe("new.json");

    const again = new TextHistory("xy", "new.json");
    expect(again.load(file)).toEqual({ matched: 1, lastCurrent: 1 });
    expect([again.canUndo, again.canRedo]).toEqual([true, true]);
    again.redo();
    expect(again.text).toBe("xyz");
    again.record("w", "xyzw");
    expect(again.allStates.at(-1)!.seq).toBe(3); // numbering continues

    const ahead = new TextHistory("x", "new.json"); // the file is at an earlier state than the history
    expect(ahead.load({ ...file, saved: 0 })).toEqual({ matched: 0, lastCurrent: 1 });
    expect(new TextHistory("other", "new.json").load(file)).toBeNull();
  });

  it("refuses a damaged file's patches instead of corrupting the text", () => {
    const h = new TextHistory("abc", "f");
    h.record("d", "abcd");
    const file = h.toFile();
    file.states[1].files![0].after = "zzz";
    const again = new TextHistory("abcd", "f");
    expect(again.load(file)).not.toBeNull();
    expect(again.undo()).toBe(false);
    expect(again.text).toBe("abcd");
  });

  it("reads the former format name, and refuses a scene's history", () => {
    const h = new TextHistory("a", "f");
    h.record("b", "ab");
    const file = h.toFile();
    expect(new TextHistory("ab", "f").load({ ...file, format: "tranquility.history@1" as never })).toEqual({ matched: 1, lastCurrent: 1 });
    const scene = { ...file, states: [file.states[0], { ...file.states[1], files: undefined, redo: {}, undo: {} }] };
    expect(new TextHistory("ab", "f").load(scene)).toBeNull();
  });

  it("prunes old branches by age when written and when loaded (ADR 0116)", () => {
    const h = new TextHistory("a", "f");
    h.record("b", "ab");
    h.undo();
    h.record("c", "ac");
    const later = Date.now() + 40 * 86_400_000;
    expect(h.toFile({ pruneDays: 30, now: later }).states.map((s) => s.seq)).toEqual([0, 2]);
    const again = new TextHistory("ac", "f");
    expect(again.load(h.toFile(), { pruneDays: 30, now: later })).toEqual({ matched: 2, lastCurrent: 2 });
    expect(again.allStates.map((s) => s.seq)).toEqual([0, 2]);
  });

  it("keeps at most `limit` states, pruning old branches first, then the root", () => {
    const h = new TextHistory("0", "f", 3);
    h.record("1", "1");
    h.undo();
    h.record("2", "2"); // state 1 is now an old branch
    h.record("3", "3");
    expect(h.allStates.map((s) => s.seq)).toEqual([0, 2, 3]);
    h.record("4", "4");
    expect(h.allStates.map((s) => s.seq)).toEqual([2, 3, 4]);
    expect(h.root).toBe(2);
    expect(h.allStates[0].files).toBeUndefined();
    h.jumpTo(2);
    expect(h.text).toBe("2");
  });
});
