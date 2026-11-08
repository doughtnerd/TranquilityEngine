// ADR 0080: what the warm-up row listed as checked only by hand, now on Babylon's NullEngine: the
// variant report (a shader variant compiled after the load names its node, prefab and define change)
// and (in `materialLibrary.test.ts`) renderer override copies following a base texture that loads after
// them. And ADR 0120's load
// fixes that run without a GPU: the screen UI's readable canvas and the remembered include expansion.
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
// @ts-expect-error `_ClearIncludeCache` is our patch's (patches/@babylonjs+core+9.32.0.patch), not in Babylon's types
import { ProcessIncludes, _ClearIncludeCache } from "@babylonjs/core/Engines/Processors/shaderProcessor.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Vector3 as BVector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readableCanvas } from "../render/babylon/ui";
import { VariantReport, WARM_PREFIX } from "../render/babylon/warmUp";

describe("the variant report (ADR 0080)", () => {
  let engine: NullEngine;
  let scene: Scene;
  let now = 0;
  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    engine = new NullEngine();
    scene = new Scene(engine);
    const camera = new TargetCamera("view", new BVector3(0, 2, 10), scene);
    camera.setTarget(BVector3.Zero());
    scene.activeCamera = camera;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    scene.dispose();
    engine.dispose();
  });

  const frame = (report: VariantReport) => {
    scene.render();
    report.afterRender();
  };

  it("names the node, its prefab and the define change of a variant compiled after the load, once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const name = "material:asset:materials/sail.material.json";
    const sail = CreateBox("sail", {}, scene);
    sail.material = new PBRMaterial(name, scene);
    const report = new VariantReport(engine, scene, (m) => ("name" in m && m.name.startsWith("helper") ? null : { what: `"${m.name}"`, prefab: m.name === "torn" ? "prefabs/ship.prefab.json" : undefined }));
    frame(report); // the load's own first draws: quiet
    expect(warn).not.toHaveBeenCalled();
    now = 5000;
    // A script turns a sail into an unlit variant of the same material mid-game.
    const torn = CreateBox("torn", {}, scene);
    const unlit = new PBRMaterial(name, scene);
    unlit.unlit = true;
    torn.material = unlit;
    frame(report);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('"torn"');
    expect(message).toContain("materials/sail.material.json");
    expect(message).toMatch(/\+UNLIT/); // what changed against the variant that was drawn before
    expect(message).toContain("Add prefabs/ship.prefab.json to the scene's settings.preload list"); // the prefab, as the fix
    // The same variant again (another node) isn't logged twice.
    const torn2 = CreateBox("torn", {}, scene);
    const unlit2 = new PBRMaterial(name, scene);
    unlit2.unlit = true;
    torn2.material = unlit2;
    frame(report);
    expect(warn).toHaveBeenCalledTimes(1);
    report.dispose();
  });

  it("keeps quiet about the warmer's own meshes and what isn't content", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const report = new VariantReport(engine, scene, (m) => (m.name.startsWith("helper") ? null : { what: m.name }));
    frame(report);
    now = 5000;
    const warm = CreateBox(`${WARM_PREFIX}crate`, {}, scene);
    warm.material = new PBRMaterial("material:a", scene);
    const helper = CreateBox("helper:grid", {}, scene);
    const m = new PBRMaterial("material:b", scene);
    m.unlit = true;
    helper.material = m;
    frame(report);
    expect(warn).not.toHaveBeenCalled();
    report.dispose();
  });

  it("is quiet for a moment after a warm-up drains", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const report = new VariantReport(engine, scene, (m) => ({ what: m.name }));
    frame(report);
    now = 5000;
    report.quiet(1000); // a warm-up just drained: what it loaded draws for the first time
    const box = CreateBox("late", {}, scene);
    box.material = new PBRMaterial("material:c", scene);
    frame(report);
    expect(warn).not.toHaveBeenCalled();
    report.dispose();
  });
});

describe("the screen UI's canvas reads back cheaply (ADR 0120)", () => {
  const fakeEngine = (isWebGPU: boolean) => {
    const contexts: unknown[] = [];
    const canvas = { getContext: (_kind: string, options?: unknown) => (contexts.push(options ?? null), {}) };
    const createCanvas = () => canvas;
    return { engine: { isWebGPU, createCanvas } as unknown as AbstractEngine, contexts, createCanvas };
  };

  it("makes the GUI's canvas with willReadFrequently on WebGPU, where its redrawn part is read back", () => {
    const { engine, contexts, createCanvas } = fakeEngine(true);
    const made = readableCanvas(engine, () => {
      const c = engine.createCanvas(1, 1) as unknown as { getContext(kind: string): unknown };
      c.getContext("2d"); // what Babylon's DynamicTexture does next
      return "texture";
    });
    expect(made).toBe("texture");
    expect(contexts[0]).toEqual({ willReadFrequently: true }); // the first context decides
    expect(engine.createCanvas).toBe(createCanvas); // put back
  });

  it("leaves other engines' canvases alone", () => {
    const { engine, contexts } = fakeEngine(false);
    readableCanvas(engine, () => engine.createCanvas(1, 1));
    expect(contexts).toEqual([]);
  });
});

describe("Babylon's include expansion is remembered (ADR 0120, our patch)", () => {
  type Options = { includesShadersStore: Record<string, string>; supportsUniformBuffers: boolean; indexParameters: Record<string, number>; shadersRepository: string };
  const expand = (code: string, options: Options) => {
    let out = "";
    (ProcessIncludes as (c: string, o: Options, cb: (s: string) => void) => void)(code, options, (s) => (out = s));
    return out;
  };
  afterEach(() => _ClearIncludeCache());

  it("expands as before, and again when an include or a light count changes", () => {
    let reads = 0;
    const raw: Record<string, string> = { light: "L{X};", lights: "#include<light>[0..maxLights]" };
    const store = new Proxy(raw, { get: (t, k: string) => (reads++, t[k]) });
    const options: Options = { includesShadersStore: store, supportsUniformBuffers: true, indexParameters: { maxLights: 2 }, shadersRepository: "" };
    expect(expand("a #include<lights> b", options)).toBe("a L0;\nL1;\n b");
    const first = reads;
    reads = 0;
    expect(expand("a #include<lights> b", options)).toBe("a L0;\nL1;\n b");
    expect(reads).toBeLessThan(first); // remembered: each include only checked
    options.indexParameters = { maxLights: 3 };
    expect(expand("a #include<lights> b", options)).toBe("a L0;\nL1;\nL2;\n b"); // another light count
    raw.light = "M{X};"; // an include registered again with new content
    expect(expand("a #include<lights> b", options)).toBe("a M0;\nM1;\nM2;\n b");
  });
});
