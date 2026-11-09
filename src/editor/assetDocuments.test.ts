import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAssets } from "./assetDelete";
import { _reset, focusedAssetDocument, KEEPS_HISTORY_FOCUS, openAssetDocument, type AssetDocument } from "./assetDocuments";
import { ASSET_HISTORY_DIR, _useAssetHistoryPlatform, assetHistorySettled } from "./assetHistory";
import { moveAssets } from "./assetOps";
import { MemoryStorage } from "../engine/platform/Storage";
import { askBeforeDeletingAssets, historyLocation } from "./preferences";
import { joinPath, openFolderProject, readOnlyProject, type EditorProject } from "./projects";
import { assetFormats } from "./sdk/contributions";
import { currentProject, docVersion, status } from "./state";
import { MemoryFileSystem, ROOT } from "./testing";

interface Thing {
  n: number;
}

const PATH = "things/a.thing.json";
let fs: MemoryFileSystem;
let project: EditorProject;
let unregister: () => void;
let userStorage: MemoryStorage;
const onDisk = (path: string) => fs.files.get(joinPath(ROOT, path));
const open = (path = PATH) => openAssetDocument<Thing>(project, path, "thing");

beforeEach(async () => {
  unregister = assetFormats.register({
    id: "thing",
    parse: (raw) => {
      const n = (raw as { n?: unknown } | undefined)?.n;
      return typeof n === "number" ? { value: { n }, problems: [] } : { value: { n: 0 }, problems: raw === undefined ? [] : [{ message: "n isn't a number" }] };
    },
    format: (value: Thing) => `${JSON.stringify(value)}\n`,
    writeDelay: 100,
  });
  fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  fs.files.set(joinPath(ROOT, PATH), '{ "n": 1 }');
  fs.files.set(joinPath(ROOT, "things/b.thing.json"), '{ "n": "x" }');
  project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
  askBeforeDeletingAssets.value = false;
  userStorage = new MemoryStorage();
  _useAssetHistoryPlatform({ fs: null, userStorage });
});

afterEach(async () => {
  await assetHistorySettled();
  _reset();
  _useAssetHistoryPlatform(null);
  historyLocation.value = "project";
  unregister();
  vi.useRealTimers();
  askBeforeDeletingAssets.value = true;
  currentProject.value = null;
  status.value = null;
});

describe("asset documents (ADR 0133)", () => {
  it("reads the file through the format, and returns the same document for the same path", () => {
    const doc = open();
    expect(doc.value.value).toEqual({ n: 1 });
    expect(open()).toBe(doc);
    expect(open("things/b.thing.json").problems.value).toEqual([{ message: "n isn't a number" }]);
    expect(() => openAssetDocument(project, PATH, "nope")).toThrow(/nope/);
  });

  it("writes an edit and bumps docVersion", async () => {
    const doc = open();
    const version = docVersion.value;
    doc.edit({ n: 2 });
    expect(doc.value.value).toEqual({ n: 2 });
    await doc.flush();
    expect(onDisk(PATH)).toBe('{"n":2}\n');
    expect(docVersion.value).toBe(version + 1);
    expect(doc.canUndo.value).toBe(true);
  });

  it("writes quick edits in order, and an own write isn't taken for an outside change", async () => {
    const doc = open();
    const writes: string[] = [];
    const write = project.writeText.bind(project);
    project.writeText = async (path, text) => {
      await new Promise((r) => setTimeout(r, text.includes("2") ? 5 : 0)); // the first write is slower
      writes.push(text);
      await write(path, text);
    };
    doc.edit({ n: 2 });
    doc.edit({ n: 3 });
    await doc.flush();
    expect(writes).toEqual(['{"n":2}\n', '{"n":3}\n']);
    expect(doc.value.value).toEqual({ n: 3 });
    doc.undo();
    await doc.flush();
    expect(doc.value.value).toEqual({ n: 2 });
    expect(doc.canUndo.value).toBe(true); // history kept: the own writes didn't reset it
  });

  it("keeps writing after a failed write, and says what failed", async () => {
    const doc = open();
    const write = project.writeText.bind(project);
    let fail = true;
    project.writeText = async (path, text) => {
      if (fail) {
        fail = false;
        throw new Error("disk full");
      }
      await write(path, text);
    };
    doc.edit({ n: 2 });
    doc.edit({ n: 3 });
    await doc.flush();
    expect(status.value?.text).toMatch(`Couldn't save ${PATH}`);
    expect(onDisk(PATH)).toBe('{"n":3}\n');
  });

  it("keeps its unsaved value after a failed write until a later write succeeds", async () => {
    const doc = open();
    let fail = true;
    const write = project.writeText.bind(project);
    project.writeText = async (path, text) => {
      if (fail) throw new Error("disk full");
      await write(path, text);
    };
    doc.edit({ n: 2 });
    await doc.flush();
    expect(onDisk(PATH)).toBe('{ "n": 1 }');
    docVersion.value++; // something else changed: the disk still says 1, but the edit isn't lost
    expect(doc.value.value).toEqual({ n: 2 });
    fail = false;
    doc.edit({ n: 3 });
    await doc.flush();
    expect(onDisk(PATH)).toBe('{"n":3}\n');
    await project.writeText(PATH, '{ "n": 7 }'); // outside changes are followed again
    docVersion.value++;
    expect(doc.value.value).toEqual({ n: 7 });
  });

  it("merges coalesced edits into one undo step and one write after the delay", async () => {
    vi.useFakeTimers();
    const doc = open();
    const spy = vi.spyOn(project, "writeText");
    doc.edit({ n: 2 }, { coalesce: true });
    vi.advanceTimersByTime(60);
    doc.edit({ n: 3 }, { coalesce: true });
    vi.advanceTimersByTime(60);
    doc.edit({ n: 4 }, { coalesce: true });
    expect(spy).not.toHaveBeenCalled();
    expect(doc.value.value).toEqual({ n: 4 });
    expect(doc.canUndo.value).toBe(true);
    vi.advanceTimersByTime(99);
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(spy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    await doc.flush();
    expect(onDisk(PATH)).toBe('{"n":4}\n');
    doc.undo();
    expect(doc.value.value).toEqual({ n: 1 });
    expect(doc.canUndo.value).toBe(false);
    await doc.flush();
    expect(onDisk(PATH)).toBe('{"n":1}\n');
  });

  it("ends a pending burst on undo", async () => {
    vi.useFakeTimers();
    const doc = open();
    doc.edit({ n: 5 }, { coalesce: true });
    doc.edit({ n: 6 }, { coalesce: true });
    doc.undo();
    expect(doc.value.value).toEqual({ n: 1 });
    expect(doc.canRedo.value).toBe(true);
    vi.useRealTimers();
    await doc.flush();
    expect(onDisk(PATH)).toBe('{"n":1}\n');
    doc.redo();
    await doc.flush();
    expect(doc.value.value).toEqual({ n: 6 });
    expect(onDisk(PATH)).toBe('{"n":6}\n');
  });

  it("undoes and redoes, writing each restored value", async () => {
    const doc = open();
    doc.edit({ n: 2 });
    doc.edit({ n: 3 });
    doc.undo();
    await doc.flush();
    expect(onDisk(PATH)).toBe('{"n":2}\n');
    doc.undo();
    await doc.flush();
    expect([doc.value.value, onDisk(PATH), doc.canUndo.value]).toEqual([{ n: 1 }, '{"n":1}\n', false]);
    doc.redo();
    doc.redo();
    await doc.flush();
    expect([doc.value.value, onDisk(PATH), doc.canRedo.value]).toEqual([{ n: 3 }, '{"n":3}\n', false]);
    doc.undo();
    doc.edit({ n: 9 }); // a new edit clears redo
    expect(doc.canRedo.value).toBe(false);
  });

  it("takes an outside change without touching history", async () => {
    const doc = open();
    doc.edit({ n: 2 });
    await doc.flush();
    await project.writeText(PATH, '{ "n": 7 }');
    docVersion.value++;
    expect(doc.value.value).toEqual({ n: 7 });
    expect(doc.canUndo.value).toBe(true);
    doc.undo();
    expect(doc.value.value).toEqual({ n: 1 });
  });

  it("doesn't take an outside change over a pending coalesced edit", () => {
    vi.useFakeTimers();
    const doc = open();
    doc.edit({ n: 2 }, { coalesce: true });
    docVersion.value++; // something else saved
    expect(doc.value.value).toEqual({ n: 2 });
  });

  it("refuses edits on a read-only project, saying so", () => {
    const sample = readOnlyProject("Flappy", { values: new Map<string, unknown>([[PATH, { n: 1 }]]), texts: new Map([[PATH, '{ "n": 1 }']]) });
    currentProject.value = sample;
    const doc = openAssetDocument<Thing>(sample, PATH, "thing");
    expect(doc.readOnly).toBe(true);
    doc.edit({ n: 2 });
    expect(doc.value.value).toEqual({ n: 1 });
    expect(doc.canUndo.value).toBe(false);
    expect(status.value?.text).toBe("Flappy is read-only. Open a project folder (or copy the sample) to change a.thing.json.");
  });

  it("follows a rename with its history, through moveAssets", async () => {
    const doc = open();
    doc.edit({ n: 2 });
    await doc.flush();
    expect(await moveAssets([[PATH, "things/c.thing.json"]])).toBe(true);
    expect(doc.path).toBe("things/c.thing.json");
    expect(open("things/c.thing.json")).toBe(doc);
    expect(doc.value.value).toEqual({ n: 2 });
    doc.undo();
    await doc.flush();
    expect(onDisk("things/c.thing.json")).toBe('{"n":1}\n');
    expect(onDisk(PATH)).toBeUndefined();
  });

  it("follows its folder's move", async () => {
    const doc = open();
    doc.edit({ n: 2 });
    await doc.flush();
    expect(await moveAssets([["things", "stuff"]])).toBe(true);
    expect(doc.path).toBe("stuff/a.thing.json");
    expect(open("stuff/a.thing.json")).toBe(doc);
    expect(doc.canUndo.value).toBe(true);
    doc.edit({ n: 3 });
    await doc.flush();
    expect(onDisk("stuff/a.thing.json")).toBe('{"n":3}\n');
  });

  it("is dropped with its history when its file is deleted", async () => {
    const doc = open();
    doc.edit({ n: 2 });
    await doc.flush();
    expect(await deleteAssets([PATH])).toBe(true);
    doc.edit({ n: 5 }); // a held reference does nothing
    await doc.flush();
    expect(onDisk(PATH)).toBeUndefined();
    await project.writeText(PATH, '{ "n": 8 }');
    const again = open();
    expect(again).not.toBe(doc);
    expect(again.value.value).toEqual({ n: 8 });
    expect(again.canUndo.value).toBe(false);
  });

  it("drops a deleted folder's documents", async () => {
    const doc = open();
    expect(await deleteAssets(["things/"])).toBe(true);
    expect(open()).not.toBe(doc);
  });

  it("drops the old project's documents when the project changes", async () => {
    const doc: AssetDocument<Thing> = open();
    doc.edit({ n: 2 });
    await doc.flush();
    currentProject.value = await openFolderProject(fs, ROOT);
    project = currentProject.value;
    const again = open();
    expect(again).not.toBe(doc);
    expect(again.value.value).toEqual({ n: 2 });
    expect(again.canUndo.value).toBe(false);
  });
});

describe("asset document history on disk (ADR 0027, 0133)", () => {
  const slot = (path: string, s: "a" | "b") => onDisk(`${ASSET_HISTORY_DIR}/${path}.history.${s}.json`);
  /** Open the document and wait for its saved history to load. */
  const openLoaded = async (path = PATH) => {
    const doc = open(path);
    await assetHistorySettled();
    return doc;
  };
  /** Write everything, close the project and open it again (as after a restart). */
  const reopen = async (...docs: AssetDocument<Thing>[]) => {
    for (const d of docs) await d.flush();
    await assetHistorySettled();
    currentProject.value = project = await openFolderProject(fs, ROOT);
    await assetHistorySettled();
  };

  it("saves the tree in the project folder and restores it when the project reopens", async () => {
    const doc = await openLoaded();
    doc.edit({ n: 2 }, { label: "Set n" });
    doc.edit({ n: 3 });
    await reopen(doc);
    expect(slot(PATH, "a") ?? slot(PATH, "b")).toBeDefined();
    const again = await openLoaded();
    expect(again).not.toBe(doc);
    expect(again.value.value).toEqual({ n: 3 });
    expect(again.canUndo.value).toBe(true);
    expect(again.history.states.map((s) => s.label)).toEqual(["Opened", "Set n", "Edit"]);
    expect(again.history.saved).toBe(again.history.current);
    again.undo();
    await again.flush();
    expect([again.value.value, onDisk(PATH)]).toEqual([{ n: 2 }, '{"n":2}\n']);
    again.undo();
    expect([again.value.value, again.canUndo.value, again.canRedo.value]).toEqual([{ n: 1 }, false, true]);
  });

  it("keeps the undone branch when editing after undo, across a reopen", async () => {
    const doc = await openLoaded();
    doc.edit({ n: 2 });
    doc.edit({ n: 3 });
    doc.undo();
    doc.edit({ n: 4 });
    expect(doc.canRedo.value).toBe(false);
    expect(doc.history.states.map((s) => [s.seq, s.parent])).toEqual([[0, -1], [1, 0], [2, 1], [3, 1]]);
    await reopen(doc);
    const again = await openLoaded();
    expect(again.value.value).toEqual({ n: 4 });
    again.history.jumpTo(2); // the undone branch
    await again.flush();
    expect([again.value.value, onDisk(PATH)]).toEqual([{ n: 3 }, '{"n":3}\n']);
    again.undo();
    again.redo(); // the branch last visited
    expect(again.value.value).toEqual({ n: 3 });
  });

  it("makes one step of a coalesced burst, and keeps view changes out of the steps", async () => {
    vi.useFakeTimers();
    const doc = open();
    doc.edit({ n: 2 }, { coalesce: true, label: "Drag n" });
    doc.edit({ n: 3 }, { coalesce: true });
    vi.useRealTimers();
    await doc.flush();
    doc.edit({ n: 30 }, { history: false }); // a view change: no new step
    await reopen(doc);
    const again = await openLoaded();
    expect(again.history.states.map((s) => s.label)).toEqual(["Opened", "Drag n"]);
    expect(again.value.value).toEqual({ n: 30 }); // the history still matches the file
    again.undo();
    again.redo();
    expect(again.value.value).toEqual({ n: 30 });
  });

  it("moves the saved history with its file, open or not", async () => {
    const doc = await openLoaded();
    doc.edit({ n: 2 });
    await doc.flush();
    await assetHistorySettled();
    expect(await moveAssets([[PATH, "things/c.thing.json"]])).toBe(true);
    doc.edit({ n: 3 });
    await reopen(doc);
    expect([slot(PATH, "a"), slot(PATH, "b")]).toEqual([undefined, undefined]);
    const moved = await openLoaded("things/c.thing.json");
    expect(moved.value.value).toEqual({ n: 3 });
    expect(moved.history.states).toHaveLength(3);
    // A folder move while no document is open.
    await reopen();
    expect(await moveAssets([["things", "stuff"]])).toBe(true);
    await reopen();
    const inFolder = await openLoaded("stuff/c.thing.json");
    expect(inFolder.history.states).toHaveLength(3);
    inFolder.undo();
    expect(inFolder.value.value).toEqual({ n: 2 });
  });

  it("deletes the saved history with its file, so a new file at that path starts afresh", async () => {
    const doc = await openLoaded();
    doc.edit({ n: 2 });
    doc.edit({ n: 1 }); // back to the content a new file will have
    await reopen(doc);
    expect(await deleteAssets([PATH])).toBe(true);
    await assetHistorySettled();
    expect([slot(PATH, "a"), slot(PATH, "b")]).toEqual([undefined, undefined]);
    await project.writeText(PATH, '{"n":1}\n');
    const fresh = await openLoaded();
    expect(fresh.canUndo.value).toBe(false);
    expect(fresh.history.states).toHaveLength(1);
  });

  it("deletes a deleted folder's histories", async () => {
    const doc = await openLoaded();
    doc.edit({ n: 2 });
    await reopen(doc);
    expect(await deleteAssets(["things/"])).toBe(true);
    await assetHistorySettled();
    expect([...fs.files.keys()].filter((k) => k.includes("asset-history"))).toEqual([]);
  });

  it("offers edits the file didn't get back through redo", async () => {
    const doc = await openLoaded();
    doc.edit({ n: 2 });
    doc.edit({ n: 3 });
    await doc.flush();
    await assetHistorySettled();
    fs.files.set(joinPath(ROOT, PATH), '{"n":2}\n'); // the last write didn't land before the editor closed
    await reopen();
    const again = await openLoaded();
    expect(again.value.value).toEqual({ n: 2 });
    expect(status.value?.text).toMatch(/weren't written/);
    expect(again.canRedo.value).toBe(true);
    again.redo();
    expect(again.value.value).toEqual({ n: 3 });
  });

  it("sets aside a history that doesn't match a file changed outside the editor", async () => {
    const doc = await openLoaded();
    doc.edit({ n: 2 });
    await reopen(doc);
    fs.files.set(joinPath(ROOT, PATH), '{"n":9}\n');
    await reopen();
    const again = await openLoaded();
    expect(status.value?.text).toMatch(/changed outside the editor/);
    expect([again.value.value, again.canUndo.value]).toEqual([{ n: 9 }, false]);
  });

  it("follows an outside change while open, so the history still matches the file", async () => {
    const doc = await openLoaded();
    doc.edit({ n: 2 });
    await doc.flush();
    await project.writeText(PATH, '{ "n": 7 }');
    docVersion.value++;
    expect(doc.value.value).toEqual({ n: 7 });
    await reopen(doc);
    const again = await openLoaded();
    expect([again.value.value, again.canUndo.value]).toEqual([{ n: 7 }, true]);
    again.undo();
    expect(again.value.value).toEqual({ n: 1 });
  });

  it("survives a torn write: the other slot holds the previous generation", async () => {
    const doc = await openLoaded();
    doc.edit({ n: 2 });
    await doc.flush();
    await assetHistorySettled();
    doc.edit({ n: 3 });
    await reopen(doc);
    const newest = ["a", "b"].map((s) => joinPath(ROOT, `${ASSET_HISTORY_DIR}/${PATH}.history.${s}.json`)).sort((x, y) => JSON.parse(fs.files.get(y) as string).generation - JSON.parse(fs.files.get(x) as string).generation)[0];
    fs.files.set(newest, (fs.files.get(newest) as string).slice(0, 40)); // torn
    fs.files.set(joinPath(ROOT, PATH), '{"n":2}\n'); // and the file as the older generation knew it
    await reopen();
    const again = await openLoaded();
    expect(again.canUndo.value).toBe(true);
    again.undo();
    expect(again.value.value).toEqual({ n: 1 });
  });

  it("keeps history in per-user storage when asked, and moves and deletes it there", async () => {
    historyLocation.value = "user";
    const doc = await openLoaded();
    doc.edit({ n: 2 });
    await reopen(doc);
    expect([...fs.files.keys()].some((k) => k.includes("asset-history"))).toBe(false);
    expect((await userStorage.list("cache")).some((k) => k.includes(encodeURIComponent(PATH)))).toBe(true);
    expect(await moveAssets([[PATH, "things/c.thing.json"]])).toBe(true);
    await assetHistorySettled();
    const moved = await openLoaded("things/c.thing.json");
    expect(moved.canUndo.value).toBe(true);
    await reopen(moved);
    expect(await deleteAssets(["things/c.thing.json"])).toBe(true);
    await assetHistorySettled();
    expect((await userStorage.list("cache")).filter((k) => k.startsWith("asset-history"))).toEqual([]);
  });

  it("switching the location writes the tree there right away", async () => {
    const doc = await openLoaded();
    doc.edit({ n: 2 });
    await doc.flush();
    await assetHistorySettled();
    historyLocation.value = "user";
    await assetHistorySettled();
    expect((await userStorage.list("cache")).some((k) => k.startsWith("asset-history"))).toBe(true);
  });

  it("keeps no history file for a read-only project", async () => {
    const sample = readOnlyProject("Flappy", { values: new Map<string, unknown>([[PATH, { n: 1 }]]), texts: new Map([[PATH, '{ "n": 1 }']]) });
    currentProject.value = sample;
    openAssetDocument<Thing>(sample, PATH, "thing");
    await assetHistorySettled();
    expect(await userStorage.list("cache")).toEqual([]);
  });
});

describe("the focused asset document (for the History panel)", () => {
  it("follows focus and clicks into an asset editor, and keeps it for clicks in the History panel", () => {
    const listeners = new Map<string, (e: Event) => void>();
    const fake = { addEventListener: (type: string, l: (e: Event) => void) => listeners.set(type, l), removeEventListener: (type: string) => listeners.delete(type) };
    vi.stubGlobal("document", fake);
    try {
      const doc = open();
      /** An element inside `selector`'s match (with `path` as its data-asset-document), or inside nothing. */
      const target = (inside: string | null) => ({
        closest: (sel: string) => (sel === inside ? { getAttribute: () => PATH } : null),
      });
      const fire = (type: string, inside: string | null) => listeners.get(type)!({ target: target(inside) } as unknown as Event);
      expect(focusedAssetDocument.value).toBeNull();
      fire("focusin", "[data-asset-document]");
      expect(focusedAssetDocument.value).toBe(doc);
      fire("pointerdown", KEEPS_HISTORY_FOCUS); // the History panel or the menu bar
      expect(focusedAssetDocument.value).toBe(doc);
      fire("pointerdown", null); // the viewport
      expect(focusedAssetDocument.value).toBeNull();
      fire("focusin", "[data-asset-document]");
      _reset();
      expect(focusedAssetDocument.value).toBeNull();
      expect(listeners.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
