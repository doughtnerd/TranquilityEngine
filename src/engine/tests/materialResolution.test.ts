// ADR 0127: renderer-neutral material resolution, tested in-process with no render backend: what a
// material path resolves to and when that goes stale, material slots (ADR 0089), script Material values
// and versions (ADR 0107), override names (ADR 0049), keyword variants (ADR 0106), fog (ADR 0071),
// instancing (ADR 0108) and how import settings sample an image (ADR 0040).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Color, Vector3 } from "../core/math";
import { Assets } from "../scene/Assets";
import { Material } from "../render/Material";
import {
  BUILTIN_PROPERTIES,
  instancingFor,
  isStampCurrent,
  knownProperties,
  overrideWarnings,
  pickSlot,
  resolveMaterial,
  samplingOf,
  scriptValues,
  sharedAction,
  slotSources,
  textureLoad,
  textureValue,
  toGraphValue,
  warmVariantKeywords,
  type AssetRead,
} from "../render/materialResolution";
import { defaultImportSettings } from "../scene/importSettings";

const pulse = JSON.parse(readFileSync(new URL("../../../samples/playground3d/shaders/pulse.shadergraph.json", import.meta.url), "utf8"));
const GLSL = `void surface(MycoSurfaceInput s, inout MycoSurface o) {
  o.baseColor = Tint.rgb;
#ifdef KW_RIM
  o.emission = vec3(1.0);
#endif
}`;

/** An in-memory project read the way `readAsset` reads (JSON objects by identity, text by value). */
function files(over: Record<string, unknown> = {}): { read: AssetRead; set(path: string, v: unknown): void } {
  const map = new Map<string, unknown>(
    Object.entries({
      "asset:red.material.json": { format: "myco.material@1", color: "#ff0000", instancing: "thin" },
      "asset:glow.material.json": { format: "myco.material@1", shader: "unlit", fog: false },
      "asset:graphed.material.json": { format: "myco.material@1", shader: "asset:pulse.shadergraph.json", keywords: { NOPE: true } },
      "asset:rim.material.json": { format: "myco.material@1", shader: "asset:rim.shader.json", properties: { Tint: "#00ff00" }, keywords: { RIM: true } },
      "asset:pulse.shadergraph.json": pulse,
      "asset:rim.shader.json": { format: "myco.shader@1", properties: [{ name: "Tint", type: "color", value: "#ff8800" }], keywords: [{ name: "RIM", variants: "all" }], wgsl: "asset:rim.wgsl", glsl: { code: GLSL } },
      "asset:rim.wgsl": "fn surface() {}",
      "asset:broken.material.json": { format: "not a material" },
      ...over,
    }),
  );
  // Like `Assets`, either spelling of a path reads the same file.
  const key = (p: string) => (p.startsWith("asset:") ? p : `asset:${p}`);
  return { read: (p) => map.get(key(p)), set: (p, v) => map.set(key(p), v) };
}

const opts = (read: AssetRead) => ({ shaderLevel: "high" as const, target: "glsl" as const, read });

describe("material resolution (ADR 0127)", () => {
  describe("what a path resolves to", () => {
    it("resolves a built-in material asset with its settings, fog and instancing", () => {
      const r = resolveMaterial("asset:red.material.json", opts(files().read));
      expect(r.kind).toBe("builtin");
      expect(r.settings?.color).toBeDefined();
      expect(r.fog).toBe(true);
      expect(r.instancing).toBe("thin");
      expect(r.compiled).toBeNull();
      expect(r.warnings).toEqual([]);
    });

    it("reads a material's fog opt-out (ADR 0071)", () => {
      expect(resolveMaterial("asset:glow.material.json", opts(files().read)).fog).toBe(false);
    });

    it("compiles a material's shader graph, warning about unknown keywords and the WebGL2 fallback", () => {
      const r = resolveMaterial("asset:graphed.material.json", opts(files().read));
      expect(r.kind).toBe("graph");
      expect(r.graph).toBe("asset:pulse.shadergraph.json");
      expect(r.compiled).not.toBeNull();
      expect(r.warnings.some((w) => w.key === "graph|webgl")).toBe(true);
      expect(r.warnings.some((w) => w.message.includes("NOPE"))).toBe(true);
      expect(resolveMaterial("asset:graphed.material.json", { ...opts(files().read), target: "wgsl" }).warnings.some((w) => w.key === "graph|webgl")).toBe(false);
    });

    it("resolves a graph named directly, with no material settings", () => {
      const r = resolveMaterial("asset:pulse.shadergraph.json", opts(files().read));
      expect(r.kind).toBe("graph");
      expect(r.settings).toBeNull();
      expect(r.properties).toEqual({});
    });

    it("compiles a shader asset, its code files becoming dependencies, with the asset's properties and keywords", () => {
      const r = resolveMaterial("asset:rim.material.json", opts(files().read));
      expect(r.kind).toBe("graph");
      expect(r.properties).toEqual({ Tint: "#00ff00" });
      expect(r.keywords).toEqual({ RIM: true });
      expect(r.stamp.deps.map(([p, v]) => [p, v])).toEqual([["rim.wgsl", "fn surface() {}"]]);
    });

    it("warns and draws the default for a missing or malformed material", () => {
      const missing = resolveMaterial("asset:nope.material.json", opts(files().read));
      expect(missing.kind).toBe("none");
      expect(missing.warnings[0].message).toMatch(/isn't in the project/);
      const broken = resolveMaterial("asset:broken.material.json", opts(files().read));
      expect(broken.kind).toBe("none");
      expect(broken.warnings).toHaveLength(1);
      const noGraph = resolveMaterial("asset:x.material.json", opts(files({ "asset:x.material.json": { format: "myco.material@1", shader: "asset:gone.shadergraph.json" } }).read));
      expect(noGraph.kind).toBe("none");
      expect(noGraph.warnings[0].message).toMatch(/gone\.shadergraph\.json/);
    });
  });

  describe("staleness", () => {
    it("is current until the material's JSON, the graph's JSON or a code file changes", () => {
      const f = files();
      const r = resolveMaterial("asset:rim.material.json", opts(f.read));
      expect(isStampCurrent(r.stamp, r.path, "high", f.read)).toBe(true);
      f.set("asset:rim.wgsl", "fn surface() { /* edited */ }");
      expect(isStampCurrent(r.stamp, r.path, "high", f.read)).toBe(false);
      const g = files();
      const s = resolveMaterial("asset:graphed.material.json", opts(g.read));
      g.set("asset:pulse.shadergraph.json", { ...pulse });
      expect(isStampCurrent(s.stamp, s.path, "high", g.read)).toBe(false);
      const h = files();
      const t = resolveMaterial("asset:red.material.json", opts(h.read));
      h.set("asset:red.material.json", { format: "myco.material@1", color: "#00ff00" });
      expect(isStampCurrent(t.stamp, t.path, "high", h.read)).toBe(false);
    });

    it("ignores the shader level unless the graph branches on it (ADR 0050)", () => {
      const f = files();
      const r = resolveMaterial("asset:red.material.json", opts(f.read));
      expect(isStampCurrent(r.stamp, r.path, "low", f.read)).toBe(true);
      expect(isStampCurrent({ ...r.stamp, level: "high" }, r.path, "low", f.read)).toBe(false);
    });
  });

  describe("material slots (ADR 0089)", () => {
    beforeEach(() => {
      Assets.clearSources();
      Assets.addSource(Assets.fromObject({ "models/ship.glb.meta.json": { format: "myco.import@1", materials: { Sail: "asset:canvas.material.json" } } }));
    });
    afterEach(() => Assets.clearSources());

    it("tries materials[i], then the renderer's material, then the model's import settings", () => {
      const [hull, sail] = slotSources({ mesh: "asset:models/ship.glb", material: "asset:wood.material.json", materials: ["asset:tar.material.json"] }, ["Hull", "Sail"]);
      expect(hull).toEqual([{ from: "slot", slot: 0, path: "asset:tar.material.json" }, { from: "renderer" }]);
      expect(sail).toEqual([{ from: "renderer" }, { from: "model", path: "asset:canvas.material.json" }]);
      expect(slotSources({ mesh: "builtin:cube", material: "" }, ["Default"])).toEqual([[{ from: "renderer" }]]);
    });

    it("picks the first source that gives a material, else none (the model's own)", () => {
      const sources = slotSources({ mesh: "asset:models/ship.glb", material: "", materials: ["", ""] }, ["Hull", "Sail"]);
      const have = new Map([["asset:canvas.material.json", "canvas"]]);
      const get = (s: (typeof sources)[0][0]) => (s.from === "model" ? (have.get(s.path) ?? null) : null);
      expect(pickSlot(sources[0], get)).toBeNull();
      expect(pickSlot(sources[1], get)).toBe("canvas");
    });
  });

  describe("values (ADR 0107, 0049)", () => {
    afterEach(() => Material._resetShared());

    it("turns script values into material-file data", () => {
      expect(toGraphValue(new Color(1, 0, 0, 1))).toBe("#ff0000");
      expect(toGraphValue(new Color(1, 0, 0, 0.5))).toMatch(/^#ff0000[0-9a-f]{2}$/);
      expect(toGraphValue(new Vector3(1, 2, 3))).toEqual([1, 2, 3]);
      expect(toGraphValue(0.5)).toBe(0.5);
      expect(textureValue({ texture: "asset:images/a.png" })).toBe("images/a.png");
      expect(textureValue({})).toBeNull();
    });

    it("layers a Material's values and keywords over a graph's, warning about unknown names", () => {
      const r = resolveMaterial("asset:rim.material.json", opts(files().read));
      const m = new Material("asset:rim.material.json");
      m.setFloat("Wobble", 1);
      m.setKeyword("RIM", false);
      const v = scriptValues(r, m);
      expect(v.properties).toEqual({ Tint: "#00ff00", Wobble: 1 });
      expect(v.keywords).toEqual({ RIM: false });
      expect(v.warnings.map((w) => w.message)).toEqual([expect.stringMatching(/no property "Wobble"/)]);
    });

    it("resets a built-in material to its settings (the default's without an asset), warning that it has no keywords", () => {
      const m = new Material("");
      m.setFloat("metalness", 1);
      m.setKeyword("RIM", true);
      const v = scriptValues(null, m);
      expect(v.settings).not.toBeNull();
      expect(v.values).toEqual({ metalness: 1 });
      expect(v.warnings.map((w) => w.message)).toEqual([expect.stringMatching(/built-in material; it has no keywords/)]);
    });

    it("applies a shared Material when its version changes, never an untouched one, and rebuilds when a texture value is taken back", () => {
      const shared = Material.shared("asset:red.material.json");
      expect(sharedAction(undefined, shared, false)).toBe("none"); // empty, never applied
      shared.setFloat("roughness", 0.2);
      expect(sharedAction(undefined, shared, false)).toBe("apply");
      expect(sharedAction(shared._version, shared, false)).toBe("none");
      const applied = shared._version;
      shared.setFloat("roughness", 0.3);
      expect(sharedAction(applied, shared, true)).toBe("rebuild"); // a texture was applied and the Material has none now
      shared.setTexture("texture", "asset:images/a.png");
      expect(sharedAction(applied, shared, true)).toBe("apply");
    });

    it("knows a material's property names: a graph's uniforms, else the built-in ones", () => {
      const r = resolveMaterial("asset:rim.material.json", opts(files().read));
      expect(knownProperties(r.compiled).has("Tint")).toBe(true);
      expect(knownProperties(null)).toBe(BUILTIN_PROPERTIES);
      expect(overrideWarnings("asset:red.material.json", "Box", ["color", "wobble"], null).map((w) => w.message)).toEqual(['Box: its material has no property "wobble"; setMaterialProperty ignores it.']);
    });
  });

  describe("keyword variants (ADR 0106) and instancing (ADR 0108)", () => {
    it("lists the other combinations of `variants: all` keywords for warm-up", () => {
      const r = resolveMaterial("asset:rim.material.json", opts(files().read));
      const { variants, warning } = warmVariantKeywords(r.compiled!, r.keywords, "rim");
      expect(variants).toEqual([{ RIM: false }]);
      expect(warning).toBeNull();
      const g = resolveMaterial("asset:pulse.shadergraph.json", opts(files().read));
      expect(warmVariantKeywords(g.compiled!, {}, "pulse").variants).toEqual([]);
    });

    it("draws thin batches as instances while the editor picks", () => {
      expect(instancingFor("thin", false)).toBe("thin");
      expect(instancingFor("thin", true)).toBe("auto");
      expect(instancingFor(undefined, false)).toBe("auto");
      expect(instancingFor("off", true)).toBe("off");
    });
  });

  describe("textures (ADR 0040)", () => {
    it("samples by the import settings: point filtering picks the nearest texel and mip level", () => {
      const base = defaultImportSettings();
      expect(samplingOf({ ...base, filter: "point", mipmaps: false, wrap: "repeat" })).toEqual({ filter: "nearest", mipmaps: "none", wrap: "repeat" });
      expect(samplingOf({ ...base, filter: "point", mipmaps: true, wrap: "mirror" })).toEqual({ filter: "nearest", mipmaps: "nearest", wrap: "mirror" });
      expect(samplingOf({ ...base, filter: "linear", mipmaps: true, wrap: "clamp" })).toEqual({ filter: "linear", mipmaps: "linear", wrap: "clamp" });
    });

    it("loads one copy per use: flipped colour, an unflipped sheet, graph colour decoded in hardware, linear data", () => {
      expect(textureLoad("a.png", "color")).toEqual({ key: "a.png", flipY: true, decode: "shader" });
      expect(textureLoad("a.png", "sheet")).toEqual({ key: "a.png#sheet", flipY: false, decode: "shader" });
      expect(textureLoad("a.png", "graphColor")).toEqual({ key: "a.png#graphColor", flipY: true, decode: "srgb" });
      expect(textureLoad("a.png", "graphData")).toEqual({ key: "a.png#graphData", flipY: true, decode: "linear" });
    });
  });
});
