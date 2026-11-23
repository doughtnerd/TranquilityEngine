// The editor following outside changes to its project folder (ADR 0341): driven through the module's own interface
// (applyProjectChanges, startProjectWatch) over in-memory folders, with open asset documents as callers hold them.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets } from "../engine/scene/Assets";
import { openAssetDocument, type AssetDocument } from "./assetDocuments";
import { applyProjectChanges, startProjectWatch, stopProjectWatch } from "./editorProjectWatch";
import { MemoryFileSystem } from "./memoryFs";
import { recordPendingMoves } from "./projectLocks";
import { joinPath, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { assetKinds, type AssetKindContribution } from "./sdk/contributions";
import { currentProject, status } from "./state";
import { ROOT, useCoreAssetKinds } from "./testing";

useCoreAssetKinds();

interface Thing {
  n: number;
}

const PATH = "things/a.thing.json";
let fs: MemoryFileSystem;
let project: EditorProject;
let unregister: () => void;
const opened = new Set<AssetDocument<Thing>>();
const at = (path: string) => joinPath(ROOT, path);
const onDisk = (path: string) => fs.files.get(at(path));
const open = (path = PATH) => {
  const doc = openAssetDocument<Thing>(project, path, "thing");
  opened.add(doc);
  return doc;
};
const NO_FILES = { files: [] as string[], pendingMoves: false };

/** A desktop-like folder: `fire` reports changed paths, as Tauri's `watch` does. */
class WatchedFs extends MemoryFileSystem {
  listeners = new Set<(paths: string[]) => void>();
  async watch(_path: string, onChange: (paths: string[]) => void) {
    this.listeners.add(onChange);
    return () => void this.listeners.delete(onChange);
  }
  fire(...paths: string[]) {
    for (const l of this.listeners) l(paths.map(at));
  }
}

async function openProject(folder: MemoryFileSystem): Promise<void> {
  fs = folder;
  fs.files.set(at("project.json"), "{}");
  fs.files.set(at(PATH), '{ "n": 1 }');
  fs.files.set(at("data/refs.json"), '{ "clip": "music/town.mp3" }');
  fs.files.set(at("music/town.mp3"), new Uint8Array([1, 2, 3]));
  project = await openFolderProject(fs, ROOT);
  useProjectAssets(project);
  currentProject.value = project;
}

beforeEach(async () => {
  unregister = assetKinds.register(<AssetKindContribution<Thing>>{
    id: "thing",
    extensions: [".thing.json"],
    label: "Thing",
    icon: "",
    format: {
      parse: (raw) => {
        const n = (raw as { n?: unknown } | undefined)?.n;
        return { value: { n: typeof n === "number" ? n : 0 }, problems: [] };
      },
      format: (value) => `${JSON.stringify(value)}\n`,
      empty: () => ({ n: 0 }),
      writeDelay: 10,
    },
  });
  await openProject(new MemoryFileSystem());
});

afterEach(async () => {
  await stopProjectWatch();
  await Promise.all([...opened].map((d) => d.flush()));
  opened.clear();
  currentProject.value = null;
  status.value = null;
  unregister();
});

describe("outside changes to the project's files", () => {
  it("an open document takes what its file holds now, with no undo step", async () => {
    const doc = open();
    const states = doc.history.states.length;
    fs.files.set(at(PATH), '{ "n": 2 }'); // the Studio saved it
    const result = await applyProjectChanges(project, { files: [PATH], pendingMoves: false });
    expect(result.changed).toEqual([PATH]);
    expect(doc.value.value).toEqual({ n: 2 });
    expect(doc.canUndo.value).toBe(false);
    expect(doc.history.states.length).toBe(states);
    expect(project.textOf(PATH)).toBe('{ "n": 2 }');
  });

  it("what the editor wrote itself reads as unchanged", async () => {
    const doc = open();
    doc.edit({ n: 5 });
    await doc.flush();
    const result = await applyProjectChanges(project, { files: [PATH], pendingMoves: false });
    expect(result).toEqual({ changed: [], added: [], removed: [] });
    expect(doc.canUndo.value).toBe(true); // its own step stays
  });

  it("adds new files, drops deleted ones with their open documents, and reads a folder that came in", async () => {
    const doc = open();
    fs.files.delete(at(PATH));
    fs.files.set(at("things/c.thing.json"), '{ "n": 3 }');
    fs.files.set(at("sfx/hit.wav"), new Uint8Array([9]));
    fs.files.set(at("sfx/deep/boom.wav.meta.json"), "{}");
    const result = await applyProjectChanges(project, { files: [PATH, "things/c.thing.json", "sfx"], pendingMoves: false });
    expect(result.removed).toEqual([PATH]);
    expect([...result.added].sort()).toEqual(["sfx/deep/boom.wav.meta.json", "sfx/hit.wav", "things/c.thing.json"]);
    expect(project.files).not.toContain(PATH);
    expect(project.files).toContain("things/c.thing.json");
    expect(project.folders).toContain("sfx/deep");
    doc.edit({ n: 9 }); // a dropped document takes no edits
    await doc.flush();
    expect(onDisk(PATH)).toBeUndefined();
  });

  it("serves a binary file's new bytes and tells Assets.onChanged listeners", async () => {
    const seen: string[] = [];
    const off = Assets.onChanged((path) => seen.push(path));
    try {
      const before = project.assets.get("music/town.mp3");
      fs.files.set(at("music/town.mp3"), new Uint8Array([4, 5, 6, 7]));
      const result = await applyProjectChanges(project, { files: ["music/town.mp3"], pendingMoves: false });
      expect(result.changed).toEqual(["music/town.mp3"]);
      expect(project.assets.get("music/town.mp3")).not.toBe(before);
      expect(project.sizeOf("music/town.mp3")).toBe(4);
      expect(seen).toEqual(["music/town.mp3"]);
      // The same bytes again (a touch): nothing to tell.
      expect((await applyProjectChanges(project, { files: ["music/town.mp3"], pendingMoves: false })).changed).toEqual([]);
    } finally {
      off();
    }
  });

  it("keeps serving a JSON file that changed into something that doesn't parse (half-written)", async () => {
    const doc = open();
    fs.files.set(at(PATH), '{ "n": ');
    expect((await applyProjectChanges(project, { files: [PATH], pendingMoves: false })).changed).toEqual([]);
    expect(doc.value.value).toEqual({ n: 1 });
  });

  it("ignores changes once another project is open", async () => {
    const old = project;
    await openProject(new MemoryFileSystem());
    fs.files.set(at(PATH), '{ "n": 7 }');
    expect(await applyProjectChanges(old, { files: [PATH], pendingMoves: false })).toEqual({ changed: [], added: [], removed: [] });
  });
});

describe("the Audio Studio's pending moves", () => {
  it("follows moves the Studio made on disk: documents, references, the project's files; then deletes the file", async () => {
    const doc = open();
    // The Studio records its moves, then moves the files (a file and a folder).
    await recordPendingMoves(fs, ROOT, [
      { from: "music/town.mp3", to: "audio/town.mp3" },
      { from: "things", to: "stuff" },
    ]);
    await fs.mkdir(at("audio"));
    await fs.rename(at("music/town.mp3"), at("audio/town.mp3"));
    await fs.rename(at("things"), at("stuff"));

    await applyProjectChanges(project, { files: ["music/town.mp3", "audio/town.mp3", "things", "stuff"], pendingMoves: true });
    expect(JSON.parse(onDisk("data/refs.json") as string)).toEqual({ clip: "audio/town.mp3" });
    expect(project.files).toContain("audio/town.mp3");
    expect(project.files).not.toContain("music/town.mp3");
    expect(project.files).toContain("stuff/a.thing.json");
    expect(doc.path).toBe("stuff/a.thing.json");
    expect(doc.value.value).toEqual({ n: 1 }); // followed, not dropped
    expect(onDisk(".myco/locks/pending-moves.json")).toBeUndefined();
    expect(status.value?.text).toMatch(/^The Audio Studio moved 2 items\. Updated references in data\/refs\.json/);
  });

  it("applies moves waiting when the project opens", async () => {
    await recordPendingMoves(fs, ROOT, [{ from: "music/town.mp3", to: "music/theme.mp3" }]);
    await fs.rename(at("music/town.mp3"), at("music/theme.mp3"));
    await startProjectWatch(project);
    expect(JSON.parse(onDisk("data/refs.json") as string)).toEqual({ clip: "music/theme.mp3" });
    expect(project.files).toContain("music/theme.mp3");
  });
});

describe("sharing the folder while it's open", () => {
  it("holds the editor's lock while watching, follows live changes, and lets go on stop", async () => {
    const folder = new WatchedFs();
    await openProject(folder);
    const doc = open();
    await startProjectWatch(project);
    expect(JSON.parse(onDisk(".myco/locks/editor.json") as string)).toMatchObject({ app: "editor", pid: null });
    fs.files.set(at(PATH), '{ "n": 4 }');
    folder.fire(PATH);
    await new Promise((r) => setTimeout(r, 0));
    await stopProjectWatch(); // waits for nothing more; the batch above was already handled
    expect(doc.value.value).toEqual({ n: 4 });
    expect(onDisk(".myco/locks/editor.json")).toBeUndefined();
    expect(folder.listeners.size).toBe(0);
    await applyProjectChanges(project, NO_FILES); // harmless after stopping
  });

  it("doesn't share a project it can't write", async () => {
    const readOnly = { ...project, canSave: false } as EditorProject;
    await startProjectWatch(readOnly);
    expect(onDisk(".myco/locks/editor.json")).toBeUndefined();
  });
});
