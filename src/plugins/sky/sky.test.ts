// The Sky plugin (ADR 0134): its editor half registers the sky asset kind, format and panel, and
// removes them all when deactivated.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { skyPreset } from "../../engine/sky/presets";
import { formatSky, parseSky, type SkySettings } from "../../engine/sky/skyFormat";
import { assetKind } from "../../editor/assetBrowser";
import { _reset, openAssetDocument } from "../../editor/assetDocuments";
import { acceptsFile } from "../../editor/assetFieldKinds";
import { inspectableAsset } from "../../editor/assetImport";
import { isKnownPanel, isOnDemand, panelBeside, panelTitle } from "../../editor/layout/model";
import { joinPath } from "../../editor/projects";
import { assetFormats, assetKinds, panels } from "../../editor/sdk/contributions";
import { activatePlugins, deactivatePlugin, isPluginActive } from "../../editor/sdk/plugins";
import { closeTestProject, openTestProject, ROOT } from "../../editor/testing";
import { previewKind } from "../../editor/thumbnails/keys";
import { EDITOR_PLUGINS } from "../editor";
import { RUNTIME_PLUGINS } from "../runtime";
import { skyEditorPlugin } from "./editor";
import { createSky } from "./editor/skyAssets";
import { skyRuntimePlugin } from "./runtime";
import { assetKindFor, assetKindInfo } from "../../editor/assetKinds";

const SKY = "skies/a.sky.json";

const open = (files: Record<string, string>) => openTestProject(files);

beforeEach(() => activatePlugins([skyEditorPlugin]));
afterEach(() => {
  _reset();
  deactivatePlugin(skyEditorPlugin.manifest.name);
  closeTestProject();
});

describe("the Sky plugin's editor half (ADR 0134)", () => {
  it("is listed with its runtime half, sharing one manifest", () => {
    expect(EDITOR_PLUGINS).toContain(skyEditorPlugin);
    expect(RUNTIME_PLUGINS).toContain(skyRuntimePlugin);
    expect(skyRuntimePlugin.manifest).toBe(skyEditorPlugin.manifest);
    expect(skyEditorPlugin.manifest).toMatchObject({ name: "myco.sky", server: false });
  });

  it("registers the sky asset kind: matching, label, icon, preview, opening, inspector and Environment fields", () => {
    expect(assetKind(SKY)).toBe("sky");
    expect(assetKind("skies/Day.SKY.json")).toBe("sky");
    expect(assetKindInfo("sky")?.label).toBe("Sky");
    expect(assetKindInfo("sky")?.icon).toMatch(/^M/);
    expect(previewKind(SKY)).toBe("sky");
    expect(assetKindFor(SKY)?.open !== undefined).toBe(true);
    expect(inspectableAsset(SKY)).toBe(SKY);
    expect(acceptsFile("environment", SKY)).toBe(true);
    expect(acceptsFile("material", SKY)).toBe(false);
    expect(assetKinds.get("sky")?.create?.label).toBe("New Sky");
  });

  it("registers the Sky panel, on demand beside the graph editors", () => {
    expect(isKnownPanel("sky")).toBe(true);
    expect(panelTitle("sky")).toBe("Sky");
    expect(panelBeside("sky")).toBe("particlegraph");
    expect(isOnDemand("sky")).toBe(true);
  });

  it("registers a format that round-trips a preset and reports problems as messages", () => {
    const format = assetFormats.get("sky")!;
    const preset = skyPreset("sunset");
    const read = format.parse(JSON.parse(formatSky(preset)), SKY);
    expect(read.problems).toEqual([]);
    expect(read.value).toEqual(parseSky(JSON.parse(formatSky(preset))).settings);
    expect(format.format(read.value)).toBe(formatSky(preset));
    expect(format.writeDelay).toBe(150);
    const bad = format.parse("nope", SKY);
    expect(bad.problems.length).toBeGreaterThan(0);
    expect(Object.keys(bad.problems[0]!)).toEqual(["message"]);
  });

  it("edits a sky through its asset document", async () => {
    const { project, fs } = await open({ [SKY]: formatSky(skyPreset("clearDay")) });
    const doc = openAssetDocument<SkySettings>(project, SKY, "sky");
    doc.edit(skyPreset("night"));
    await doc.flush();
    expect(fs.files.get(joinPath(ROOT, SKY))).toBe(formatSky(skyPreset("night")));
    doc.undo();
    await doc.flush();
    expect(fs.files.get(joinPath(ROOT, SKY))).toBe(formatSky(skyPreset("clearDay")));
  });

  it("removes everything when deactivated", () => {
    deactivatePlugin("myco.sky");
    expect(isPluginActive("myco.sky")).toBe(false);
    expect(assetKind(SKY)).toBe("json");
    expect(assetKindInfo("sky")?.label).toBeUndefined();
    expect(previewKind(SKY)).toBeNull();
    expect(acceptsFile("environment", SKY)).toBe(false);
    expect(inspectableAsset(SKY)).toBeNull();
    expect(assetFormats.get("sky")).toBeUndefined();
    expect(panels.get("sky")).toBeUndefined();
    expect(isKnownPanel("sky")).toBe(false);
  });
});

describe("New Sky (ADR 0112)", () => {
  it("writes a parseable sky in skies/ when the project has that folder, and picks a free name", async () => {
    const { project } = await open({ "skies/New Sky.sky.json": JSON.stringify(skyPreset("night")) });
    const first = await createSky("");
    expect(first).toBe("skies/New Sky 2.sky.json");
    expect(parseSky(project.assets.get(first!), first!).problems).toEqual([]);
    expect(await createSky("", "sunset")).toBe("skies/New Sky 3.sky.json");
  });

  it("uses the given folder when there is no skies/ folder", async () => {
    await open({});
    expect(await createSky("")).toBe("New Sky.sky.json");
  });

  it("is the kind's New… entry", async () => {
    await open({});
    expect(await assetKinds.get("sky")!.create!.create("")).toBe("New Sky.sky.json");
  });
});
