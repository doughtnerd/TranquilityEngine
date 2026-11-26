// ADR 0140: Sprites, Meshes and models, Water and UI register their render features from plugins;
// Environment and Post-processing claim Components read by core render services. Draw order is
// unchanged: the built-ins register first, plugins after, and `after` constraints decide inside a phase.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { getComponentClass } from "../engine/core/registry";
import { PROBES_SPEC } from "../engine/render/babylon/features";
import { FOG_SPEC } from "../engine/render/babylon/fog";
import { Environment, MeshRenderer, PostProcessing, SpriteRenderer } from "../engine/render/components";
import { _registeredRenderFeatures, byPhase, type RenderFeatureSpec } from "../engine/render/renderFeatures";
import { WaterSurface } from "../engine/render/water/WaterSurface";
import { UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText } from "../engine/ui/components";
import { environmentRuntimePlugin } from "./environment/runtime";
import { MESHES_SPEC, meshesRuntimePlugin } from "./meshes/runtime";
import { postProcessingRuntimePlugin } from "./post-processing/runtime";
import { isRuntimePluginActive, RUNTIME_PLUGINS, type RuntimePlugin } from "./runtime";
import { applyTestPlugins } from "./testPlugins";
import { spritesRuntimePlugin } from "./sprites/runtime";
import { uiRuntimePlugin } from "./ui/runtime";
import { UIControlMapper } from "./ui/runtime/UIControlMapper";
import { waterRuntimePlugin } from "./water/runtime";

/** A plugin's render feature spec, as its activation registered it. */
const registeredSpec = (name: string) => _registeredRenderFeatures().find((f) => f.spec.name === name)!.spec;
const SPRITES_SPEC = registeredSpec("sprites");
const TILEMAPS_SPEC = registeredSpec("tilemaps");
const UI_SPEC = registeredSpec("ui");
const WATER_SPEC = registeredSpec("water");
const SKY_SPEC = registeredSpec("sky");
const PARTICLES_SPEC = registeredSpec("particles");
import { runtimeActivator } from "./runtimeContext";

/** The renderer's own features, in its registration order (`BabylonRenderer`'s constructor). */
const BUILTIN = [FOG_SPEC, PROBES_SPEC];
const names = (specs: readonly RenderFeatureSpec[]) => byPhase(specs).map((i) => specs[i].name);
/**
 * The order every frame syncs in (ADR 0140, 0135). The lighting rig isn't a feature: it resolves after
 * the `lighting` phase, whose features (fog, sky) only contribute to it, in either order (ADR 0252).
 */
const TODAY = ["sprites", "tilemaps", "meshes", "fog", "sky", "particles", "probes", "water", "ui"];
/**
 * With the Animation plugin's skinned meshes (ADR 0370), right after the meshes, and its skinned sprites (ADR 0371) after
 * them; the Lines plugin's ribbons (ADR 0396) after the meshes in `content` (their shadow casters are collected with
 * them), the Lights 2D plugin's light volumes (ADR 0415) in `content`, and the Decals plugin's (ADR 0395) in `effects`.
 */
const TODAY_ALL = ["sprites", "tilemaps", "meshes", "lines", "lights2dVolumes", "skinning", "skinnedSprites", "fog", "sky", "particles", "decals", "probes", "water", "ui"];

afterEach(() => applyTestPlugins()); // as Vitest's setup file leaves it

describe("render feature order with every first-party plugin (ADR 0140)", () => {
  it("keeps today's sync order: built-ins first, then the plugins' features as RUNTIME_PLUGINS registers them", () => {
    const specs = [...BUILTIN, ..._registeredRenderFeatures().map((f) => f.spec)];
    expect(names(specs)).toEqual(TODAY_ALL);
  });

  it("keeps it whatever order the plugins register in", () => {
    const plugged = [UI_SPEC, MESHES_SPEC, WATER_SPEC, TILEMAPS_SPEC, PARTICLES_SPEC, SKY_SPEC, SPRITES_SPEC];
    expect(names([...BUILTIN, ...plugged])).toEqual(TODAY);
    expect(names([...BUILTIN, ...[...plugged].reverse()])).toEqual(TODAY);
  });

  it("leaves the rest in order when a plugin is off", () => {
    for (const off of ["sprites", "tilemaps", "meshes", "sky", "water", "ui"]) {
      const specs = [...BUILTIN, SPRITES_SPEC, MESHES_SPEC, PARTICLES_SPEC, TILEMAPS_SPEC, WATER_SPEC, UI_SPEC, SKY_SPEC].filter((s) => s.name !== off);
      expect(names(specs)).toEqual(TODAY.filter((n) => n !== off));
    }
  });

  it("the renderer builds only the lighting rig and probes itself", () => {
    const src = readFileSync(new URL("../engine/render/babylon/BabylonRenderer.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^import (?!type )[^;]*from "\.\/(sprites|meshes|waterFeature|uiFeature)"/m);
    expect(src).not.toMatch(/SPRITES_SPEC|MESHES_SPEC|WATER_SPEC|UI_SPEC/);
  });
});

interface Case {
  plugin: RuntimePlugin;
  components: Record<string, unknown>;
  feature: RenderFeatureSpec | null;
  module?: string;
}

const CASES: Case[] = [
  { plugin: spritesRuntimePlugin, components: { "engine.SpriteRenderer": SpriteRenderer }, feature: SPRITES_SPEC, module: "sprites/runtime/spritesFeature" },
  { plugin: meshesRuntimePlugin, components: { "engine.MeshRenderer": MeshRenderer }, feature: MESHES_SPEC, module: "meshes/runtime/meshesFeature" },
  { plugin: waterRuntimePlugin, components: { "engine.WaterSurface": WaterSurface }, feature: WATER_SPEC, module: "water/runtime/waterFeature" },
  {
    plugin: uiRuntimePlugin,
    components: { "engine.UICanvas": UICanvas, "engine.UIPanel": UIPanel, "engine.UIText": UIText, "engine.UIImage": UIImage, "engine.UIButton": UIButton, "engine.UIInputField": UIInputField, "engine.UIControlMapper": UIControlMapper },
    feature: UI_SPEC,
    module: "ui/runtime/uiFeature",
  },
  { plugin: environmentRuntimePlugin, components: { "engine.Environment": Environment }, feature: null },
  { plugin: postProcessingRuntimePlugin, components: { "engine.PostProcessing": PostProcessing }, feature: null },
];

describe.each(CASES)("the $plugin.manifest.name runtime half (ADR 0140)", ({ plugin, components, feature, module }) => {
  const name = plugin.manifest.name;
  const registered = () => _registeredRenderFeatures().filter((f) => f.spec.name === feature?.name);

  it("is in RUNTIME_PLUGINS, active, and claims its Components", () => {
    expect(RUNTIME_PLUGINS).toContain(plugin);
    expect(isRuntimePluginActive(name)).toBe(true);
    for (const [id, cls] of Object.entries(components)) expect(getComponentClass(id)).toBe(cls);
  });

  it(feature ? "registers its render feature, loaded on demand" : "registers no render feature (a core service reads its Component)", async () => {
    if (!feature) {
      // Their Components aren't owned by any plugin feature: the environment sync and the frame plan read them.
      for (const f of _registeredRenderFeatures()) for (const cls of Object.values(components)) expect(f.spec.types).not.toContain(cls);
      return;
    }
    expect(registered()).toHaveLength(1);
    expect(typeof (await registered()[0].load())).toBe("function");
    // The runtime half names the feature module only in a dynamic import, so Babylon stays out of `myco`.
    const src = readFileSync(new URL(`./${name.slice("myco.".length)}/runtime/index.ts`, import.meta.url), "utf8");
    expect(src).not.toMatch(new RegExp(`from "\\./${module!.split("/").pop()}"`));
    expect(src).not.toMatch(/^import [^;]*render\/babylon\//m);
  });

  it("removes its Components and feature when deactivated, and restores them", () => {
    runtimeActivator.deactivate(name); // the runtime activator directly
    expect(isRuntimePluginActive(name)).toBe(false);
    for (const id of Object.keys(components)) expect(getComponentClass(id)).toBeUndefined();
    if (feature) expect(registered()).toHaveLength(0);
    applyTestPlugins(); // the set activates what was deactivated outside it again
    for (const [id, cls] of Object.entries(components)) expect(getComponentClass(id)).toBe(cls);
    if (feature) expect(registered()).toHaveLength(1);
  });

  it("disabled, unregisters its Components and registers nothing", () => {
    applyTestPlugins([name]);
    for (const id of Object.keys(components)) expect(getComponentClass(id)).toBeUndefined();
    if (feature) expect(registered()).toHaveLength(0);
  });
});

describe("server flags (ADR 0140)", () => {
  it("keeps Sprites, Meshes, Water and UI on the dedicated server (scripts, MeshCollider and Buoyancy read their Components); skips Environment and Post-processing", () => {
    for (const p of [spritesRuntimePlugin, meshesRuntimePlugin, waterRuntimePlugin, uiRuntimePlugin]) expect(p.manifest.server).not.toBe(false);
    for (const p of [environmentRuntimePlugin, postProcessingRuntimePlugin]) expect(p.manifest.server).toBe(false);
  });
});
