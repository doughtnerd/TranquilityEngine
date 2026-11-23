// The Import Settings sections contribution point (ADR 0373): a plugin adds a card to another plugin's asset kind's Import
// Settings (the Animation plugin's bone map and clip cards on the Meshes plugin's `model` kind). The shell shows the cards
// `kindImportSections` returns, after the kind's own, in registration order; deactivating the plugin removes them.
import { afterEach, describe, expect, it } from "vitest";
import { kindImportSections } from "../assetKindLookup";
import { importSettingsSections } from "./contributions";
import { activatePlugins, deactivatePlugin, type EditorPlugin } from "./plugins";

const view = async () => () => null;
const owner = (name: string, ...sections: { id: string; kind: string }[]): EditorPlugin => ({
  manifest: { name, version: "1", dependencies: {} },
  activate: (ctx) => sections.forEach((s) => ctx.registerImportSettingsSection({ ...s, title: s.id, view })),
});

afterEach(() => ["t.sections", "t.other"].forEach(deactivatePlugin));

describe("registerImportSettingsSection", () => {
  it("lists a kind's cards in registration order, only that kind's", () => {
    activatePlugins([owner("t.sections", { id: "t.first", kind: "model" }, { id: "t.image", kind: "image" }, { id: "t.second", kind: "model" })]);
    expect(kindImportSections("model").map((s) => s.id)).toEqual(["t.first", "t.second"]);
    expect(kindImportSections("image").map((s) => s.id)).toEqual(["t.image"]);
    expect(kindImportSections("audio")).toEqual([]);
  });

  it("removes the cards when the plugin deactivates", () => {
    activatePlugins([owner("t.sections", { id: "t.first", kind: "model" })]);
    expect(importSettingsSections.get("t.first")).toBeDefined();
    deactivatePlugin("t.sections");
    expect(importSettingsSections.get("t.first")).toBeUndefined();
    expect(kindImportSections("model")).toEqual([]);
  });

  it("refuses two cards with one id", () => {
    expect(() => activatePlugins([owner("t.sections", { id: "t.same", kind: "model" }, { id: "t.same", kind: "model" })])).toThrow();
  });
});
