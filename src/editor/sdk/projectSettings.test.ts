// `editor.project.settings` (ADR 0173): the Project Settings section's draft, one-step edits and undo history, over the
// shell's one instance (`projectSettingsInstance.ts`), which the Project Settings panel uses too, so the two share one history.
import { computed } from "@preact/signals";
import { afterEach, describe, expect, it } from "vitest";
import type { EditorProject } from "../projects";
import { projectSettings } from "../projectSettingsInstance";
import { setValue } from "../projectSettingsModel";
import { closeTestProject, openTestProject, sampleProject } from "../testing";
import { currentProject } from "../state";
import { editor } from "./index";

const PROJECT = `{
  "name": "Game",
  "display": { "width": 640, "height": 480 }
}
`;

const fileOf = (project: EditorProject) => JSON.parse(project.textOf("project.json")!) as { name?: string; display?: { width?: number } };
const settings = editor.project.settings;

afterEach(closeTestProject);

describe("editor.project.settings", () => {
  it("has the record's members", () => {
    for (const name of ["draft", "edit", "undo", "redo", "canUndo", "canRedo"]) expect(typeof (settings as unknown as Record<string, unknown>)[name]).toBe("function");
    expect(typeof settings.version).toBe("number");
  });

  it("reads the draft as a deep copy, with the Project Settings panel closed", async () => {
    await openTestProject({ "project.json": PROJECT });
    const d = settings.draft();
    expect(d.name).toBe("Game");
    expect(d.display).toEqual({ width: 640, height: 480 });
    d.display!.width = 1;
    expect(settings.draft().display?.width).toBe(640); // a copy: changing it changes nothing
  });

  it("commits an edit as one undo step, saved to project.json; undo and redo step it", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    expect(settings.canUndo()).toBe(false);
    expect(settings.canRedo()).toBe(false);
    await settings.edit("Set display width", setValue(settings.draft(), "display", "width", 800));
    expect(fileOf(project).display?.width).toBe(800);
    expect(settings.canUndo()).toBe(true);
    expect(projectSettings.open(project).undoLabel).toBe("Set display width"); // one step in the panel's history
    settings.undo();
    expect(settings.draft().display?.width).toBe(640);
    expect(settings.canUndo()).toBe(false);
    expect(settings.canRedo()).toBe(true);
    settings.redo();
    expect(settings.draft().display?.width).toBe(800);
    expect(settings.canRedo()).toBe(false);
    // One step: one undo goes back to the start.
    settings.undo();
    expect(settings.canUndo()).toBe(false);
  });

  it("bumps its version on an edit, an undo, a redo and an outside change, tracked", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    const seen = computed(() => settings.version);
    let v = seen.value;
    const bumped = () => {
      const now = seen.value;
      const moved = now > v;
      v = now;
      return moved;
    };
    await settings.edit("Rename project", { ...settings.draft(), name: "Renamed" });
    expect(bumped()).toBe(true);
    settings.undo();
    expect(bumped()).toBe(true);
    settings.redo();
    expect(bumped()).toBe(true);
    await Promise.resolve();
    bumped();
    // Something else rewrites the section's keys (the Code panel) and says the files changed: a new draft.
    await project.writeText("project.json", project.textOf("project.json")!.replace('"Renamed"', '"Theirs"'));
    editor.project.changed();
    expect(bumped()).toBe(true);
    expect(settings.draft().name).toBe("Theirs");
    // A file change that leaves the draft as it was doesn't bump.
    editor.project.changed();
    expect(bumped()).toBe(false);
  });

  it("shares one history with the Project Settings panel: undo goes back through both in order", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    const panel = projectSettings.open(project); // what ProjectSettingsPanel renders and edits
    await panel.edit("Rename project", { ...panel.draft, name: "Panel" });
    await settings.edit("Set display width", setValue(settings.draft(), "display", "width", 800));
    expect(projectSettings.open(project)).toBe(panel);
    expect(panel.undoLabel).toBe("Set display width");
    await panel.undo(); // the panel's Undo undoes the SDK's edit first
    expect(settings.draft()).toMatchObject({ name: "Panel", display: { width: 640 } });
    settings.undo(); // and the SDK's undo undoes the panel's edit
    expect(settings.draft().name).toBe("Game");
    expect(panel.canUndo).toBe(false);
    expect(projectSettings.history.canRedo).toBe(true); // Ctrl+Z's view of the same history
    await Promise.resolve();
    await Promise.resolve();
    expect(fileOf(project)).toMatchObject({ name: "Game", display: { width: 640 } });
  });

  it("does nothing with no project open or in a read-only project", async () => {
    expect(settings.draft()).toEqual({});
    await settings.edit("x", { name: "x" });
    settings.undo();
    expect(settings.canUndo()).toBe(false);
    currentProject.value = sampleProject();
    await settings.edit("Rename project", { ...settings.draft(), name: "x" });
    expect(settings.canUndo()).toBe(false);
    expect(settings.draft().name).toBe("flappy");
  });
});
