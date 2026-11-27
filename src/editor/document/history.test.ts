import { describe, expect, it } from "vitest";
import { AddNode, CommandStack, ReparentNode, SceneDocument, SetField, WriteFiles, applyFilePatch, applyPatch, changesBetween, diffFiles, diffText, hashFile, type SceneFile } from "./index";

const file = (): SceneFile => ({
  format: "myco.scene@1",
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
  it("adopts a damaged file safely: numbering continues past its states, and a missing root is refused (ADR 0267)", () => {
    const stack = new CommandStack(new SceneDocument(file()));
    setX(stack, 1);
    setX(stack, 2);
    stack.undo();
    stack.undo();
    const saved = { ...stack.toFile("s.scene.json"), nextSeq: 1, saved: 0 }; // a nextSeq that would reuse state 1
    const stack2 = new CommandStack(new SceneDocument(file()));
    expect(stack2.load(saved)).toEqual({ matched: 0, lastCurrent: 0 });
    setX(stack2, 7);
    expect(stack2.allStates.map((s) => s.seq)).toEqual([0, 1, 2, 3]);
    stack2.jumpTo(2);
    expect(x(stack2.doc)).toBe(2); // state 2 is still there
    expect(new CommandStack(new SceneDocument(file())).load({ ...saved, root: 5 })).toBeNull();
  });

  it("reads the former history format name (ADR 0037)", () => {
    const stack = new CommandStack(new SceneDocument(file()));
    setX(stack, 1);
    const legacy = { ...stack.toFile("s.scene.json"), format: "tranquility.history@1" as never };
    expect(new CommandStack(stack.doc).load(legacy)).toEqual({ matched: 1, lastCurrent: 1 });
  });
});

describe("text files in the history (ADR 0077)", () => {
  const host = () => {
    const files = new Map<string, string>([["ui/a.svelte", "<Canvas>\n  <Panel/>\n</Canvas>\n"]]);
    const conflicts: string[] = [];
    return {
      files,
      conflicts,
      read: (p: string) => files.get(p) ?? null,
      write: (p: string, t: string) => void files.set(p, t),
      remove: (p: string) => void files.delete(p),
      conflict: (p: string) => void conflicts.push(p),
    };
  };

  it("records each file's change as a small patch, undone and redone in order with scene edits", () => {
    const doc = new SceneDocument(file());
    const stack = new CommandStack(doc);
    const h = host();
    stack.files = h;
    const original = h.files.get("ui/a.svelte")!;
    stack.execute(new WriteFiles("Set width", [{ path: "ui/a.svelte", text: original.replace("<Panel/>", `<Panel width="10"/>`) }]));
    setX(stack, 5);
    stack.execute(new WriteFiles("Add sheet", [{ path: "ui/a.css", text: ".a { gap: 1px; }\n" }]));
    const patch = stack.allStates.find((s) => s.label === "Set width")!.files![0];
    expect(patch).toEqual({ path: "ui/a.svelte", start: 17, before: "", after: ` width="10"` });
    stack.undo();
    expect(h.files.has("ui/a.css")).toBe(false); // made by the step: undo deletes it
    stack.undo();
    expect(x(doc)).toBe(0);
    stack.undo();
    expect(h.files.get("ui/a.svelte")).toBe(original);
    stack.redo();
    stack.redo();
    stack.redo();
    expect(h.files.get("ui/a.css")).toBe(".a { gap: 1px; }\n");
    expect(h.files.get("ui/a.svelte")).toContain(`width="10"`);
    expect(x(doc)).toBe(5);
    expect(JSON.stringify(stack.toFile("s.scene.json"))).toContain(`"files"`);
  });

  it("coalesces a group's writes per file, doesn't count file-only steps as unsaved, and refuses without a host", () => {
    const doc = new SceneDocument(file());
    const stack = new CommandStack(doc);
    expect(() => stack.execute(new WriteFiles("x", [{ path: "a", text: "b" }]))).toThrow();
    const h = host();
    stack.files = h;
    stack.beginGroup("Drag");
    for (const w of [1, 2, 3]) stack.execute(new WriteFiles("Set width", [{ path: "ui/a.svelte", text: `<Canvas width="${w}"/>` }]));
    stack.endGroup();
    expect(stack.allStates.length).toBe(2);
    expect(stack.allStates[1].files).toHaveLength(1);
    expect(stack.dirty).toBe(false);
    setX(stack, 2);
    expect(stack.dirty).toBe(true);
    stack.undo();
    expect(stack.dirty).toBe(false);
    h.files.set("ui/a.svelte", "changed elsewhere");
    stack.undo();
    expect(h.conflicts).toEqual(["ui/a.svelte"]);
    expect(h.files.get("ui/a.svelte")).toBe("changed elsewhere");
  });

  it("cancels a group: the document and its files go back, nothing is recorded, a nested group just closes (ADR 0231)", () => {
    const doc = new SceneDocument(file());
    const stack = new CommandStack(doc);
    const h = host();
    h.files.set("ui/a.svelte", "<Canvas/>");
    stack.files = h;
    const events: string[] = [];
    stack.subscribe((e) => events.push(`${e.reason}:${e.changes.length}`));
    stack.beginGroup("Drag");
    setX(stack, 4);
    stack.execute(new WriteFiles("Set width", [{ path: "ui/a.svelte", text: `<Canvas width="4"/>` }, { path: "ui/new.css", text: "x" }]));
    expect(stack.cancelGroup()).toBe(true);
    expect(x(doc)).toBe(0);
    expect(h.files.get("ui/a.svelte")).toBe("<Canvas/>");
    expect(h.files.has("ui/new.css")).toBe(false);
    expect(stack.allStates.length).toBe(1);
    expect(stack.canUndo).toBe(false);
    expect(events.at(-1)).toBe("cancel:1"); // the World rebuilds what went back
    stack.beginGroup("Outer");
    setX(stack, 1);
    stack.beginGroup("Inner");
    setX(stack, 2);
    expect(stack.cancelGroup()).toBe(false);
    stack.endGroup();
    expect(x(doc)).toBe(2);
    expect(stack.undoLabel).toBe("Outer");
    expect(() => stack.cancelGroup()).toThrow();
  });

  it("refuses a move across a damaged step, writing no files and leaving the document (ADR 0267)", () => {
    const stack = new CommandStack(new SceneDocument(file()));
    const h = host();
    stack.files = h;
    const original = h.files.get("ui/a.svelte")!;
    setX(stack, 1);
    stack.execute(new WriteFiles("Edit", [{ path: "ui/a.svelte", text: "<Canvas/>\n" }]));
    const saved = JSON.parse(JSON.stringify(stack.toFile("s.scene.json")));
    delete saved.states[1].undo; // state 1's way back is lost
    const stack2 = new CommandStack(stack.doc);
    stack2.files = h;
    expect(stack2.load(saved)).not.toBeNull();
    expect(stack2.jumpTo(0)).toBe(false); // undoing state 2 would rewrite the file, but state 1 refuses
    expect([h.files.get("ui/a.svelte"), x(stack2.doc), stack2.current]).toEqual(["<Canvas/>\n", 1, 2]);
    expect(stack2.undo()).toBe(true); // the intact step still goes back
    expect(h.files.get("ui/a.svelte")).toBe(original);
  });

  it("diffs text to the differing middle", () => {
    expect(diffText("abcXdef", "abcYYdef")).toEqual({ start: 3, before: "X", after: "YY" });
    expect(diffText("aaa", "aaaa")).toEqual({ start: 3, before: "", after: "a" });
    expect(diffText("same", "same")).toEqual({ start: 4, before: "", after: "" });
  });

  it("refuses a patch whose stretch lies past the end of the text, even an insertion", () => {
    const insert = { path: "a.txt", start: 5, before: "", after: "!" };
    expect(applyFilePatch("hello", insert, "redo")).toBe("hello!");
    expect(applyFilePatch("hi", insert, "redo")).toBeNull();
    expect(applyFilePatch("hi", { ...insert, start: -1 }, "redo")).toBeNull();
    expect(applyFilePatch("hi!", { path: "a.txt", start: 5, before: "!", after: "" }, "undo")).toBeNull();
  });
});
