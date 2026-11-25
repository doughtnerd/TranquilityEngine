// The Studio's side of sharing a project folder (ADR 0341): its lock, following outside changes, moves that leave the
// editor what it owns, the editor's hand-off, and finding a browser folder among the recent projects. Driven through
// each module's own interface over in-memory folders, with open asset documents as callers hold them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAssetDocument, type AssetDocument } from "../../editor/assetDocuments";
import { MemoryFileSystem } from "../../editor/memoryFs";
import { acquireLock, parsePendingMoves } from "../../editor/projectLocks";
import { joinPath, openFolderProject, useProjectAssets, type EditorProject } from "../../editor/projects";
import type { RecentProject } from "../../editor/recentProjects";
import { assetKinds, type AssetKindContribution } from "../../editor/sdk/contributions";
import { currentProject, status } from "../../editor/state";
import { ROOT, useCoreAssetKinds } from "../../editor/testing";
import type { StudioAudioRuntime } from "../runtime/studioAudioHost";
import { recentForMount } from "./startQuery";
import { moveStudioAssets, renameStudioAsset } from "./studioAssetMoves";
import { studioProjects } from "./studioProject";
import { applyStudioChanges, startStudioProjectWatch, stopStudioProjectWatch } from "./studioProjectWatch";

useCoreAssetKinds();

interface Thing {
  n: number;
  clip?: string;
}

const PATH = "things/a.thing.json";
const SCENE = "main.scene.json";
const sceneText = JSON.stringify({ format: "myco.scene@1", nodes: [{ id: "a", name: "Music", components: { "engine.AudioSource": { clip: "music/town.mp3" } } }] }, null, 2);
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
  fs.files.set(at(PATH), '{ "n": 1, "clip": "music/town.mp3" }');
  fs.files.set(at(SCENE), sceneText);
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
        const o = (raw ?? {}) as { n?: unknown; clip?: unknown };
        return { value: { n: typeof o.n === "number" ? o.n : 0, ...(typeof o.clip === "string" ? { clip: o.clip } : {}) }, problems: [] };
      },
      format: (value) => `${JSON.stringify(value)}\n`,
      empty: () => ({ n: 0 }),
      writeDelay: 10,
    },
  });
  await openProject(new MemoryFileSystem());
});

afterEach(async () => {
  await stopStudioProjectWatch();
  await Promise.all([...opened].map((d) => d.flush()));
  opened.clear();
  currentProject.value = null;
  status.value = null;
  unregister();
});

describe("the Studio's lock and watch", () => {
  it("holds .myco/locks/studio.json with the shell's pid while open, follows live changes, and lets go on stop", async () => {
    const folder = new WatchedFs();
    await openProject(folder);
    const doc = open();
    await startStudioProjectWatch(project, async () => 4242);
    expect(JSON.parse(onDisk(".myco/locks/studio.json") as string)).toMatchObject({ app: "studio", pid: 4242 });
    fs.files.set(at(PATH), '{ "n": 4 }'); // the editor (or git) changed it
    folder.fire(PATH);
    await new Promise((r) => setTimeout(r, 0));
    await stopStudioProjectWatch();
    expect(doc.value.value).toEqual({ n: 4 });
    expect(doc.canUndo.value).toBe(false); // amended: no undo step
    expect(onDisk(".myco/locks/studio.json")).toBeUndefined();
    expect(folder.listeners.size).toBe(0);
  });

  it("refreshes the project's files and drops documents of deleted ones; leaves pending moves to the editor", async () => {
    const doc = open();
    await acquireLock(fs, ROOT, "editor", 7);
    fs.files.set(at(".myco/locks/pending-moves.json"), '{ "moves": [{ "from": "a.wav", "to": "b.wav" }] }');
    fs.files.delete(at(PATH));
    fs.files.set(at("sfx/hit.wav"), new Uint8Array([9]));
    const result = await applyStudioChanges(project, { files: [PATH, "sfx/hit.wav"] });
    expect(result.removed).toEqual([PATH]);
    expect(result.added).toEqual(["sfx/hit.wav"]);
    expect(project.assets.has("sfx/hit.wav")).toBe(true);
    expect(onDisk(".myco/locks/pending-moves.json")).toBeDefined();
    doc.edit({ n: 9 }); // a dropped document takes no edits
    await doc.flush();
    expect(onDisk(PATH)).toBeUndefined();
  });

  it("doesn't share a project it can't write (a sample)", async () => {
    await startStudioProjectWatch({ ...project, canSave: false } as EditorProject, async () => 1);
    expect(onDisk(".myco/locks/studio.json")).toBeUndefined();
  });
});

describe("Studio moves and renames", () => {
  it("with no editor holding the project, rewrites every reference itself (scenes included)", async () => {
    expect(await moveStudioAssets([["music/town.mp3", "audio/town.mp3"]])).toBe(true);
    expect(project.files).toContain("audio/town.mp3");
    expect(onDisk(SCENE)).toContain('"clip": "audio/town.mp3"');
    expect(JSON.parse(onDisk(PATH) as string)).toMatchObject({ clip: "audio/town.mp3" });
    expect(onDisk(".myco/locks/pending-moves.json")).toBeUndefined();
  });

  it("with the editor holding it, leaves the moves for the editor first and rewrites only the Studio's own files", async () => {
    await acquireLock(fs, ROOT, "editor", 7);
    const doc = open();
    expect(await renameStudioAsset("music/town.mp3", "theme.mp3")).toBe(true);
    expect(parsePendingMoves(onDisk(".myco/locks/pending-moves.json") as string).moves).toEqual([{ from: "music/town.mp3", to: "music/theme.mp3" }]);
    expect(project.files).toContain("music/theme.mp3");
    expect(onDisk("music/town.mp3")).toBeUndefined();
    expect(onDisk(SCENE)).toBe(sceneText); // the editor's to rewrite
    expect(doc.value.value).toMatchObject({ clip: "music/theme.mp3" }); // an open document follows in its history
    await doc.flush();
    expect(JSON.parse(onDisk(PATH) as string)).toMatchObject({ clip: "music/theme.mp3" });
    expect(status.value?.text).toMatch(/^Renamed music\/town\.mp3 to music\/theme\.mp3\. .*The editor has the project open/);
  });

  it("refuses a move onto an existing file, leaving nothing for the editor", async () => {
    await acquireLock(fs, ROOT, "editor", 7);
    expect(await moveStudioAssets([["music/town.mp3", PATH]])).toBe(false);
    expect(onDisk(".myco/locks/pending-moves.json")).toBeUndefined();
    expect(status.value?.text).toMatch(/already exists/);
  });
});

describe("the editor's hand-off", () => {
  const runtime = { open: vi.fn(async () => {}), close: vi.fn() } as unknown as StudioAudioRuntime;

  it("on the open project, goes to the request's screen and asset without reopening it", async () => {
    const openRoute = vi.fn();
    const projects = studioProjects({ runtime, openRoute });
    await projects.handOff({ project: ROOT, asset: "music/boss.playlist.json" });
    expect(currentProject.value).toBe(project);
    expect(openRoute).toHaveBeenCalledWith({ screen: "playlists", asset: "music/boss.playlist.json" });
    await projects.handOff({ project: ROOT, screen: "mixer" });
    expect(openRoute).toHaveBeenLastCalledWith({ screen: "mixer" });
  });

  it("with no project, shows the start screen", async () => {
    const openRoute = vi.fn();
    await studioProjects({ runtime, openRoute }).handOff({ project: null });
    expect(currentProject.value).toBeNull();
    expect(openRoute).not.toHaveBeenCalled();
  });

  it("a connect request (the launcher's Connect to Game…) keeps the open project", async () => {
    const openRoute = vi.fn();
    await studioProjects({ runtime, openRoute }).handOff({ project: null, connect: true });
    expect(currentProject.value).toBe(project);
    expect(openRoute).not.toHaveBeenCalled();
  });

  it("says why when this Studio can't open project folders", async () => {
    const projects = studioProjects({ runtime, openRoute: vi.fn() });
    await expect(projects.handOff({ project: "/elsewhere" })).rejects.toThrow(/can't open project folders/);
  });
});

describe("a browser folder handed over by path", () => {
  const entry = (id: string, path: string, lastOpened: number, kind: RecentProject["kind"] = "handle"): RecentProject => ({ id, name: path, path, lastOpened, kind });

  it("is the newest recent folder handle the editor's tab mounted at that path", () => {
    const recent = [entry("old", "Racer", 1), entry("desk", "/Racer", 5, "path"), entry("new", "Racer", 3), entry("x", "Other", 9)];
    expect(recentForMount(recent, "/Racer")?.id).toBe("new");
    expect(recentForMount(recent, "/Racer (2)")?.id).toBe("new");
    expect(recentForMount([entry("s", "a/b", 1)], "/a_b")?.id).toBe("s");
    expect(recentForMount(recent, "/Missing")).toBeNull();
  });
});
