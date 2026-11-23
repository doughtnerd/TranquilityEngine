import { describe, expect, it } from "vitest";
import { openFolderProject, readOnlyProject } from "./projects";
import { studioAssetItems, studioRequest, whyNotOpenInStudio } from "./studioLaunch";
import { demoFolder, ROOT, sampleProject } from "./testing";

describe("Open in Audio Studio", () => {
  it("is offered on one file the Studio opens, and opens it on its screen", async () => {
    const project = await openFolderProject(demoFolder(), ROOT);
    const items = studioAssetItems({ project, entries: ["music/town.mp3"] });
    expect(items.map((i) => [i.label, i.whyNot])).toEqual([["Open in Audio Studio", null]]);
    expect(studioRequest(project, { asset: "music/town.mp3" })).toEqual({ project: ROOT, asset: "music/town.mp3" });
  });

  it("isn't offered on files the Studio doesn't open, on folders or on several files", async () => {
    const project = await openFolderProject(demoFolder(), ROOT);
    expect(studioAssetItems({ project, entries: ["scenes/main.scene.json"] })).toEqual([]);
    expect(studioAssetItems({ project, entries: ["music/"] })).toEqual([]);
    expect(studioAssetItems({ project, entries: ["music/town.mp3", "music/foo.mp3"] })).toEqual([]);
    expect(whyNotOpenInStudio(project, ["music/town.mp3", "music/foo.mp3"])).toBe("open one file at a time");
  });

  it("says why when the project isn't a folder the Studio can open", () => {
    const project = sampleProject();
    const [item] = studioAssetItems({ project, entries: ["music/town.mp3"] });
    expect(item.whyNot).toMatch(/opens project folders/);
    expect(studioRequest(project)).toEqual({ project: null });
    expect(studioRequest(null, { screen: "mixer" })).toEqual({ project: null, screen: "mixer" });
  });

  it("opens the same sample in the Studio when the editor has a sample open", () => {
    const project = readOnlyProject("Sound Lab (sample, read-only)", { values: new Map(), texts: new Map() }, "sound-lab");
    expect(studioRequest(project)).toEqual({ project: null, sample: "sound-lab" });
    expect(studioRequest(project, { screen: "mixer" })).toEqual({ project: null, sample: "sound-lab", screen: "mixer" });
  });
});
