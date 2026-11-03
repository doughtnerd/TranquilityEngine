import { describe, expect, it } from "vitest";
import { colorHex } from "../engine/scene/material";
import { editMaterial, readMaterial } from "./materialAssets";
import { joinPath, openFolderProject } from "./projects";
import { MemoryFileSystem, ROOT } from "./testing";


describe("editing material assets (ADR 0043)", () => {
  it("applies quick edits one after another, each to the file as the last left it", async () => {
    const fs = new MemoryFileSystem();
    fs.files.set(joinPath(ROOT, "project.json"), "{}");
    fs.files.set(joinPath(ROOT, "m.material.json"), '{ "format": "myco.material@1" }');
    const project = await openFolderProject(fs, ROOT);
    // Started together, as two Inspector edits before the first write lands.
    const results = await Promise.all([
      editMaterial(project, "m.material.json", { metalness: 0.8 }),
      editMaterial(project, "m.material.json", (now) => ({ tiling: [2, now.tiling[1]] })),
      editMaterial(project, "m.material.json", { metalness: 0.8 }), // no change by then
    ]);
    expect(results).toEqual([true, true, false]);
    const { settings } = readMaterial(project, "m.material.json");
    expect([settings.metalness, settings.tiling, colorHex(settings.color)]).toEqual([0.8, [2, 1], "#ffffff"]);
  });
});
