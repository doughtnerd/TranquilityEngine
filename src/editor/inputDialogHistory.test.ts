// The Input dialog's history (ADR 0417): one tree across every file it edits, steps that change several files at
// once, branches kept, and a step that no longer fits a file changed elsewhere refused instead of overwriting it.
import { describe, expect, it } from "vitest";
import { InputDialogHistory } from "./inputDialogHistory";

function store(files: Record<string, string>) {
  const disk = new Map(Object.entries(files));
  const writes: string[] = [];
  return {
    disk,
    writes,
    read: (p: string) => disk.get(p),
    write: async (p: string, t: string) => {
      writes.push(p);
      disk.set(p, t);
    },
    remove: async (p: string) => {
      writes.push(`-${p}`);
      disk.delete(p);
    },
  };
}

describe("the Input dialog's history", () => {
  it("records a step across files, writes them, and undoes and redoes it", async () => {
    const s = store({ "a.json": "A0", "b.json": "B0" });
    const h = new InputDialogHistory(s);
    expect(h.record("Change type", [{ path: "a.json", before: "A0", after: "A1" }, { path: "b.json", before: "B0", after: "B1" }])).toBe(true);
    expect(h.text("a.json")).toBe("A1"); // before the write lands
    await h.flush();
    expect(s.disk.get("a.json")).toBe("A1");
    expect(s.disk.get("b.json")).toBe("B1");
    expect(h.undoLabel).toBe("Change type");
    expect(h.undo()?.label).toBe("Change type");
    await h.flush();
    expect([s.disk.get("a.json"), s.disk.get("b.json")]).toEqual(["A0", "B0"]);
    h.redo();
    await h.flush();
    expect([s.disk.get("a.json"), s.disk.get("b.json")]).toEqual(["A1", "B1"]);
  });

  it("records nothing when nothing changed", () => {
    const h = new InputDialogHistory(store({ "a.json": "A0" }));
    expect(h.record("Nothing", [{ path: "a.json", before: "A0", after: "A0" }])).toBe(false);
    expect(h.canUndo).toBe(false);
  });

  it("keeps the undone branch when an edit follows an undo, and jumps back to it", async () => {
    const s = store({ "a.json": "x" });
    const h = new InputDialogHistory(s);
    h.record("one", [{ path: "a.json", before: "x", after: "x1" }]);
    const one = h.current;
    h.undo();
    h.record("two", [{ path: "a.json", before: h.text("a.json")!, after: "x2" }]);
    await h.flush();
    expect(s.disk.get("a.json")).toBe("x2");
    expect(h.states.map((st) => st.label)).toEqual(["Opened", "one", "two"]);
    h.go(one);
    await h.flush();
    expect(s.disk.get("a.json")).toBe("x1");
  });

  it("refuses a move when a file changed elsewhere so the step no longer fits it", async () => {
    const s = store({ "a.json": '{"n":1}' });
    const h = new InputDialogHistory(s);
    h.record("Set n", [{ path: "a.json", before: '{"n":1}', after: '{"n":2}' }]);
    await h.flush();
    s.disk.set("a.json", '{"m":9}'); // edited in the Code panel
    expect(h.undo()).toBeNull();
    expect(h.canUndo).toBe(true);
    expect(s.disk.get("a.json")).toBe('{"m":9}');
  });

  it("reports a failed write and says when it's saving", async () => {
    const s = store({ "a.json": "1" });
    s.write = async () => {
      throw new Error("disk full");
    };
    const h = new InputDialogHistory(s);
    h.record("Edit", [{ path: "a.json", before: "1", after: "2" }]);
    expect(h.saving.value).toBe(true);
    await h.flush();
    expect(h.saving.value).toBe(false);
    expect(h.failed.value).toMatch(/disk full/);
    expect(h.text("a.json")).toBe("1"); // the pending text went with the failed write
  });

  it("makes a file as a step: undo deletes it, redo writes it again, and the list shows it before the write lands", async () => {
    const s = store({ "project.json": '{"input":{"actionSets":[]}}' });
    const h = new InputDialogHistory(s);
    h.record("New action set", [
      { path: "input/new.actions.json", before: null, after: "SET" },
      { path: "project.json", before: '{"input":{"actionSets":[]}}', after: '{"input":{"actionSets":["input/new.actions.json"]}}' },
    ]);
    expect(h.files(["project.json"])).toEqual(["project.json", "input/new.actions.json"]);
    expect(h.text("input/new.actions.json")).toBe("SET");
    await h.flush();
    expect(s.disk.get("input/new.actions.json")).toBe("SET");
    expect(h.undo()?.label).toBe("New action set");
    expect(h.text("input/new.actions.json")).toBeUndefined();
    expect(h.files(["project.json", "input/new.actions.json"])).toEqual(["project.json"]);
    await h.flush();
    expect(s.disk.has("input/new.actions.json")).toBe(false);
    expect(s.disk.get("project.json")).toBe('{"input":{"actionSets":[]}}');
    h.redo();
    await h.flush();
    expect(s.disk.get("input/new.actions.json")).toBe("SET");
    expect(s.disk.get("project.json")).toContain("new.actions.json");
  });

  it("deletes a file as a step: undo writes it back with its list entry", async () => {
    const s = store({ "a.input.json": "CTX", "b.input.json": "B" });
    const h = new InputDialogHistory(s);
    h.record("Delete a", [{ path: "a.input.json", before: "CTX", after: null }]);
    expect(h.files(["a.input.json", "b.input.json"])).toEqual(["b.input.json"]);
    await h.flush();
    expect(s.writes).toEqual(["-a.input.json"]);
    h.undo();
    await h.flush();
    expect(s.disk.get("a.input.json")).toBe("CTX");
  });

  it("refuses to undo making a file that changed since, and to undo a deletion when the file is back", async () => {
    const s = store({});
    const h = new InputDialogHistory(s);
    h.record("Make", [{ path: "n.json", before: null, after: "1" }]);
    await h.flush();
    s.disk.set("n.json", "edited");
    expect(h.undo()).toBeNull();
    expect(s.disk.get("n.json")).toBe("edited");
    const t = new InputDialogHistory(s);
    t.record("Delete", [{ path: "n.json", before: "edited", after: null }]);
    await t.flush();
    s.disk.set("n.json", "made again elsewhere");
    expect(t.undo()).toBeNull();
    expect(s.disk.get("n.json")).toBe("made again elsewhere");
  });

  it("moves a file (a new entry named) as one step that undoes to the old path", async () => {
    const s = store({ "old.json": "X" });
    const h = new InputDialogHistory(s);
    h.record("Name it", [
      { path: "old.json", before: "X", after: null },
      { path: "new.json", before: null, after: "Y" },
    ]);
    await h.flush();
    expect([...s.disk.keys()]).toEqual(["new.json"]);
    h.undo();
    await h.flush();
    expect(Object.fromEntries(s.disk)).toEqual({ "old.json": "X" });
  });
});
