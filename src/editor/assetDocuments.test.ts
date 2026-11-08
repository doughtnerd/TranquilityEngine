import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAssets } from "./assetDelete";
import { _reset, openAssetDocument, type AssetDocument } from "./assetDocuments";
import { moveAssets } from "./assetOps";
import { askBeforeDeletingAssets } from "./preferences";
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
});

afterEach(() => {
  _reset();
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
