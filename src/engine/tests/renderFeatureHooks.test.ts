// ADR 0154: the renderer asks render features things only through `BabylonFeature`'s optional hooks
// (describe, warm, diagnostics, the UI core), never a particle or UI feature by name; the diagnostics'
// empty value is one function next to the type; the particle preview is render policy, handed over once.
import { readFileSync } from "node:fs";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { World } from "../core/World";
import { Assets, Engine, GameObject, Graphics, SceneManager } from "../index";
import { BabylonRenderer, type PluginFeature } from "../render/babylon/BabylonRenderer";
import { BabylonSurface } from "../render/babylon/BabylonSurface";
import type { BabylonFeature, BabylonFeatureFactory, BabylonFeatureHost, BabylonWarmFactory } from "../render/babylon/feature";
import type { WarmCustom } from "../render/babylon/warmUp";
import { FakeRenderSurface } from "../render/fakeViewport";
import { noRenderDiagnostics } from "../render/RenderSurface";
import type { RenderPolicy } from "../render/renderPolicy";
import type { RenderFeatureSpec } from "../render/renderFeatures";
import type { UICore } from "../ui/UICore";
import type { WarmContent } from "../scene/warmUp";

const NOTHING: WarmContent = { meshes: [], effects: [], worldUI: false };
const EFFECTS: WarmContent = { meshes: [], effects: ["fx.particles.json"], worldUI: false };
const warmItem = (key: string): WarmCustom => ({ key, build: () => null });

describe("render feature hooks (ADR 0154)", () => {
  let nullEngine: NullEngine;
  let renderer: BabylonRenderer;
  let world: World;
  const Ctor = BabylonRenderer as unknown as new (engine: NullEngine, settings: unknown, plugged: PluginFeature[]) => BabylonRenderer;
  const make = (plugged: PluginFeature[]) => (renderer = new Ctor(nullEngine, world.settings, plugged));

  beforeEach(async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    await Engine.create({ headless: true });
    await SceneManager.load("s.json");
    world = World.require();
    nullEngine = new NullEngine();
  });
  afterEach(() => {
    renderer?.dispose();
    nullEngine.dispose();
  });

  /** An eager feature answering every hook, and the host its factory was given. */
  function fakeFeature() {
    const node = GameObject.create("emitter");
    const drawn = { name: "drawn-by-fake" };
    const core = { fake: true } as unknown as UICore;
    let host: BabylonFeatureHost | null = null;
    const feature: BabylonFeature = {
      sync: () => {},
      describe: (d) => (d === drawn ? { node, what: `The fake of "${node.name}"`, asset: "fx/fake.json" } : null),
      warm: (content) => content.effects.map((e) => warmItem(`fake:${String(e)}`)),
      diagnostics: () => ({ count: 3 }),
      uiCore: () => core,
      dispose: () => {},
    };
    const factory: BabylonFeatureFactory = (h) => ((host = h), feature);
    const spec: RenderFeatureSpec = { name: "fake", phase: "content", types: [], lazy: false };
    return { plugged: { registration: { spec, load: async () => factory }, factory }, feature, node, drawn, core, host: () => host! };
  }

  it("asks every loaded feature to describe a drawn object, warm content, report diagnostics and give its UI core", () => {
    const f = fakeFeature();
    make([f.plugged]);
    const describe = (renderer as unknown as { describeMesh(d: object): unknown }).describeMesh.bind(renderer);
    expect(describe(f.drawn)).toEqual({ what: `The fake of "emitter"`, prefab: "fx/fake.json" });
    expect(describe({ name: "something else" })).toBeNull();

    expect(renderer.diagnostics().features).toEqual({ fake: { count: 3 } });
    expect(renderer.uiState()).toBe(f.core);

    const add = vi.spyOn((renderer as unknown as { warmer: { add(items: unknown[]): Promise<void> } }).warmer, "add");
    void renderer.warmUp(EFFECTS);
    expect(add).toHaveBeenCalledWith([expect.objectContaining({ key: "fake:fx.particles.json" })]);
  });

  it("builds plugin features from a core host that carries no single feature's services", () => {
    const f = fakeFeature();
    make([f.plugged]);
    const host = f.host();
    for (const gone of ["particleHost", "particlePreview", "uiHost", "reflected"]) expect(host).not.toHaveProperty(gone);
    expect(host.policy()).toMatchObject({ sceneView: false, particlePreview: null });
    const preview = { selected: () => true, playing: false, speed: 2, simulateAll: false, restarts: 0 };
    renderer.setPolicy({ particlePreview: preview });
    expect(host.policy().particlePreview).toBe(preview); // the preview reaches features as render policy
    expect(host.pixelGrid()).toMatchObject({ pixelRatio: 1 });
    renderer.resize(0.75);
    expect(host.pixelGrid().pixelRatio).toBe(0.75);
  });

  it("loads a lazy feature its spec says warms the content, then asks it", async () => {
    const warm = vi.fn((content: WarmContent) => content.effects.map((e) => warmItem(`lazy:${String(e)}`)));
    const factory: BabylonFeatureFactory = () => ({ sync: () => {}, warm, dispose: () => {} });
    const load = vi.fn(async () => factory);
    const spec: RenderFeatureSpec = { name: "lazyFx", phase: "effects", types: [], lazy: true, warms: (c) => c.effects.length > 0 };
    make([{ registration: { spec, load }, factory: null }]);
    const add = vi.spyOn((renderer as unknown as { warmer: { add(items: unknown[]): Promise<void> } }).warmer, "add");
    await renderer.warmUp(NOTHING);
    expect(load).not.toHaveBeenCalled();
    void renderer.warmUp(EFFECTS);
    await vi.waitFor(() => expect(add).toHaveBeenCalledWith([expect.objectContaining({ key: "lazy:fx.particles.json" })]));
    expect(load).toHaveBeenCalledTimes(1);
    expect(warm).toHaveBeenCalledWith(EFFECTS);
  });

  it("warms with a registration's lighter loadWarm, without loading the feature", async () => {
    const load = vi.fn(async (): Promise<BabylonFeatureFactory> => () => ({ sync: () => {}, dispose: () => {} }));
    const warmFactory: BabylonWarmFactory = () => ({ warm: (content) => (content.worldUI ? [warmItem("canvas")] : []) });
    const loadWarm = vi.fn(async () => warmFactory);
    const spec: RenderFeatureSpec = { name: "lazyUI", phase: "overlay", types: [], lazy: true, warms: (c) => c.worldUI };
    make([{ registration: { spec, load, loadWarm }, factory: null }]);
    const add = vi.spyOn((renderer as unknown as { warmer: { add(items: unknown[]): Promise<void> } }).warmer, "add");
    void renderer.warmUp({ ...NOTHING, worldUI: true });
    void renderer.warmUp({ ...NOTHING, worldUI: true });
    await vi.waitFor(() => expect(add).toHaveBeenCalledWith([expect.objectContaining({ key: "canvas" })]));
    expect(loadWarm).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
  });

  it("the renderer names no feature it doesn't read content from", () => {
    const src = readFileSync(new URL("../render/babylon/BabylonRenderer.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/"(particles|ui|sky|water|tilemaps)"/);
    expect(src).not.toMatch(/Particle(sFeatureApi|Host|PreviewSettings)|UIFeatureApi|BabylonUIHost|uiHost|particleHost|CANVAS_PREFIX|WARM_PREFIX|setParticlePreview|restartParticlePreview|_worldRaycast|PARTICLE_SCALE|import\("\.\/ui"\)/);
  });
});

describe("the empty diagnostics (ADR 0154)", () => {
  const saved = { document: globalThis.document, ResizeObserver: globalThis.ResizeObserver };
  afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(globalThis, saved);
  });

  /** Just enough DOM for a `BabylonSurface` to be made in Node. */
  function fakeDom(): HTMLElement {
    const canvas = { style: {}, tabIndex: 0, clientWidth: 800, clientHeight: 600, remove() {} };
    Object.assign(globalThis, {
      document: { createElement: () => canvas },
      ResizeObserver: class {
        observe(): void {}
        disconnect(): void {}
      },
    });
    return { clientWidth: 800, clientHeight: 600, appendChild() {} } as unknown as HTMLElement;
  }

  /** A stand-in renderer that records the policy calls it gets. */
  function fakeRenderer(tools: Promise<null> = Promise.resolve(null)) {
    const setPolicy = vi.fn((_change: Partial<RenderPolicy>) => {});
    const r = {
      scene: {},
      setPolicy,
      setPixelGrid() {},
      loadEditorTools: () => tools,
      editorTools: () => null,
      setClearColor() {},
      setVariantReport() {},
      resize() {},
      sync() {},
      dispose() {},
    };
    vi.spyOn(BabylonRenderer, "create").mockResolvedValue(r as unknown as BabylonRenderer);
    return { setPolicy };
  }

  it("a fake surface and a surface whose renderer hasn't started report the same empty value", () => {
    expect(new FakeRenderSurface().diagnostics()).toEqual(noRenderDiagnostics());
    fakeRenderer(new Promise(() => {}));
    const surface = new BabylonSurface(fakeDom(), new FakeSettings() as never, "editor");
    const d = surface.diagnostics();
    expect(d.quality.tier).toBe(Graphics.tier.name); // the surface's own: the tier as applied
    expect({ ...d, quality: noRenderDiagnostics().quality }).toEqual(noRenderDiagnostics());
    surface.dispose();
  });

  it("hands the render policy, particle preview included, to the renderer once; later changes go straight to it", async () => {
    let toolsLoaded!: (v: null) => void;
    const { setPolicy } = fakeRenderer(new Promise((r) => (toolsLoaded = r)));
    const surface = new BabylonSurface(fakeDom(), new FakeSettings() as never, "editor");
    const viewport = surface.editorViewport(); // an editor World's handle: the scene view and particle preview policy
    viewport.setParticlePreview({ speed: 2 });
    await vi.waitFor(() => expect(setPolicy).toHaveBeenCalledTimes(1));
    expect(setPolicy.mock.calls[0][0]).toMatchObject({ sceneView: true, particlePreview: { speed: 2, playing: true, restarts: 0 } });
    viewport.restartParticlePreview(); // while the editor tools load
    expect(setPolicy).toHaveBeenCalledTimes(2);
    expect(setPolicy.mock.calls[1][0]).toEqual({ particlePreview: expect.objectContaining({ speed: 2, restarts: 1 }) });
    toolsLoaded(null);
    expect(await surface.started).toBe(true);
    expect(setPolicy).toHaveBeenCalledTimes(2); // no second replay once the tools have loaded
    surface.dispose();
  });
});

/** The project settings a surface reads. */
class FakeSettings {
  display = { width: 800, height: 600, scaleMode: "fit", backgroundColor: "#000000" };
}
