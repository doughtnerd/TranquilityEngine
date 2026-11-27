// The Input dialog's file steps (ADR 0417), through the dialog's history: making, naming and deleting a set or
// context is one step with its project.json list entry, and Undo (the toast's, or the dialog's) restores both.
import { describe, expect, it } from "vitest";
import { deleteFileEdits, freeFilePath, makeFileEdits, moveFileEdits, type DialogFiles } from "./inputDialogFiles";
import { InputDialogHistory } from "./inputDialogHistory";

const PROJECT = '{\n  "name": "Game",\n  "input": { "actionSets": ["input/player.actions.json"] }\n}\n';

function project(files: Record<string, string>) {
  const disk = new Map(Object.entries(files));
  const history = new InputDialogHistory({
    read: (p) => disk.get(p),
    write: async (p, t) => void disk.set(p, t),
    remove: async (p) => void disk.delete(p),
  });
  const view: DialogFiles = {
    text: (p) => history.text(p),
    get files() {
      return history.files([...disk.keys()]);
    },
  };
  const list = () => (JSON.parse(disk.get("project.json")!) as { input: { actionSets: string[] } }).input.actionSets;
  return { disk, history, view, list };
}

describe("the Input dialog's file steps", () => {
  it("picks a free path among the files, those being made included", () => {
    expect(freeFilePath(["input/new.actions.json", "input/new 2.actions.json"], "input", "new", ".actions.json")).toBe("input/new 3.actions.json");
    expect(freeFilePath([], "", "New Input Context", ".input.json")).toBe("New Input Context.input.json");
  });

  it("makes a set file and lists it in one step; undo removes both", async () => {
    const p = project({ "project.json": PROJECT, "input/player.actions.json": "{}" });
    p.history.record("New action set", makeFileEdits(p.view, "input/new.actions.json", '{"id":"game.New"}\n'));
    await p.history.flush();
    expect(p.disk.get("input/new.actions.json")).toBe('{"id":"game.New"}\n');
    expect(p.list()).toEqual(["input/player.actions.json", "input/new.actions.json"]);
    expect(p.disk.get("project.json")).toContain('"name": "Game"'); // the rest keeps its layout
    p.history.undo();
    await p.history.flush();
    expect(p.disk.has("input/new.actions.json")).toBe(false);
    expect(p.disk.get("project.json")).toBe(PROJECT);
  });

  it("makes a context without touching project.json", () => {
    const p = project({ "project.json": PROJECT });
    expect(makeFileEdits(p.view, "input/menu.input.json", "{}").map((e) => e.path)).toEqual(["input/menu.input.json"]);
  });

  it("deletes a set and its list entry in one step, and the toast's undo brings both back", async () => {
    const p = project({ "project.json": PROJECT, "input/player.actions.json": '{"id":"game.Player"}' });
    expect(p.history.record("Delete game.Player", deleteFileEdits(p.view, "input/player.actions.json"))).toBe(true);
    expect(p.view.files).toEqual(["project.json"]); // gone from the list at once
    await p.history.flush();
    expect(p.disk.has("input/player.actions.json")).toBe(false);
    expect(p.list()).toEqual([]);
    p.history.undo(); // what the toast's Undo does while the deletion is the current step
    await p.history.flush();
    expect(p.disk.get("input/player.actions.json")).toBe('{"id":"game.Player"}');
    expect(p.disk.get("project.json")).toBe(PROJECT);
    expect(deleteFileEdits(p.view, "input/none.input.json")).toEqual([]);
  });

  it("names a new set: the file moves and its list entry is renamed where it stands", async () => {
    const p = project({ "project.json": '{"input":{"actionSets":["input/new.actions.json","input/b.actions.json"]}}', "input/new.actions.json": "A", "input/b.actions.json": "B" });
    p.history.record("Name game.Car", moveFileEdits(p.view, "input/new.actions.json", "input/car.actions.json", "CAR"));
    await p.history.flush();
    expect(p.disk.has("input/new.actions.json")).toBe(false);
    expect(p.disk.get("input/car.actions.json")).toBe("CAR");
    expect(p.list()).toEqual(["input/car.actions.json", "input/b.actions.json"]);
    p.history.undo();
    await p.history.flush();
    expect(p.disk.get("input/new.actions.json")).toBe("A");
    expect(p.list()).toEqual(["input/new.actions.json", "input/b.actions.json"]);
  });

  it("keeps the file where it is when the name's path is taken, writing the new text", () => {
    const p = project({ "input/a.input.json": "A", "input/b.input.json": "B" });
    expect(moveFileEdits(p.view, "input/a.input.json", "input/b.input.json", "A2")).toEqual([{ path: "input/a.input.json", before: "A", after: "A2" }]);
  });
});
