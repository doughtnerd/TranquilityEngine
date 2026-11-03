import { describe, expect, it } from "vitest";
import { queueProjectFileWrite } from "./projectFile";
import {
  addAutoload,
  addLayer,
  addSortingLayer,
  addTier,
  collides,
  graphicsOf,
  moveTier,
  removeTier,
  renameTier,
  setDefaultTier,
  setTierValue,
  moveAutoload,
  moveSortingLayer,
  readDraft,
  removeLayer,
  renameLayer,
  setCollides,
  setGravity,
  setName,
  settingsProblems,
  settingsWarnings,
  setValue,
  withSettings,
  type SettingsDraft,
} from "./projectSettingsModel";
import { raw } from "./testing";

const FLAPPY = raw["../../samples/flappy/project.json"];
const flappy = () => readDraft(JSON.parse(FLAPPY));
const messages = (d: SettingsDraft, files?: string[]) => settingsProblems(d, files).map((p) => p.message);
const fields = (d: SettingsDraft, files?: string[]) => settingsProblems(d, files).map((p) => p.field);

describe("the Project panel's settings", () => {
  it("reads the panel's sections, not the bootstrap", () => {
    const d = readDraft({ name: "x", bootstrap: { worlds: [] }, autoload: [] } as never);
    expect(d).toEqual({ name: "x", autoload: [] });
  });

  it("finds nothing wrong with the sample's settings", () => {
    const files = ["prefabs/music.prefab.json"];
    expect(settingsProblems(flappy(), files)).toEqual([]);
    expect(settingsWarnings(flappy())).toEqual([]);
  });

  it("reports bad display, time and render values by field", () => {
    let d = flappy();
    d = setValue(d, "display", "width", 0);
    d = setValue(d, "display", "height", 10.5);
    d = setValue(d, "display", "backgroundColor", "blue");
    d = setValue(d, "time", "fixedDeltaTime", -1);
    d = setValue(d, "time", "maxSubSteps", 0);
    d = setValue(d, "render", "pixelsPerUnit", 0);
    expect(fields(d)).toEqual(["display.width", "display.height", "display.backgroundColor", "time.fixedDeltaTime", "time.maxSubSteps", "render.pixelsPerUnit"]);
    expect(messages(setValue(flappy(), "time", "fixedDeltaTime", 0.5))).toEqual([expect.stringContaining("longer than the max frame time")]);
    expect(messages(setName(flappy(), "  "))).toEqual([]); // empty name: falls back to the folder name
  });

  it("reports duplicate and empty layer names, too many layers, and unknown autoloads", () => {
    let d = flappy();
    d = renameLayer(d, 2, "Player");
    expect(messages(d)).toContain('Physics layers: "Player" is listed twice.');
    d = setValue(flappy(), "render", "sortingLayers", ["Default", ""]);
    expect(fields(d)).toEqual(["render.sortingLayers.1"]);
    d = flappy();
    for (let i = 0; i < 11; i++) d = addLayer(d);
    expect(messages(d)).toContain("There can be at most 16 physics layers.");
    d = addAutoload(flappy(), "prefabs/gone.prefab.json");
    expect(fields(d, ["prefabs/music.prefab.json"])).toEqual(["autoload.1"]);
    expect(messages(addAutoload(flappy(), "prefabs/music.prefab.json"), ["prefabs/music.prefab.json"])).toEqual(["prefabs/music.prefab.json is autoloaded twice."]);
    expect(settingsWarnings(setValue(flappy(), "render", "sortingLayers", ["Back"]))).toHaveLength(1);
    expect(messages(readDraft({ physics: { layers: ["Default"], collisionMatrix: { Default: ["Ghost"] } } }))).toEqual([expect.stringContaining('"Ghost"')]);
  });

  it("edits the collision matrix as symmetric pairs, written under the earlier layer", () => {
    let d = flappy();
    expect(collides(d, "Player", "Ground")).toBe(true);
    expect(collides(d, "Ground", "Player")).toBe(true);
    expect(collides(d, "Player", "Player")).toBe(false);
    expect(collides(d, "Default", "Default")).toBe(false);
    d = setCollides(d, "Ground", "Player", false);
    d = setCollides(d, "Obstacle", "Obstacle", true);
    expect(d.physics!.collisionMatrix).toEqual({ Player: ["Obstacle", "Score", "Bounds"], Obstacle: ["Obstacle"] });
  });

  it("with no matrix every layer collides; unchecking one pair writes the rest out, checking it back removes the matrix", () => {
    let d: SettingsDraft = { physics: { layers: ["Default", "A"] } };
    expect(collides(d, "A", "Default")).toBe(true);
    d = setCollides(d, "A", "A", false);
    expect(d.physics!.collisionMatrix).toEqual({ Default: ["Default", "A"] });
    d = setCollides(d, "A", "A", true);
    expect(d.physics).toEqual({ layers: ["Default", "A"] });
  });

  it("keeps the matrix in step when layers are added, renamed and removed", () => {
    let d = flappy();
    d = addLayer(d);
    expect(d.physics!.layers!.at(-1)).toBe("Layer");
    expect(collides(d, "Layer", "Player")).toBe(false); // with a matrix, a new layer collides with nothing
    d = renameLayer(d, 1, "Hero");
    expect(d.physics!.collisionMatrix).toEqual({ Hero: ["Obstacle", "Score", "Ground", "Bounds"] });
    d = removeLayer(d, 4); // Ground
    expect(d.physics!.collisionMatrix).toEqual({ Hero: ["Obstacle", "Score", "Bounds"] });
    expect(removeLayer({ physics: { layers: ["Default"] } }, 0)).toEqual({ physics: { layers: ["Default"] } });
    const open = addLayer({});
    expect(open.physics).toEqual({ layers: ["Default", "Layer"] }); // no matrix: the new layer collides with everything
  });

  it("reorders sorting layers and autoloads, and edits gravity", () => {
    let d = moveSortingLayer(flappy(), 0, 1);
    expect(d.render!.sortingLayers).toEqual(["Pipes", "Background", "Default", "Foreground", "Player"]);
    expect(moveSortingLayer(d, 0, -1).render!.sortingLayers).toEqual(d.render!.sortingLayers);
    d = addSortingLayer(d);
    expect(d.render!.sortingLayers!.at(-1)).toBe("Layer");
    d = moveAutoload(addAutoload(flappy(), "a.prefab.json"), 1, -1);
    expect(d.autoload).toEqual(["a.prefab.json", "prefabs/music.prefab.json"]);
    expect(setGravity({}, 1, -20).physics!.gravity).toEqual([0, -20]);
    expect(setValue({ display: { width: 3 } }, "display", "width", undefined).display).toBeUndefined();
  });

  it("writes only the changed sections into project.json, keeping the rest of the text", () => {
    const text = FLAPPY.replace('"autoload"', '"bootstrap": { "worlds": [{ "name": "Default" }] },\n  "autoload"');
    const previous = JSON.parse(text);
    const d = setValue(readDraft(previous), "display", "width", 800);
    const out = withSettings(text, d, previous);
    expect(JSON.parse(out).display.width).toBe(800);
    expect(JSON.parse(out).bootstrap).toEqual({ worlds: [{ name: "Default" }] });
    // Untouched sections keep their exact text.
    const physicsText = text.slice(text.indexOf('"physics"'), text.indexOf('"render"'));
    expect(out).toContain(physicsText);
    expect(out).toContain('"bootstrap": { "worlds": [{ "name": "Default" }] }');
    // Removing a section removes its key.
    const noName = withSettings(text, setName(readDraft(previous), ""), previous);
    expect(JSON.parse(noName).name).toBeUndefined();
    // CRLF files stay CRLF.
    const crlf = text.replace(/\n/g, "\r\n");
    expect(withSettings(crlf, d, previous)).not.toMatch(/[^\r]\n/);
  });

  it("keeps keys it doesn't edit: unknown top-level sections, unknown keys inside its sections, their text and order", () => {
    const text = [
      "{",
      '  "custom": { "anything": [1, 2,   3] },',
      '  "name": "Game",',
      '  "display": { "width": 640, "scaling": "pixel-perfect" },',
      '  "build": { "identifier": "com.example.game", "extra": true },',
      '  "zzz": "last"',
      "}",
      "",
    ].join("\n");
    const previous = JSON.parse(text);
    let d = setValue(readDraft(previous), "display", "height", 480);
    d = setValue(d, "build", "version", "1.2.3");
    const out = withSettings(text, d, previous);
    const json = JSON.parse(out);
    expect(Object.keys(json)).toEqual(["custom", "name", "display", "build", "zzz"]);
    expect(out).toContain('"custom": { "anything": [1, 2,   3] },');
    expect(out).toContain('"name": "Game",');
    expect(out).toContain('"zzz": "last"');
    expect(json.display).toEqual({ width: 640, scaling: "pixel-perfect", height: 480 });
    expect(json.build).toEqual({ identifier: "com.example.game", extra: true, version: "1.2.3" });
  });

  it("checks the build settings the exporter reads", () => {
    const files = ["icon.png", "prefabs/music.prefab.json"];
    expect(settingsProblems({ build: { identifier: "com.example.game", version: "1.0.0", icon: "icon.png" } }, files)).toEqual([]);
    expect(fields({ build: { identifier: "game", version: "1.0", icon: "icon.jpg" } }, files)).toEqual(["build.identifier", "build.version", "build.icon"]);
    expect(messages({ build: { icon: "gone.png" } }, files)).toEqual(["gone.png isn't in the project."]);
    expect(setValue({ build: { version: "1.0.0" } }, "build", "version", undefined).build).toBeUndefined();
  });

  it("runs project.json writes one at a time, even when one fails", async () => {
    const order: string[] = [];
    const slow = queueProjectFileWrite(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("first");
      throw new Error("disk full");
    });
    const next = queueProjectFileWrite(async () => void order.push("second"));
    await expect(slow).rejects.toThrow("disk full");
    await next;
    expect(order).toEqual(["first", "second"]);
  });

  describe("graphics tiers", () => {
    const names = (d: SettingsDraft) => graphicsOf(d).tiers.map((x) => x.name);

    it("starts from the default tiers and leaves the section absent until edited", () => {
      const d = readDraft({});
      expect(d.graphics).toBeUndefined();
      expect(names(d)).toEqual(["Low", "Medium", "High", "Ultra"]);
      expect(withSettings("{}\n", d, {})).toBe("{}\n");
      expect(readDraft({ graphics: { defaultTier: "A", tiers: [{ name: "A" }] } }).graphics).toEqual({ defaultTier: "A", tiers: [{ name: "A" }] });
    });

    it("adds uniquely named tiers with the High tier's values", () => {
      let d = addTier(readDraft({}));
      d = addTier(d);
      expect(names(d)).toEqual(["Low", "Medium", "High", "Ultra", "Tier", "Tier 2"]);
      expect(graphicsOf(d).tiers[4]).toEqual({ ...graphicsOf(d).tiers[2], name: "Tier" });
      expect(graphicsOf(d).defaultTier).toBe("High");
    });

    it("removes tiers, never the last, and moves the default to the highest remaining", () => {
      let d = removeTier(readDraft({}), 2); // High, the default
      expect(names(d)).toEqual(["Low", "Medium", "Ultra"]);
      expect(graphicsOf(d).defaultTier).toBe("Ultra");
      d = removeTier(d, 0);
      expect(graphicsOf(d).defaultTier).toBe("Ultra");
      d = removeTier(removeTier(d, 1), 0);
      expect(names(d)).toEqual(["Medium"]);
      expect(removeTier(d, 0)).toBe(d);
    });

    it("renames tiers, keeping the default, and refuses empty or duplicate names", () => {
      const d = renameTier(readDraft({}), 2, "Best");
      expect(names(d)).toEqual(["Low", "Medium", "Best", "Ultra"]);
      expect(graphicsOf(d).defaultTier).toBe("Best");
      expect(renameTier(d, 0, "Medium")).toBe(d);
      expect(renameTier(d, 0, "  ")).toBe(d);
      expect(graphicsOf(renameTier(d, 0, "Potato")).defaultTier).toBe("Best");
    });

    it("sets the post-processing values of a tier", () => {
      let d = setTierValue(readDraft({}), 0, "postProcessing", true);
      d = setTierValue(d, 0, "bloom", true);
      d = setTierValue(d, 0, "ambientOcclusion", "high");
      d = setTierValue(d, 0, "depthOfField", true);
      d = setTierValue(d, 0, "antialias", "fxaa");
      expect(graphicsOf(d).tiers[0]).toMatchObject({ postProcessing: true, bloom: true, ambientOcclusion: "high", depthOfField: true, antialias: "fxaa" });
    });

    it("reorders tiers within bounds", () => {
      const d = moveTier(readDraft({}), 0, 1);
      expect(names(d)).toEqual(["Medium", "Low", "High", "Ultra"]);
      expect(moveTier(d, 0, -1)).toBe(d);
      expect(moveTier(d, 3, 1)).toBe(d);
    });

    it("sets tier values and the default tier", () => {
      let d = setTierValue(readDraft({}), 0, "renderScale", 0.5);
      d = setTierValue(d, 0, "shadows", "off");
      d = setTierValue(d, 0, "antialias", "msaa");
      d = setTierValue(d, 0, "anisotropy", 2);
      d = setTierValue(d, 0, "shaderLevel", "medium");
      expect(graphicsOf(d).tiers[0]).toEqual({ name: "Low", renderScale: 0.5, antialias: "msaa", shadows: "off", anisotropy: 2, shaderLevel: "medium", postProcessing: false, bloom: false, ambientOcclusion: "off", depthOfField: false });
      expect(settingsProblems(d)).toEqual([]);
      expect(graphicsOf(setDefaultTier(d, "Low")).defaultTier).toBe("Low");
      expect(setDefaultTier(d, "Nope")).toBe(d);
    });

    it("reports bad values as problems for the graphics section", () => {
      const d = setTierValue(readDraft({}), 1, "renderScale", 5);
      expect(fields(d)).toEqual(["graphics"]);
      expect(messages(d)[0]).toContain("renderScale");
      expect(messages(readDraft({ graphics: { tiers: [] } }))).toEqual([expect.stringContaining("no usable tier")]);
    });
  });
});
