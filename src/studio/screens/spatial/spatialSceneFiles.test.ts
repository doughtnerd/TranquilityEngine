// The Scenes panel's file actions, driven through the screen's own actions (`openScene`, `deleteScenes`) over a project
// in memory: deleting a test scene happens at once and the toast's Undo writes it back (D27, the prototype's
// "Deleted <name> · Undo"), so no "can't be undone" question comes first (UI pass SC5).
import { signal } from "@preact/signals";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { audioTestSceneToJson } from "../../../engine/audio/spatial/testScene";
import { joinPath, openFolderProject, type EditorProject } from "../../../editor/projects";
import { askBeforeDeletingAssets } from "../../../editor/preferences";
import { currentProject, status } from "../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../editor/testing";
import { createRouter, type HashLocation } from "../../shell/route";
import { provideStudio, toasts } from "../../shell/studioServices";
import type { StudioAudioRuntime } from "../../runtime/studioAudioHost";
import { blankScene } from "./newScene";
import { deleteScenes, loadScene, openPath, openScene, stopAudition } from "./spatialScreen";

const PATH = "audio/scenes/canyon_run.audioscene.json";
let project: EditorProject;

beforeEach(async () => {
  const fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  fs.files.set(joinPath(ROOT, PATH), JSON.stringify(audioTestSceneToJson(blankScene("Canyon level"))));
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
  it("deletes at once, even with asking before deletes on, and the toast's Undo brings it back", async () => {
    expect(askBeforeDeletingAssets.value).toBe(true);
    openScene(PATH);
    await deleteScenes([PATH]);
    expect(project.files).not.toContain(PATH);
    expect(openPath.value).toBeNull();
    const toast = toasts.toasts.peek().at(-1)!;
    expect(toast.text).toBe("Deleted canyon_run.");
    expect(toast.undoLabel).toBe("Undo");
    toasts.undo(toast.id);
    await new Promise((r) => setTimeout(r, 0));
    expect(project.files).toContain(PATH);
    expect(loadScene(PATH)?.folder).toBe("Canyon level");
  });

  it("refuses a scene that's gone and says why, with no toast", async () => {
    await deleteScenes(["audio/scenes/nope.audioscene.json"]);
    expect(project.files).toContain(PATH);
    expect(status.value?.text).toBe("Can't delete nope: it's gone already.");
    expect(toasts.toasts.peek()).toEqual([]);
  });
});
