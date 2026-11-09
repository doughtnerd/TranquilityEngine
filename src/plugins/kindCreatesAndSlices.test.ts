// ADR 0149: the Assets panel's New… menu lists only registered kinds' `create` (core kinds declare theirs; New UI
// Document is the UI plugin's and goes with it), and slicing is a kind's capability, not the id "image".
import { afterEach, describe, expect, it } from "vitest";
import { searchEntries } from "../editor/assetBrowser";
import { assetKind, canAddToScene, hasSlices, kindCreators, kindOpens, sceneNodesAt } from "../editor/assetKindLookup";
import { assetKinds, type AssetKindContribution } from "../editor/sdk/contributions";
import { useCoreAssetKinds } from "../editor/testing";
import { materialsEditorPlugin } from "./materials/editor";
import { useEditorPlugins } from "./testEditorPlugins";
import { uiEditorPlugin } from "./ui/editor";

useCoreAssetKinds();

describe("the New… menu's file entries (ADR 0149)", () => {
  const halves = useEditorPlugins([uiEditorPlugin, materialsEditorPlugin], "each");

  it("are exactly the core kinds' creates when no plugin is active", () => {
    halves.off();
    expect(kindCreators().map((c) => [c.kind, c.label])).toEqual([
      ["scene", "New Scene"],
      ["rendertexture", "New Render Texture"],
    ]);
  });

  it("include an active plugin's creates after the core ones, and drop them when it is disabled", () => {
    const labels = kindCreators().map((c) => c.label);
    expect(labels.slice(0, 2)).toEqual(["New Scene", "New Render Texture"]);
    expect(labels).toContain("New UI Document");
    expect(labels).toContain("New Material");
    halves.off();
    expect(kindCreators().map((c) => c.label)).not.toContain("New UI Document");
    expect(kindCreators().map((c) => c.label)).not.toContain("New Material");
  });
});

describe("slicing is a kind capability (ADR 0149)", () => {
  const undo: (() => void)[] = [];
  afterEach(() => undo.splice(0).forEach((u) => u()));

  it("the core image kind has slices; other kinds don't", () => {
    expect(hasSlices("image")).toBe(true);
    expect(hasSlices("audio")).toBe(false);
    expect(hasSlices("folder")).toBe(false);
    expect(assetKind("images/a.png#walk_0")).toBe("sprite");
    expect(assetKind("music/a.mp3#x")).toBe("other");
  });

  it("any kind with slices gets sprites that add and open as its files do", () => {
    const opened: string[] = [];
    const atlas: AssetKindContribution = {
      id: "atlas",
      extensions: [".atlas"],
      label: "Atlas",
      icon: "M0 0",
      slices: true,
      open: (path) => opened.push(path),
      addToScene: { nodes: (doc, path) => [{ id: "a", name: path }] },
    };
    undo.push(assetKinds.register(atlas));
    expect(hasSlices("atlas")).toBe(true);
    expect(assetKind("art/ui.atlas#button")).toBe("sprite");
    expect(canAddToScene("art/ui.atlas#button")).toBe(true);
    expect(sceneNodesAt("art/ui.atlas#button")).toBe(atlas.addToScene);
    expect(sceneNodesAt("images/a.png#walk_0")).toBe(assetKinds.get("image")!.addToScene); // each slice asks its own file's kind
    expect(kindOpens("art/ui.atlas#button")).toBe(true);
    const names = (file: string) => (file === "art/ui.atlas" ? ["button"] : []);
    expect(searchEntries(["art/ui.atlas", "music/button.mp3"], "button", names)).toEqual(["art/ui.atlas#button", "music/button.mp3"]);
  });
});
