// G-2 (ADR 0166 P8): saving a project file tells `Assets.onChanged` listeners (audio's hot reload) after the new content is served.
import { describe, expect, it } from "vitest";
import { Assets } from "../engine/scene/Assets";
import { openFolderProject, useProjectAssets } from "./projects";
import { demoFolder, ROOT } from "./testing";

describe("EditorProject writes notify Assets.onChanged", () => {
  it("a JSON write and a binary write report their path once the new content is served", async () => {
    const project = await openFolderProject(demoFolder(), ROOT);
    useProjectAssets(project);
    const seen: [string, unknown][] = [];
    const off = Assets.onChanged((path) => seen.push([path, Assets.get(path)]));
    try {
      await project.writeFile("events/a.audioevent.json", '{"v":1}');
      await project.writeBinary!("music/foo.mp3", new Uint8Array([9, 9]));
    } finally {
      off();
    }
    expect(seen.map((s) => s[0])).toEqual(["events/a.audioevent.json", "music/foo.mp3"]);
    expect(seen[0]![1]).toEqual({ v: 1 });
    expect(String(seen[1]![1])).toMatch(/^blob:|^data:/);
  });
});
