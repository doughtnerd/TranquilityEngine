import { afterEach, describe, expect, it } from "vitest";
import { skyPreset } from "../engine/sky/presets";
import { parseSky } from "../engine/sky/skyFormat";
import { createSky } from "./skyAssets";
import { joinPath, openFolderProject } from "./projects";
import { currentProject } from "./state";
import { MemoryFileSystem, ROOT } from "./testing";

async function open(files: Record<string, string>) {
  const fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  for (const [p, text] of Object.entries(files)) fs.files.set(joinPath(ROOT, p), text);
  const project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
  return project;
}

describe("creating sky assets (ADR 0112)", () => {
  afterEach(() => (currentProject.value = null));

  it("writes a parseable sky in skies/ when the project has that folder, and picks a free name", async () => {
    const project = await open({ "skies/New Sky.sky.json": JSON.stringify(skyPreset("night")) });
    const first = await createSky("");
    expect(first).toBe("skies/New Sky 2.sky.json");
    expect(parseSky(project.assets.get(first!), first!).problems).toEqual([]);
    expect(await createSky("", "sunset")).toBe("skies/New Sky 3.sky.json");
  });

  it("uses the given folder when there is no skies/ folder", async () => {
    await open({});
    expect(await createSky("")).toBe("New Sky.sky.json");
  });
});
