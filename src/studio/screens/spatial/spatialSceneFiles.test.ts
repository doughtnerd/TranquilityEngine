// The Scenes panel's file actions, driven through the screen's own actions (`openScene`, `deleteScenes`, `editScene`)
// over a folder project in memory: deleting test scenes happens at once, into the project's trash as one deletion (the
// Studio asset library's delete, ADR 0433), and the toast's Undo brings them back exactly (D27, the prototype's
// "Deleted <name> · Undo"), so no "can't be undone" question comes first (UI pass SC5).
import { signal } from "@preact/signals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audioTestSceneToJson } from "../../../engine/audio/spatial/testScene";
import { acquireLock } from "../../../editor/projectLocks";
import { joinPath, openFolderProject, type EditorProject } from "../../../editor/projects";
import { askBeforeDeletingAssets } from "../../../editor/preferences";
import { currentProject, status } from "../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../editor/testing";
import { createRouter, type HashLocation } from "../../shell/route";
import { provideStudio, toasts } from "../../shell/studioServices";
import type { StudioAudioRuntime } from "../../runtime/studioAudioHost";
import { blankScene } from "./newScene";
import { deleteScenes, docFor, loadScene, openPath, openScene, stopAudition } from "./spatialScreen";

const PATH = "audio/scenes/canyon_run.audioscene.json";
const OTHER = "audio/scenes/desert.audioscene.json";
let fs: MemoryFileSystem;
let project: EditorProject;
const onDisk = (path: string) => fs.files.get(joinPath(ROOT, path));
const lastToast = () => toasts.toasts.peek().at(-1)!;

beforeEach(async () => {
  fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  fs.files.set(joinPath(ROOT, PATH), JSON.stringify(audioTestSceneToJson(blankScene("Canyon level"))));
  fs.files.set(joinPath(ROOT, OTHER), JSON.stringify(audioTestSceneToJson(blankScene("Desert level"))));
  project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
  const hash: HashLocation = { get: () => "#/spatial", set: () => {}, listen: () => () => {} };
  provideStudio({ router: createRouter(hash), runtime: { playable: signal(true), state: signal({ kind: "running" }) } as unknown as StudioAudioRuntime });
});

afterEach(() => {
  stopAudition();
  for (const t of toasts.toasts.peek()) toasts.dismiss(t.id);
  currentProject.value = null;
  status.value = null;
});

describe("deleting a test scene", () => {
  it("deletes at once, even with asking before deletes on, opens the next scene, and the toast's Undo brings it back as it was", async () => {
    expect(askBeforeDeletingAssets.value).toBe(true);
    const before = onDisk(PATH);
    openScene(PATH);
    await deleteScenes([PATH]);
    expect(project.files).not.toContain(PATH);
    expect(onDisk(`.myco/trash/1/${PATH}`)).toBe(before);
    expect(openPath.value).toBe(OTHER);
    const toast = lastToast();
    expect(toast.text).toBe("Deleted canyon_run");
    expect(toast.undoLabel).toBe("Undo");
    toasts.undo(toast.id);
    await vi.waitFor(() => expect(project.files).toContain(PATH));
    expect(onDisk(PATH)).toBe(before);
    expect(openPath.value).toBe(PATH); // the scene that was open opens again
    expect(loadScene(PATH)?.folder).toBe("Canyon level");
  });

  it("writes a pending edit before the scene goes, so Undo brings the edit back too", async () => {
    const doc = docFor(PATH)!;
    doc.edit({ ...doc.value.peek(), folder: "Renamed level" }, { label: "Folder", coalesce: true }); // written after a quiet spell
    await deleteScenes([PATH]);
    toasts.undo(lastToast().id);
    await vi.waitFor(() => expect(project.files).toContain(PATH));
    expect(loadScene(PATH)?.folder).toBe("Renamed level");
  });

  it("deletes several scenes as one deletion: one toast, one Undo for all, the open one closed when none is left", async () => {
    openScene(PATH);
    await deleteScenes([PATH, OTHER]);
    expect(project.files).not.toContain(PATH);
    expect(project.files).not.toContain(OTHER);
    expect(openPath.value).toBeNull();
    expect(toasts.toasts.peek().map((t) => t.text)).toEqual(["Deleted 2 scenes"]);
    toasts.undo(lastToast().id);
    await vi.waitFor(() => expect(project.files).toEqual(expect.arrayContaining([PATH, OTHER])));
    expect(loadScene(OTHER)?.folder).toBe("Desert level");
  });

  it("goes ahead while the editor holds the project: a delete leaves it no moves", async () => {
    await acquireLock(fs, ROOT, "editor", 7);
    await deleteScenes([PATH]);
    expect(project.files).not.toContain(PATH);
    expect(onDisk(".myco/locks/pending-moves.json")).toBeUndefined();
  });

  it("refuses a scene that's gone and says why, deleting none and with no toast", async () => {
    await deleteScenes([PATH, "audio/scenes/nope.audioscene.json"]);
    expect(project.files).toContain(PATH);
    expect(status.value?.text).toBe("Can't delete 2 scenes: it's gone already.");
    await deleteScenes(["audio/scenes/nope.audioscene.json"]);
    expect(status.value?.text).toBe("Can't delete nope.audioscene.json: it's gone already.");
    expect(toasts.toasts.peek()).toEqual([]);
  });
});
