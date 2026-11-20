import { describe, expect, it } from "vitest";
import { joinPath, openFolderProject } from "./projects";
import { ROOT, demoFolder, sampleProject } from "./testing";
import { withMember } from "./jsonMember";
import { modelToConfig, readBootstrap, type WorldsModel } from "./worldsConfig";

describe("a project's settings follow project.json (the Worlds panel's saves reach play mode)", () => {
  it("reflects a bootstrap written after the project opened", async () => {
    const fs = demoFolder();
    const project = await openFolderProject(fs, ROOT);
    expect(project.settings.bootstrap).toBeUndefined();
    expect(project.settings.name).toBe("flappy");

    const config = modelToConfig((readBootstrap(undefined) as { model: WorldsModel }).model);
    await project.writeText("project.json", withMember(project.textOf("project.json")!, "bootstrap", config));
    expect(project.settings.bootstrap).toEqual(config);
    expect(project.settings.physics?.gravity).toEqual([0, -32]); // the other settings are still there
    expect(JSON.parse(fs.files.get(joinPath(ROOT, "project.json")) as string).bootstrap).toEqual(config);

    await project.writeText("project.json", withMember(project.textOf("project.json")!, "bootstrap", undefined));
    expect(project.settings.bootstrap).toBeUndefined();
  });

  it("reads a read-only project's settings from its project.json", () => {
    const project = sampleProject();
    expect(project.settings.name).toBe("flappy");
    expect(project.canSave).toBe(false);
  });
});
