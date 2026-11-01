import { describe, expect, it } from "vitest";
import { AddNode, CommandStack, ReparentNode, SceneDocument, SetField, applyPatch, changesBetween, diffFiles, hashFile, type SceneFile } from "./index";

const file = (): SceneFile => ({
  format: "tranquility.scene@1",
  settings: { physics: "2d" },
  nodes: [
    { id: "a", name: "A", components: [{ type: "engine.Transform", data: { position: [0, 0, 0] } }] },
    { id: "b", name: "B" },
    { id: "c", name: "C", parent: "b" },
  ],
});

const x = (doc: SceneDocument) => (doc.fieldValue("a", "engine.Transform", "position") as number[])[0];
const setX = (stack: CommandStack, v: number) => stack.execute(new SetField("a", "engine.Transform", "position", [v, 0, 0]));

describe("document patches", () => {
  it("diff then apply reproduces the target exactly, both ways", () => {
    const a = file();
    const b = file();
    b.nodes[0].name = "Renamed";
    b.nodes.push({ id: "d", name: "D", parent: "a" });
    b.nodes.splice(1, 1); // remove b (its child c stays, for the test)
    const d = diffFiles(a, b)!;
    expect(JSON.stringify(applyPatch(a, d.redo))).toBe(JSON.stringify(b));
    expect(JSON.stringify(applyPatch(b, d.undo))).toBe(JSON.stringify(a));
    expect(diffFiles(a, file())).toBeNull();
  });

  it("only records the nodes that changed", () => {
    const b = file();
    b.nodes[2].name = "Changed";
    expect(Object.keys(diffFiles(file(), b)!.redo.nodes!)).toEqual(["c"]);
    expect(diffFiles(file(), b)!.redo.order).toBeUndefined();
  });

  it("tells the World what to rebuild, remove and move", () => {
    const b = file();
    b.nodes[1].name = "B2"; // b changed: rebuild b (c comes with it)
    b.nodes[2].name = "C2";
    expect(changesBetween(file(), b)).toEqual([{ kind: "rebuild", node: "b" }]);
    const reordered = file();
    reordered.nodes = [reordered.nodes[1], reordered.nodes[0], reordered.nodes[2]];
    expect(changesBetween(file(), reordered)).toEqual(expect.arrayContaining([{ kind: "move", node: "b" }, { kind: "move", node: "a" }]));
  });

  it("hashes content, including key order", () => {
    expect(hashFile(file())).toBe(hashFile(file()));
    const b = file();
    b.nodes[0].name = "x";
    expect(hashFile(b)).not.toBe(hashFile(file()));
  });
});

describe("history tree (ADR 0027)", () => {
  it("undo and redo walk the tree", () => {
    const doc = new SceneDocument(file());
    const stack = new CommandStack(doc);
    setX(stack, 1);
    setX(stack, 2);
    stack.undo();
    expect(x(doc)).toBe(1);
    stack.redo();
    expect(x(doc)).toBe(2);
  });

  it("editing after undo starts a new branch and keeps the old one", () => {
    const doc = new SceneDocument(file());
    const stack = new CommandStack(doc);
    setX(stack, 1); // state 1
    setX(stack, 2); // state 2
    stack.undo(); // back to 1
    setX(stack, 3); // state 3: a sibling of 2
    expect(stack.allStates.map((s) => [s.seq, s.parent])).toEqual([[0, -1], [1, 0], [2, 1], [3, 1]]);
    expect(stack.canRedo).toBe(false); // at a leaf

    stack.jumpTo(2); // the other branch is still there
    expect(x(doc)).toBe(2);
    stack.undo();
    stack.redo(); // redo returns to the branch last visited
    expect(x(doc)).toBe(2);
    stack.jumpTo(3);
    stack.undo();
    stack.redo();
    expect(x(doc)).toBe(3);
  });

  it("steps through states in creation order across branches", () => {
    const doc = new SceneDocument(file());
    const stack = new CommandStack(doc);
    setX(stack, 1);
    setX(stack, 2);
    stack.undo();
    setX(stack, 3);
    stack.back();
    expect(stack.current).toBe(2);
    expect(x(doc)).toBe(2);
    stack.back();
    expect(x(doc)).toBe(1);
    stack.forward();
    stack.forward();
    expect(x(doc)).toBe(3);
  });

  it("groups are one step; structural edits undo exactly", () => {
    const doc = new SceneDocument(file());
    const before = JSON.stringify(doc.toJSON());
    const stack = new CommandStack(doc);
    stack.beginGroup("Restructure");
    stack.execute(new AddNode({ id: "d", name: "D" }, { parent: "a" }));
    stack.execute(new ReparentNode("c", null));
    stack.endGroup();
    expect(stack.allStates).toHaveLength(2);
    stack.undo();
    expect(JSON.stringify(doc.toJSON())).toBe(before);
  });

  it("tracks the saved state through branches", () => {
    const doc = new SceneDocument(file());
    const stack = new CommandStack(doc);
    setX(stack, 1);
    stack.markSaved();
    setX(stack, 2);
    expect(stack.dirty).toBe(true);
    stack.undo();
    expect(stack.dirty).toBe(false);
  });

  it("keeps at most `limit` states, dropping old side branches first", () => {
    const doc = new SceneDocument(file());
    const stack = new CommandStack(doc, 5);
    setX(stack, 1);
    setX(stack, 2);
    stack.undo();
    setX(stack, 3); // branch: 0 → 1 → {2, 3}
    for (let v = 4; v < 9; v++) setX(stack, v);
    expect(stack.allStates.length).toBe(5);
    expect(stack.allStates.some((s) => s.seq === 2)).toBe(false); // the side branch went first
    while (stack.undo()) { /* to the root */ }
    expect(stack.allStates[0].parent).toBe(-1);
    expect(x(doc)).toBeGreaterThan(1); // the root advanced along the path
  });
});

describe("saving and loading history", () => {
  it("round-trips through a history file and finds the state matching the document", () => {
    const doc = new SceneDocument(file());
    const stack = new CommandStack(doc);
    setX(stack, 1);
    stack.markSaved();
    setX(stack, 2); // unsaved when "the editor closed"
    const saved = JSON.parse(JSON.stringify(stack.toFile("scenes/a.scene.json")));

    // Reopen: the file on disk is the saved state (x = 1).
    const disk = file();
    (disk.nodes[0].components![0].data!.position as number[])[0] = 1;
    const doc2 = new SceneDocument(disk);
    const stack2 = new CommandStack(doc2);
    const result = stack2.load(saved)!;
    expect(result).toEqual({ matched: 1, lastCurrent: 2 }); // offer to restore state 2
    expect(stack2.dirty).toBe(false);
    stack2.jumpTo(result.lastCurrent);
    expect(x(doc2)).toBe(2);
    stack2.undo();
    stack2.undo();
    expect(x(doc2)).toBe(0); // the whole history came back
  });

  it("ignores history that doesn't match the file (changed outside the editor)", () => {
    const doc = new SceneDocument(file());
    const stack = new CommandStack(doc);
    setX(stack, 1);
    const saved = stack.toFile("scenes/a.scene.json");
    const other = file();
    other.nodes[0].name = "Edited elsewhere";
    const stack2 = new CommandStack(new SceneDocument(other));
    expect(stack2.load(saved)).toBeNull();
    expect(stack2.allStates).toHaveLength(1);
  });
});
