// An image's slices and flipbooks as sub-assets of the image kind (ADR 0371, 0373 "2D tools"; T56): pickers list them under the
// file for the field kinds they satisfy, and a stored reference to either resolves (slices through the sidecar, flipbooks to
// the engine's clip).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets } from "../engine/scene/Assets";
import { imageSubAsset } from "../engine/animation/sprites/flipbook";
import { assetChoices, assetsForKinds } from "./assetFieldKinds";
import { satisfiesFieldKind } from "./assetKindLookup";
import { imageSubAssetNames } from "./imageSubAssets";
import { joinPath, openFolderProject, useProjectAssets } from "./projects";
import { currentProject } from "./state";
import { MemoryFileSystem, ROOT, useCoreAssetKinds } from "./testing";

useCoreAssetKinds();

const SIDECAR = {
  format: "myco.import@1",
  sprites: [
    { name: "run_0", rect: [0, 0, 16, 16], pivot: [0.5, 0] },
    { name: "run_1", rect: [16, 0, 16, 16], pivot: [0.5, 0] },
  ],
  flipbooks: { run: { slices: ["run_0", "run_1"], fps: 8 } },
};

beforeEach(async () => {
  const fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  fs.files.set(joinPath(ROOT, "images/hero.png"), new Uint8Array([137, 80, 78, 71]));
  fs.files.set(joinPath(ROOT, "images/hero.png.meta.json"), JSON.stringify(SIDECAR));
  fs.files.set(joinPath(ROOT, "images/plain.png"), new Uint8Array([137, 80, 78, 71]));
  const project = await openFolderProject(fs, ROOT);
  useProjectAssets(project);
  currentProject.value = project;
  Assets.addSource(Assets.fromObject({ "images/hero.png": "data:,", "images/hero.png.meta.json": SIDECAR }));
});
afterEach(() => {
  currentProject.value = null;
  Assets.clearSources();
});

describe("image sub-assets", () => {
  it("name the slices for sprite fields and the flipbooks for animclip fields", () => {
    const settings = { sprites: SIDECAR.sprites, flipbooks: { run: { slices: ["run_0"], fps: 8, loop: true } } };
    expect(imageSubAssetNames(settings, ["sprite"])).toEqual(["run_0", "run_1"]);
    expect(imageSubAssetNames(settings, ["animclip"])).toEqual(["Flip/run"]);
    expect(imageSubAssetNames(settings, ["sprite", "animclip"])).toEqual(["run_0", "run_1", "Flip/run"]);
    expect(imageSubAssetNames(settings, ["texture"])).toEqual([]);
  });

  it("are offered by asset fields under the image and satisfy the right kinds", () => {
    const files = ["images/hero.png", "images/plain.png"];
    expect(assetsForKinds(["sprite"], files)).toEqual(["images/hero.png", "images/hero.png#run_0", "images/hero.png#run_1", "images/plain.png"]);
    expect(assetsForKinds(["animclip"], files)).toEqual(["images/hero.png#Flip/run"]);
    expect(satisfiesFieldKind("animclip", "images/hero.png#Flip/run")).toBe(true);
    expect(satisfiesFieldKind("sprite", "images/hero.png#Flip/run")).toBe(false);
    expect(satisfiesFieldKind("sprite", "images/hero.png#run_1")).toBe(true);
    expect(satisfiesFieldKind("animclip", "images/hero.png#run_1")).toBe(false);
    expect(satisfiesFieldKind("texture", "images/hero.png")).toBe(true);
  });

  it("a picker holding a flipbook reference shows it as picked", () => {
    const choices = assetChoices(["animclip"], ["images/hero.png"], "asset:images/hero.png#Flip/run");
    expect(choices.entries.map((e) => e.value)).toEqual(["asset:images/hero.png#Flip/run"]);
    expect(choices.selected).toBe("asset:images/hero.png#Flip/run");
    expect(choices.other).toBeNull();
  });

  it("resolve: a flipbook reference is the engine's clip over the slices", () => {
    expect(imageSubAsset("asset:images/hero.png#Flip/run")).toMatchObject({ kind: "clip", clip: { name: "run", rate: 8, duration: 0.25, loop: true } });
    expect(imageSubAsset("asset:images/hero.png#Flip/gone")).toBeNull();
    expect(Assets.importSettings("images/hero.png").sprites.map((s) => s.name)).toEqual(["run_0", "run_1"]);
  });
});
