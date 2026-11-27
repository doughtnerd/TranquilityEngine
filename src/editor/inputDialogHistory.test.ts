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
});
