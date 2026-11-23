// Deleting in the Playlists tree over a project in memory, through the screen's actions (UI pass T12, T11): deleting a
// folder moves what's inside up a level (names taken there get a number) and Undo puts the folder back with its
// contents; deleting a playlist file can be undone, its links in other playlists coming back too.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { joinPath, openFolderProject, type EditorProject } from "../../../editor/projects";
import { activatePlugins, deactivatePlugin, type EditorPlugin } from "../../../editor/sdk/plugins";
import { currentProject, status } from "../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../editor/testing";
import { emptyPlaylist } from "../../../engine/audio/playlist/format";
import type { PlaylistAsset } from "../../../engine/audio/playlist/types";
import { registerStudioAssetKinds } from "../../../plugins/audio/editor/studioAssets";
import { toasts } from "../../shell/studioServices";
import { askDeleteFolder, confirmDelete, deleteFolderKeepingContents, deletingFolder, loadPlaylist } from "./playlistsScreen";
import { planDelete } from "./structureEdits";

const plugin: EditorPlugin = { manifest: { name: "studio-playlist-deletes-test", version: "1.0.0" } as EditorPlugin["manifest"], activate: registerStudioAssetKinds };
beforeAll(() => activatePlugins([plugin]));
afterAll(() => deactivatePlugin(plugin.manifest.name));

const queue = (patch: Partial<PlaylistAsset> = {}): string => JSON.stringify({ ...emptyPlaylist("queue"), ...patch });
const link = (playlist: string) => ({ kind: "linked", playlist, volume: 0, pitch: 0, weight: 1, atZeroWeight: "stop", curves: {} });

let fs: MemoryFileSystem;
let project: EditorProject;

beforeEach(async () => {
  fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  fs.files.set(joinPath(ROOT, "audio/steps.playlist.json"), queue());
  fs.files.set(joinPath(ROOT, "audio/foot/steps.playlist.json"), queue());
  fs.files.set(joinPath(ROOT, "audio/foot/grass.playlist.json"), queue());
  fs.files.set(joinPath(ROOT, "audio/foot/inner/gravel.playlist.json"), queue());
  fs.files.set(joinPath(ROOT, "audio/world.playlist.json"), queue({ entries: [link("audio/foot/grass.playlist.json")] as PlaylistAsset["entries"] }));
  project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
});

afterEach(() => {
  currentProject.value = null;
  status.value = null;
  deletingFolder.value = null;
});

/** Press Undo on the latest toast. */
function undoLastToast(): void {
  const t = toasts.toasts.peek().at(-1);
  expect(t?.undoLabel).toBe("Undo");
  toasts.undo(t!.id);
}

describe("deleting a folder in the Playlists tree", () => {
  it("asks first, saying how many items move up and where", () => {
    askDeleteFolder("audio/foot");
    expect(deletingFolder.value).toEqual({ path: "audio/foot", items: 3, to: "audio" });
  });

  it("moves what's inside up a level and deletes only the empty folder", async () => {
    expect(await deleteFolderKeepingContents("audio/foot")).toBe(true);
    expect(project.folders).not.toContain("audio/foot");
    expect(project.files).toEqual(expect.arrayContaining(["audio/grass.playlist.json", "audio/steps 2.playlist.json", "audio/inner/gravel.playlist.json", "audio/steps.playlist.json"]));
    expect(project.files.some((f) => f.startsWith("audio/foot/"))).toBe(false);
    // References follow the move: the link in world now names grass where it went.
    expect(loadPlaylist("audio/world.playlist.json")!.entries[0]).toMatchObject({ kind: "linked", playlist: "audio/grass.playlist.json" });
  });

  it("Undo puts the folder back with everything in it", async () => {
    await deleteFolderKeepingContents("audio/foot");
    undoLastToast();
    await vi.waitFor(() => expect(project.files).toContain("audio/foot/inner/gravel.playlist.json"));
    expect(project.folders).toContain("audio/foot");
    expect(project.files).toEqual(expect.arrayContaining(["audio/foot/steps.playlist.json", "audio/foot/grass.playlist.json", "audio/steps.playlist.json"]));
    expect(project.files).not.toContain("audio/steps 2.playlist.json");
    expect(loadPlaylist("audio/world.playlist.json")!.entries[0]).toMatchObject({ playlist: "audio/foot/grass.playlist.json" });
  });
});

describe("deleting a playlist file", () => {
  const plan = () => planDelete({ kind: "file", path: "audio/foot/grass.playlist.json" }, "grass", loadPlaylist, (p) => (p === "audio/foot/grass.playlist.json" ? ["audio/world.playlist.json"] : []))!;

  it("deletes it, removing its links, and Undo brings it and its links back", async () => {
    await confirmDelete(plan(), "up", "remove");
    expect(project.files).not.toContain("audio/foot/grass.playlist.json");
    expect(loadPlaylist("audio/world.playlist.json")!.entries).toEqual([]);
    undoLastToast();
    await vi.waitFor(() => expect(project.files).toContain("audio/foot/grass.playlist.json"));
    expect(loadPlaylist("audio/foot/grass.playlist.json")).toMatchObject({ type: "queue", entries: [] });
    expect(loadPlaylist("audio/world.playlist.json")!.entries[0]).toMatchObject({ kind: "linked", playlist: "audio/foot/grass.playlist.json" });
  });
});
