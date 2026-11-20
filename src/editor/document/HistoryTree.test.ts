import { describe, expect, it } from "vitest";
import { HistoryTree, cleanPruneDays, type HistoryFile, type HistoryState, type StepAdapter } from "./HistoryTree";

// A toy edited value for the tree's rules: a string that each step appends its label to. Undo
// refuses when the label isn't at the end (a step that doesn't fit).
const append: StepAdapter<string> = {
  step: (v, s, direction) => (direction === "redo" ? v + s.label : v.endsWith(s.label) ? v.slice(0, -s.label.length) : null),
};

/** A tree over a string, with each step recorded as the edit `label` (its hash is the resulting string). */
class Appender {
  value = "";
  readonly tree: HistoryTree;
  constructor(limit?: number) {
    this.tree = new HistoryTree("", limit);
  }
  edit(label: string) {
    this.value += label;
    this.tree.add({ label, hash: this.value });
  }
  go(move: Parameters<HistoryTree["go"]>[0]) {
    const moved = this.tree.go(move, this.value, append);
    if (moved) this.value = moved.value;
    return moved;
  }
}

const shape = (t: HistoryTree) => t.allStates.map((s) => [s.seq, s.parent]);

describe("HistoryTree navigation (ADR 0027)", () => {
  it("undoes to the parent and redoes to the child last visited, labelling each step", () => {
    const a = new Appender();
    a.edit("a");
    a.edit("b");
    expect([a.tree.labelOf("undo"), a.tree.labelOf("redo")]).toEqual(["b", null]);
    expect(a.go("undo")).toEqual({ value: "a", seq: 1, label: "b" });
    expect(a.go("redo")).toEqual({ value: "ab", seq: 2, label: "b" });
    a.go("undo");
    a.go("undo");
    expect([a.value, a.tree.targetOf("undo"), a.go("undo")]).toEqual(["", null, null]);
  });

  it("branches on an edit after undo, keeps the old branch, and redo follows the branch last visited", () => {
    const a = new Appender();
    a.edit("a");
    a.edit("b");
    a.go("undo");
    a.edit("c");
    expect(shape(a.tree)).toEqual([[0, -1], [1, 0], [2, 1], [3, 1]]);
    expect(a.tree.childrenOf(1)).toEqual([2, 3]);
    expect(a.go(2)!.value).toBe("ab"); // across branches, through the common ancestor
    a.go("undo");
    expect(a.go("redo")!.value).toBe("ab");
    a.go(3);
    a.go("undo");
    expect(a.go("redo")!.value).toBe("ac");
    expect(a.tree.targetOf(3)).toBeNull(); // already there
    expect(a.tree.targetOf(99)).toBeNull();
  });

  it("steps through states in creation order across branches", () => {
    const a = new Appender();
    a.edit("a");
    a.edit("b");
    a.go("undo");
    a.edit("c");
    expect(a.go("back")!.value).toBe("ab");
    expect(a.go("back")!.value).toBe("a");
    a.go("forward");
    expect(a.go("forward")!.value).toBe("ac");
    expect(a.go("forward")).toBeNull();
  });

  it("gives the path between two states through their common ancestor", () => {
    const a = new Appender();
    a.edit("a"); // 1
    a.edit("b"); // 2
    a.go("undo");
    a.edit("c"); // 3
    a.edit("d"); // 4
    expect(a.tree.path(2, 4)).toEqual({ up: [2], down: [3, 4] });
    expect(a.tree.path(4, 0)).toEqual({ up: [4, 3, 1], down: [] });
  });

  it("abandons a move whose step the adapter refuses, changing nothing", () => {
    const a = new Appender();
    a.edit("a");
    a.edit("b");
    a.go("undo");
    const before = JSON.stringify(a.tree.allStates);
    expect(a.tree.go("undo", "zz", append)).toBeNull(); // "a" isn't at the end of "zz"
    expect([a.tree.current, JSON.stringify(a.tree.allStates)]).toEqual([1, before]);
  });

  it("tracks the saved state, -1 for one that isn't there", () => {
    const a = new Appender();
    a.edit("a");
    a.tree.markSaved();
    expect(a.tree.saved).toBe(1);
    a.tree.markSaved(42);
    expect(a.tree.saved).toBe(-1);
  });
});

describe("HistoryTree pruning by count (ADR 0027)", () => {
  it("drops the oldest leaves off the current path first, then advances the root, dropping its step", () => {
    const a = new Appender(3);
    a.edit("1");
    a.go("undo");
    a.edit("2"); // state 1 is now an old branch
    a.edit("3");
    expect(a.tree.allStates.map((s) => s.seq)).toEqual([0, 2, 3]);
    a.tree.markSaved(0);
    a.edit("4");
    expect(a.tree.allStates.map((s) => s.seq)).toEqual([2, 3, 4]);
    expect([a.tree.root, a.tree.state(2).parent, a.tree.saved]).toEqual([2, -1, -1]);
    expect(a.go(2)!.value).toBe("2");
  });
});

const DAY_MS = 86_400_000;
const NOW = 1_000 * DAY_MS;
const st = (seq: number, parent: number, ageDays: number, extra: Partial<HistoryState> = {}): HistoryState => ({ seq, parent, label: `s${seq}`, time: NOW - ageDays * DAY_MS, hash: `h${seq}`, ...extra });
const file = (states: HistoryState[], current: number, saved = 0, extra: Partial<HistoryFile> = {}): HistoryFile => ({ format: "myco.history@1", scene: "s", root: 0, current, saved, nextSeq: states.length, states, ...extra });
const seqs = (f: HistoryFile | HistoryTree) => (f instanceof HistoryTree ? f.allStates : f.states).map((s) => s.seq);
/** A tree that has adopted `f`, matched by the hash of state `at`. */
const loaded = (f: HistoryFile, at: number, days = 0) => {
  const t = new HistoryTree("x");
  expect(t.load(f, `h${at}`, { pruneDays: days, now: NOW })).not.toBeNull();
  return t;
};

describe("HistoryTree pruning by age (ADR 0116)", () => {
  //  0 - 1 - 2 - 3 (current)
  //       \ 4 - 5 (old branch)
  //   \ 6 (old leaf off the root)
  const tree = () => file([st(0, -1, 100), st(1, 0, 100), st(2, 1, 100), st(3, 2, 1), st(4, 1, 90), st(5, 4, 80), st(6, 0, 70)], 3, 3);

  it("0 days, or nothing old, keeps everything", () => {
    expect(seqs(loaded(tree(), 3, 0).toFile("s", { pruneDays: 0, now: NOW }))).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(seqs(loaded(tree(), 3, 200))).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("drops old branches but never the path from the root to the current state, on load and when writing", () => {
    expect(seqs(loaded(tree(), 3, 30))).toEqual([0, 1, 2, 3]);
    const t = loaded(tree(), 3);
    const written = t.toFile("s", { pruneDays: 30, now: NOW });
    expect([seqs(written), written.current]).toEqual([[0, 1, 2, 3], 3]);
    expect(seqs(t)).toEqual([0, 1, 2, 3, 4, 5, 6]); // the tree keeps them; only the file drops them
  });

  it("keeps an old state whose descendant is recent, and the paths to the file's current and saved states", () => {
    const f = file([st(0, -1, 100), st(1, 0, 100), st(2, 1, 100), st(3, 1, 100), st(4, 3, 2), st(5, 0, 100)], 2, 0);
    expect(seqs(loaded(f, 0, 30))).toEqual([0, 1, 2, 3, 4]); // 3 is kept for its child 4; 5 goes
    const g = file([st(0, -1, 100), st(1, 0, 100), st(2, 1, 100), st(3, 0, 100)], 3, 2);
    expect(seqs(loaded(g, 2, 30))).toEqual([0, 1, 2, 3]); // current 3 and saved 2 both kept
  });

  it("drops redo pointers to removed states, and doesn't change the file it was given", () => {
    const f = file([st(0, -1, 100, { redoChild: 2 }), st(1, 0, 1), st(2, 0, 100)], 1, 1);
    const before = JSON.stringify(f);
    const t = loaded(f, 1, 30);
    expect(seqs(t)).toEqual([0, 1]);
    expect("redoChild" in t.state(0)).toBe(false);
    expect(JSON.stringify(f)).toBe(before);
  });

  it("reads the setting as whole days", () => {
    expect([cleanPruneDays(-3), cleanPruneDays("x"), cleanPruneDays(7.9), cleanPruneDays("30"), cleanPruneDays(1e9)]).toEqual([0, 0, 7, 30, 36500]);
  });
});

describe("HistoryTree history files", () => {
  it("round-trips: adopts the file's saved state when it matches, else the newest match, and reports where it was", () => {
    const a = new Appender();
    a.edit("a");
    a.tree.markSaved();
    a.edit("b");
    const f = JSON.parse(JSON.stringify(a.tree.toFile("scenes/s.json"))) as HistoryFile;
    expect([f.format, f.scene, f.root, f.current, f.saved, f.nextSeq]).toEqual(["myco.history@1", "scenes/s.json", 0, 2, 1, 3]);
    const t = new HistoryTree("a");
    expect(t.load(f, "a")).toEqual({ matched: 1, lastCurrent: 2 });
    expect([t.current, t.saved, t.root]).toEqual([1, 1, 0]);
    const twice = new Appender();
    twice.edit("a");
    twice.go("undo");
    twice.edit("a"); // states 1 and 2 hold the same value; neither is saved
    expect(new HistoryTree("a").load(twice.tree.toFile("s"), "a")).toEqual({ matched: 2, lastCurrent: 2 });
    expect(new HistoryTree("zz").load(f, "zz")).toBeNull();
  });

  it("reads the former format name (ADR 0037)", () => {
    const f = file([st(0, -1, 0), st(1, 0, 0)], 1, 1);
    expect(new HistoryTree("x").load({ ...f, format: "tranquility.history@1" as never }, "h1")).toEqual({ matched: 1, lastCurrent: 1 });
    expect(new HistoryTree("x").load({ ...f, format: "other@1" as never }, "h1")).toBeNull();
  });

  it("continues numbering after the highest state even when the file's nextSeq is too small", () => {
    const t = new HistoryTree("x");
    t.load(file([st(0, -1, 0), st(1, 0, 0), st(5, 1, 0)], 5, 5, { nextSeq: 2 }), "h5");
    expect(t.add({ label: "new", hash: "n" }).seq).toBe(6); // not 2, which would overwrite nothing now, nor 5, which would overwrite a state
    const u = new HistoryTree("x");
    u.load(file([st(0, -1, 0), st(1, 0, 0)], 1, 1, { nextSeq: "7" as never }), "h1");
    expect(u.add({ label: "new", hash: "n" }).seq).toBe(2);
  });

  it("refuses a damaged file, changing nothing: missing root, missing parent, second root, cycle, repeated or malformed state", () => {
    const states = () => [st(0, -1, 0), st(1, 0, 0), st(2, 1, 0)];
    const damaged: HistoryFile[] = [
      file(states(), 2, 2, { root: 9 }), // no root state
      file([st(1, 0, 0), st(2, 1, 0)], 2, 2, { root: 1 }), // the root has a parent
      file([st(0, -1, 0), st(1, 7, 0), st(2, 1, 0)], 2, 2), // a missing parent
      file([st(0, -1, 0), st(1, -1, 0), st(2, 1, 0)], 2, 2), // a second root
      file([st(0, -1, 0), st(1, 2, 0), st(2, 1, 0)], 2, 2), // a cycle
      file([st(0, -1, 0), st(2, 0, 0), st(2, 0, 0)], 2, 2), // a repeated seq
      file([st(0, -1, 0), { seq: "2" } as never], 2, 2), // malformed
      { ...file(states(), 2, 2), states: undefined as never },
      null as never,
    ];
    for (const f of damaged) {
      const t = new HistoryTree("x");
      expect(t.load(f, "h2")).toBeNull();
      expect(seqs(t)).toEqual([0]);
    }
  });

  it("refuses a file a state of which the caller doesn't accept", () => {
    const f = file([st(0, -1, 0), st(1, 0, 0, { label: "scene step" })], 1, 1);
    expect(new HistoryTree("x").load(f, "h1", { accepts: (s) => s.label !== "scene step" })).toBeNull();
  });
});
