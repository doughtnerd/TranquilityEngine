import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorProject } from "./projects";
import { checkSettingsSectionKeys, setValue, settingsKeys, type SettingsDraft } from "./projectSettingsModel";
import { createProjectSettingsSection } from "./projectSettingsSection";
import { projectSettingsSections } from "./sdk/contributions";
import { closeTestProject, openTestProject } from "./testing";
import { addWorld } from "./worldsConfig";
import { createWorldsSection, editedWorlds, type WorldsDraft } from "./worldsSection";

// A project section (ADR 0151): a set of project.json keys edited by one panel, over an in-memory project.

const PROJECT = `{
  "name": "Game",
  "display": { "width": 640, "height": 480 },
  "render": { "sortingLayers": ["Default", "Fx"] }
}
`;

const fileOf = (project: EditorProject) => JSON.parse(project.textOf("project.json")!) as Record<string, unknown>;
const graphModel = (draft: WorldsDraft) => {
  if (draft.view.kind !== "graph") throw new Error("not a graph");
  return draft.view.model;
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  closeTestProject();
});

describe("a project section", () => {
  it("saves an edit, keeping the rest of project.json's text", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    const settings = createProjectSettingsSection();
    const s = settings.open(project);
    expect(s.draft.name).toBe("Game");
    await s.edit("Set display width", setValue(s.draft, "display", "width", 800));
    expect(fileOf(project).display).toEqual({ width: 800, height: 480 });
    expect(project.textOf("project.json")).toContain('"name": "Game"');
    expect(s.unsaved).toBe(false);
    expect(s.saving).toBe(false);
    expect(s.error).toBeNull();
    expect(settings.open(project)).toBe(s);
    // An edit that changes nothing isn't an undo step.
    await s.edit("Nothing", { ...s.draft });
    expect(s.undoLabel).toBe("Set display width");
  });

  it("keeps the draft and its undo when another panel's key changes", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    const settings = createProjectSettingsSection();
    const worlds = createWorldsSection();
    const s = settings.open(project);
    const w = worlds.open(project);
    await s.edit("Rename project", { ...s.draft, name: "Renamed" });
    // An invalid, unsaved draft is kept too.
    await s.edit("Set display width", setValue(s.draft, "display", "width", 0));
    await w.edit("Add World", editedWorlds(addWorld(graphModel(w.draft))));
    expect(fileOf(project).bootstrap).toBeDefined();
    expect(settings.open(project)).toBe(s);
    expect(s.draft.display?.width).toBe(0);
    expect(s.undoLabel).toBe("Set display width");
    expect(s.unsaved).toBe(true);
    // And the other way round: the Worlds panel keeps its undo across the settings panel's save.
    await s.undo();
    expect(fileOf(project).display).toEqual({ width: 640, height: 480 });
    expect(worlds.open(project)).toBe(w);
    expect(w.undoLabel).toBe("Add World");
    expect(fileOf(project).name).toBe("Renamed");
  });

  it("doesn't take its own write for an outside edit, but starts again when its keys change elsewhere", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    const settings = createProjectSettingsSection();
    const s = settings.open(project);
    // A render while the write is finishing: the project already holds the new text, the section hasn't recorded it yet.
    const write = project.writeText.bind(project);
    let midWrite: unknown;
    project.writeText = async (path, text) => {
      await write(path, text);
      midWrite = settings.open(project);
    };
    await s.edit("Rename project", { ...s.draft, name: "Mine" });
    expect(midWrite).toBe(s);
    expect(settings.open(project)).toBe(s);
    expect(s.undoLabel).toBe("Rename project");
    // The Code panel changes the section's own key: the draft is read again, its undo gone.
    await write("project.json", PROJECT.replace('"Game"', '"Theirs"'));
    const next = settings.open(project);
    expect(next).not.toBe(s);
    expect(next.draft.name).toBe("Theirs");
    expect(next.canUndo).toBe(false);
  });

  it("doesn't write an invalid draft, and writes it once an edit fixes it", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    const settings = createProjectSettingsSection();
    const s = settings.open(project);
    const before = project.textOf("project.json");
    await s.edit("Set display width", setValue(s.draft, "display", "width", -5));
    expect(project.textOf("project.json")).toBe(before);
    expect(s.unsaved).toBe(true);
    await s.edit("Set display width", setValue(s.draft, "display", "width", 320));
    expect(fileOf(project).display).toEqual({ width: 320, height: 480 });
    // The Worlds panel keeps an invalid graph unsaved too.
    const worlds = createWorldsSection();
    const w = worlds.open(project);
    const model = graphModel(w.draft);
    await w.edit("Rename World", editedWorlds({ ...model, worlds: [{ ...model.worlds[0], name: "" }] }));
    expect(fileOf(project).bootstrap).toBeUndefined();
    expect(w.unsaved).toBe(true);
  });

  it("undoes and redoes, writing each step, through its UndoHistory", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    const settings = createProjectSettingsSection();
    const s = settings.open(project);
    await s.edit("Rename project", { ...s.draft, name: "One" });
    await s.edit("Rename project again", { ...s.draft, name: "Two" });
    const history = settings.history;
    expect(history.name).toBe("Project Settings");
    expect(history.canUndo).toBe(true);
    expect(history.undoLabel).toBe("Rename project again");
    history.undo();
    await vi.waitFor(() => expect(fileOf(project).name).toBe("One"));
    expect(history.redoLabel).toBe("Rename project again");
    await s.undo();
    expect(fileOf(project).name).toBe("Game");
    expect(history.canUndo).toBe(false);
    await s.redo();
    await s.redo();
    expect(fileOf(project).name).toBe("Two");
    expect(history.canRedo).toBe(false);
  });

  it("runs its after-save hooks: graphics, plugins turned on or off, and layer renames on undo and redo", async () => {
    const scene = { format: "myco.scene@1", nodes: [{ id: "n", name: "N", components: [{ type: "engine.SpriteRenderer", data: { sortingLayer: "Fx" } }] }] };
    const { project } = await openTestProject({ "project.json": PROJECT, "a.scene.json": JSON.stringify(scene) });
    const graphicsSaved = vi.fn();
    const pluginsChanged = vi.fn();
    const settings = createProjectSettingsSection({ graphicsSaved, pluginsChanged });
    const s = settings.open(project);
    await s.edit("Rename project", { ...s.draft, name: "X" });
    expect(graphicsSaved).toHaveBeenCalledTimes(1);
    expect(pluginsChanged).not.toHaveBeenCalled();
    await s.edit("Turn off Sky", { ...s.draft, plugins: { disabled: ["myco.sky"] } });
    expect(pluginsChanged).toHaveBeenCalledTimes(1);
    // A sorting layer renamed by an edit, undone, then redone: the redo moves the scene's reference.
    await s.edit("Rename sorting layer to Glow", setValue(s.draft, "render", "sortingLayers", ["Default", "Glow"]));
    await s.undo();
    await s.redo();
    await vi.waitFor(() => expect(project.textOf("a.scene.json")).toContain('"Glow"'));
  });
});

describe("a plugin's settings section owning a key", () => {
  const register = (keys: string[]) => {
    const undo = projectSettingsSections.register({
      id: "acme",
      title: "Acme",
      keys,
      view: async () => () => null,
      problems: (draft: SettingsDraft) => {
        const speed = (draft.acme as { speed?: unknown } | undefined)?.speed;
        return speed !== undefined && typeof speed !== "number" ? [{ field: "acme.speed", message: "Speed must be a number." }] : [];
      },
    });
    cleanups.push(undo);
    return undo;
  };

  it("round-trips its new top-level key: read, checked, saved, undone", async () => {
    register(["acme"]);
    expect(settingsKeys()).toContain("acme");
    const { project } = await openTestProject({ "project.json": `{\n  "name": "Game",\n  "acme": { "speed": 1 }\n}\n` });
    const settings = createProjectSettingsSection();
    const s = settings.open(project);
    expect(s.draft.acme).toEqual({ speed: 1 });
    await s.edit("Set speed", { ...s.draft, acme: { speed: "fast" } });
    expect(fileOf(project).acme).toEqual({ speed: 1 }); // its problem keeps it unsaved
    await s.edit("Set speed", { ...s.draft, acme: { speed: 2 } });
    expect(fileOf(project).acme).toEqual({ speed: 2 });
    await s.edit("Remove acme", { ...s.draft, acme: undefined });
    expect(fileOf(project)).not.toHaveProperty("acme");
    await s.undo();
    expect(fileOf(project).acme).toEqual({ speed: 2 });
  });

  it("leaves the key alone while unregistered, and adopts it into the draft and its undo when registered again", async () => {
    const unregister = register(["acme"]);
    const { project } = await openTestProject({ "project.json": `{\n  "name": "Game",\n  "acme": { "speed": 1 }\n}\n` });
    const settings = createProjectSettingsSection();
    const s = settings.open(project);
    await s.edit("Rename project", { ...s.draft, name: "One" });
    unregister(); // the plugin is turned off
    expect(settings.open(project)).toBe(s);
    await s.edit("Rename project again", { ...s.draft, name: "Two" });
    expect(fileOf(project).acme).toEqual({ speed: 1 });
    // Changed elsewhere while it was off: not the section's key then, so the draft stays.
    await project.writeText("project.json", project.textOf("project.json")!.replace('"speed": 1', '"speed": 5'));
    expect(settings.open(project)).toBe(s);
    register(["acme"]); // on again: every state takes the file's value, so undoing doesn't drop it
    expect(settings.open(project)).toBe(s);
    expect(s.draft.acme).toEqual({ speed: 5 });
    await s.undo();
    await s.undo();
    expect(fileOf(project)).toMatchObject({ name: "Game", acme: { speed: 5 } });
  });

  it("can't claim a key the editor or another section owns", () => {
    register(["acme"]);
    const section = (id: string, keys: string[]) => ({ id, keys });
    expect(() => checkSettingsSectionKeys(section("x", ["display"]))).toThrow(/editor owns/);
    expect(() => checkSettingsSectionKeys(section("x", ["bootstrap"]))).toThrow(/editor owns/);
    expect(() => checkSettingsSectionKeys(section("x", ["acme"]))).toThrow(/"acme" owns it/);
    expect(checkSettingsSectionKeys(section("x", ["other"]))).toEqual({ id: "x", keys: ["other"] });
  });
});
