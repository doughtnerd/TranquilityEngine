// ADR 0247: one edit gate says whether a scene, the open scene's UI or the project's files can be edited
// now, with one wording per refusal, reports it to the status bar and opens the undo step; the editor SDK's
// `editor.scene.edit` goes through it.
import { afterEach, describe, expect, it } from "vitest";
import { AddNode, CommandStack, SceneDocument } from "./document";
import { beginEditStep, editableNow, editStep, whyNotEdit } from "./editGate";
import { editor } from "./sdk";
import { currentProject, openScene, playState, status, type OpenScene } from "./state";
import { closeTestProject, openTestProject, sampleProject } from "./testing";

const sceneOf = () => {
  const doc = new SceneDocument({ format: "myco.scene@1", nodes: [] }, "scenes/a.scene.json");
  return { path: doc.path, doc, stack: new CommandStack(doc) } as unknown as OpenScene;
};
const add = (scene: OpenScene, id: string) => scene.stack.execute(new AddNode({ id }));

afterEach(() => {
  playState.value = "edit";
  openScene.value = null;
  closeTestProject();
});

describe("the edit gate (ADR 0247)", () => {
  it("a scene: none open, then play mode, each worded once", () => {
    expect(whyNotEdit({ kind: "scene" })).toBe("open a scene first");
    openScene.value = sceneOf();
    expect(whyNotEdit({ kind: "scene" })).toBeNull();
    expect(whyNotEdit({ kind: "scene", scene: null })).toBe("open a scene first"); // a scene the caller has none of
    playState.value = "starting";
    expect(whyNotEdit({ kind: "scene" })).toBe("stop playing to edit the scene");
    expect(whyNotEdit({ kind: "scene" }, "paste nodes")).toBe("stop playing to paste nodes");
  });

  it("UI: a scene and a project that can save, not while playing; read-only through the one message", async () => {
    openScene.value = sceneOf();
    expect(whyNotEdit({ kind: "ui" })).toBe("open a scene first"); // no project
    currentProject.value = sampleProject();
    expect(whyNotEdit({ kind: "ui" })).toBe("Flappy sample is read-only. Open a project folder (or copy the sample) to edit the UI.");
    await openTestProject();
    expect(whyNotEdit({ kind: "ui" })).toBeNull();
    playState.value = "playing";
    expect(whyNotEdit({ kind: "ui" })).toBe("stop playing to edit the UI");
  });

  it("project files: read-only always; play only for edits that remove or move files", async () => {
    expect(whyNotEdit({ kind: "project-files" })).toBe("open a project first");
    expect(whyNotEdit({ kind: "project-files", project: sampleProject() }, "delete files")).toMatch(/^Flappy sample is read-only\. .* to delete files\.$/);
    const { project } = await openTestProject();
    playState.value = "playing";
    expect(whyNotEdit({ kind: "project-files" }, "duplicate files")).toBeNull();
    expect(whyNotEdit({ kind: "project-files", project, removes: true }, "move files")).toBe("stop playing to move files");
  });

  it("editableNow reports the refusal as a sentence and hands back what can be edited", async () => {
    expect(editableNow({ kind: "scene" }, "cut nodes")).toBeNull();
    expect(status.value).toEqual({ kind: "info", text: "Open a scene first." });
    const scene = sceneOf();
    openScene.value = scene;
    expect(editableNow({ kind: "scene" }, "cut nodes")).toBe(scene);
    playState.value = "playing";
    expect(editableNow({ kind: "scene" }, "cut nodes")).toBeNull();
    expect(status.value?.text).toBe("Stop playing to cut nodes.");
    currentProject.value = sampleProject();
    expect(editableNow({ kind: "project-files" }, "add files")).toBeNull();
    expect(status.value?.text).toBe("Flappy sample is read-only. Open a project folder (or copy the sample) to add files."); // one full stop
    const { project } = await openTestProject();
    expect(editableNow({ kind: "project-files" })).toBe(project);
  });

  it("editStep and beginEditStep open one undo step once the gate passes, and none when it refuses", () => {
    const scene = sceneOf();
    openScene.value = scene;
    expect(editStep({ kind: "scene" }, "Add two", (s) => (add(s, "a"), add(s, "b"), "done"))).toBe("done");
    expect(scene.stack.undoLabel).toBe("Add two");
    scene.stack.undo();
    expect(scene.doc.has("a") || scene.doc.has("b")).toBe(false);
    const step = beginEditStep({ kind: "scene" }, "Drag")!;
    add(scene, "c");
    add(scene, "d");
    step.end();
    expect(scene.stack.undoLabel).toBe("Drag");
    playState.value = "playing";
    let ran = false;
    expect(editStep({ kind: "scene" }, "Nope", () => (ran = true))).toBeUndefined();
    expect(ran).toBe(false);
    expect(beginEditStep({ kind: "scene" }, "Nope")).toBeNull();
  });

  it("the SDK's editor.scene.edit and beginEdit go through it, so plugins can't edit a scene while playing", () => {
    const scene = sceneOf();
    openScene.value = scene;
    expect(editor.scene.whyNotEdit()).toBeNull();
    expect(editor.scene.edit("Add", (s) => add(s, "a"))).toBe(true);
    playState.value = "playing";
    expect(editor.scene.whyNotEdit()).toBe("stop playing to edit the scene");
    expect(editor.scene.edit("Add", (s) => add(s, "b"))).toBe(false);
    expect(editor.scene.beginEdit("Drag")).toBeNull();
    expect(scene.doc.has("b")).toBe(false);
    expect(status.value?.text).toBe("Stop playing to edit the scene.");
  });
});
