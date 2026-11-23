// The 2D tools' registration (ADR 0373; T56): what the seam contributes, and the Assets panel's Create Flipbook from Slices
// action run against a project in memory: it writes the flipbook (frames ordered by name and number) into the image's
// sidecar, refuses with a reason, and is offered only for slices of one image.
import { beforeEach, describe, expect, it } from "vitest";
import type { AssetActionContribution, EditorPluginContext, ImportSettingsSectionContribution, SpriteEditorToolContribution } from "../../../../editor/sdk";
import { joinPath, openFolderProject, useProjectAssets, type EditorProject } from "../../../../editor/projects";
import { status } from "../../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../../editor/testing";
import { parseImportSettings } from "../../../../engine/scene/importSettings";
import { imageOfSlices, registerTwoD } from "./register";

const SIDECAR = {
  format: "myco.import@1",
  sprites: ["walk_10", "walk_2", "walk_1", "other"].map((name, i) => ({ name, rect: [i * 16, 0, 16, 16], pivot: [0.5, 0] })),
};

let fs: MemoryFileSystem;
let project: EditorProject;
const actions: AssetActionContribution[] = [];
const sections: ImportSettingsSectionContribution[] = [];
const tools: SpriteEditorToolContribution[] = [];

beforeEach(async () => {
  fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  fs.files.set(joinPath(ROOT, "hero.png"), new Uint8Array([137, 80, 78, 71]));
  fs.files.set(joinPath(ROOT, "hero.png.meta.json"), JSON.stringify(SIDECAR));
  project = await openFolderProject(fs, ROOT);
  useProjectAssets(project);
  status.value = null;
  actions.length = sections.length = tools.length = 0;
  registerTwoD(
    {
      registerAssetAction: (a: AssetActionContribution) => actions.push(a),
      registerImportSettingsSection: (s: ImportSettingsSectionContribution) => sections.push(s),
      registerSpriteEditorTool: (t: SpriteEditorToolContribution) => tools.push(t),
    } as unknown as EditorPluginContext,
    { physics: false, audio: false },
  );
});

const sidecar = () => parseImportSettings(JSON.parse(fs.files.get(joinPath(ROOT, "hero.png.meta.json")) as string), "hero.png.meta.json").settings;

describe("the seam", () => {
  it("adds the flipbook action, an image Import Settings card and the Flipbooks and Bones tabs", () => {
    expect(actions.map((a) => a.id)).toEqual(["myco.animation.flipbook-from-slices"]);
    expect(sections.map((s) => [s.id, s.kind])).toEqual([["myco.animation.flipbooks", "image"]]);
    expect(tools.map((t) => t.label)).toEqual(["Flipbooks", "Bones"]);
  });
});

describe("Create Flipbook from Slices", () => {
  it("is offered for slices of one image only", () => {
    const [action] = actions;
    expect(action!.writes).toBe(true);
    expect(action!.appliesTo(project, [{ path: "hero.png", slice: "walk_1" }, { path: "hero.png", slice: "walk_2" }])).toBe(true);
    expect(action!.appliesTo(project, [{ path: "hero.png", slice: "walk_1" }, { path: "other.png", slice: "a" }])).toBe(false);
    expect(action!.appliesTo(project, [{ path: "hero.png" }])).toBe(false);
    expect(action!.appliesTo(project, [])).toBe(false);
    expect(imageOfSlices([{ path: "hero.png", slice: "a" }])).toBe("hero.png");
  });

  it("writes the flipbook, frames ordered by name and number, and selects the image", async () => {
    const made = await actions[0]!.run(project, [{ path: "hero.png", slice: "walk_10" }, { path: "hero.png", slice: "walk_1" }, { path: "hero.png", slice: "walk_2" }]);
    expect(made).toEqual(["hero.png"]);
    expect(sidecar().flipbooks).toEqual({ walk: { slices: ["walk_1", "walk_2", "walk_10"], fps: 12, loop: true } });
    expect(sidecar().sprites.map((s) => s.name)).toEqual(["walk_10", "walk_2", "walk_1", "other"]);
    expect(status.value?.text).toMatch(/Created flipbook walk .*hero\.png#Flip\/walk/);
  });

  it("a second flipbook with the same stem gets the next free name", async () => {
    await actions[0]!.run(project, [{ path: "hero.png", slice: "walk_1" }, { path: "hero.png", slice: "walk_2" }]);
    await actions[0]!.run(project, [{ path: "hero.png", slice: "walk_10" }, { path: "hero.png", slice: "walk_2" }]);
    expect(Object.keys(sidecar().flipbooks)).toEqual(["walk", "walk_2"]);
  });

  it("refuses with the reason and writes nothing for a slice the image lacks", async () => {
    const made = await actions[0]!.run(project, [{ path: "hero.png", slice: "gone" }]);
    expect(made).toEqual([]);
    expect(status.value).toMatchObject({ kind: "error", text: expect.stringMatching(/Can't create a flipbook: the image has no slice named "gone"/) });
    expect(sidecar().flipbooks).toEqual({});
  });
});
