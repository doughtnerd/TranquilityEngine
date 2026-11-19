// The Particles plugin (ADR 0134, 0135): its editor half registers the effect, sub-graph and block
// asset kinds, their formats, the Particle Graph panel and the ParticleSystem's Inspector section; its
// runtime half claims the ParticleSystem component and the particles render feature. Deactivating
// either half removes what it registered.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { getComponentClass } from "../../engine/core/registry";
import { ParticleSystem } from "../../engine/render/components";
import { _registeredRenderFeatures } from "../../engine/render/renderFeatures";
import { defaultParticleGraph, formatParticleGraph } from "../../engine/scene/particleGraphFormat";
import { assetKind } from "../../editor/assetBrowser";
import { inspectorTarget, selectAssets } from "../../editor/inspectorTarget";
import { canAddToScene, kindIcon, kindLabel, kindOpens, registeredKind, satisfiesFieldKind } from "../../editor/assetKindLookup";
import { registeredPanels } from "../../editor/layout/registeredPanels";
import { joinPath, openFolderProject } from "../../editor/projects";
import { assetKinds, panels } from "../../editor/sdk/contributions";
import { editor } from "../../editor/sdk";
import type { ParticleGraph } from "../../engine/scene/particleGraph";
import { isPluginActive } from "../../editor/sdk/plugins";
import { useEditorPlugins } from "../testEditorPlugins";
import { currentProject } from "../../editor/state";
import { inspectorSectionsFor, MemoryFileSystem, ROOT, useCoreAssetKinds } from "../../editor/testing";
import { previewKind } from "../../editor/thumbnails/keys";
import { EDITOR_PLUGINS } from "../editor";
import { RUNTIME_PLUGINS } from "../runtime";
import { isRuntimePluginActive, runtimeActivator } from "../runtimeContext";
import { applyTestPlugins } from "../testPlugins";
import { particlesEditorPlugin } from "./editor";
import { effectFileMigrated } from "./editor/particleAssets";
import { blockTemplate, formatAsset, subgraphTemplate } from "./editor/particleGraph/assetDocs";
import { particlesRuntimePlugin } from "./runtime";

useCoreAssetKinds(); // core asset kinds, as main.tsx registers them (ADR 0143)

const FX = "effects/fire.particles.json";
const SUB = "effects/noise.particlesubgraph.json";
const BLOCK = "effects/size.particleblock.json";

async function open(files: Record<string, string>) {
  const fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  for (const [p, text] of Object.entries(files)) fs.files.set(joinPath(ROOT, p), text);
  const project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
  return { project, fs };
}

const editorHalf = useEditorPlugins([particlesEditorPlugin], "each");
afterEach(() => {
  currentProject.value = null;
});

describe("the Particles plugin's editor half (ADR 0134)", () => {
  it("is listed with its runtime half, sharing one manifest", () => {
    expect(EDITOR_PLUGINS).toContain(particlesEditorPlugin);
    expect(RUNTIME_PLUGINS).toContain(particlesRuntimePlugin);
    expect(particlesRuntimePlugin.manifest).toBe(particlesEditorPlugin.manifest);
    expect(particlesEditorPlugin.manifest).toMatchObject({ name: "myco.particles", server: false });
  });

  it("registers the three asset kinds: matching, labels, icons, previews, opening, inspectors, New… entries", () => {
    expect(assetKind(FX)).toBe("particles");
    expect(assetKind("effects/Fire.PARTICLES.json")).toBe("particles");
    expect(assetKind(SUB)).toBe("particlesubgraph");
    expect(assetKind(BLOCK)).toBe("particleblock");
    expect([kindLabel("particles"), kindLabel("particlesubgraph"), kindLabel("particleblock")]).toEqual(["Particle Effect", "Particle Sub-graph", "Particle Block"]);
    for (const k of ["particles", "particlesubgraph", "particleblock"]) expect(kindIcon(k)).toMatch(/^M/);
    expect(previewKind(FX)).toBe("particles");
    for (const p of [FX, SUB, BLOCK]) {
      expect(kindOpens(p)).toBe(true);
      expect(inspectedFor(p)).toBe(p);
    }
    expect(canAddToScene(FX)).toBe(true); // a ParticleSystem node (ADR 0143)
    expect(canAddToScene(SUB)).toBe(false);
    expect(["particles", "particlesubgraph", "particleblock"].map((k) => assetKinds.get(k)?.create?.label)).toEqual(["New Particle Effect", "New Particle Sub-graph", "New Particle Block"]);
  });

  it("lets effect fields (ParticleSystem.effect) take effects only", () => {
    expect(satisfiesFieldKind("particles", FX)).toBe(true);
    expect(satisfiesFieldKind("particles", SUB)).toBe(false);
    expect(satisfiesFieldKind("material", FX)).toBe(false);
  });

  it("opens each kind in the Particle Graph", async () => {
    await open({ [SUB]: formatAsset(subgraphTemplate()) });
    expect(editor.assets.openIn("particlegraph")).toBeNull();
    expect(editor.assets.open(SUB)).toBe(true);
    expect(editor.assets.openIn("particlegraph")).toBe(SUB);
    expect(kindOpens(BLOCK)).toBe(true);
  });

  it("loads each kind's Inspector view", async () => {
    for (const k of ["particles", "particlesubgraph", "particleblock"]) expect(typeof (await assetKinds.get(k)!.inspector!())).toBe("function");
  });

  it("registers the Particle Graph panel beside the Scene view, once", () => {
    expect(registeredPanels().has("particlegraph")).toBe(true);
    expect(registeredPanels().get("particlegraph")).toEqual({ title: "Particle Graph", beside: "scene", owner: { plugin: "myco.particles", pluginTitle: "Particles" } });
  });

  it("registers the ParticleSystem's Inspector section", async () => {
    const [section] = inspectorSectionsFor("engine.ParticleSystem", [["root"]]);
    expect(section).toBeDefined();
    await section!.preload();
    expect(section!.loaded).toBe(true);
  });

  it("declares formats that round-trip effects, sub-graphs and blocks", () => {
    const [particlesFormat, particleSubgraphFormat, particleBlockFormat] = ["particles", "particlesubgraph", "particleblock"].map((k) => assetKinds.get(k)!.format!);
    const text = formatParticleGraph(defaultParticleGraph());
    const fx = particlesFormat.parse(JSON.parse(text), FX);
    expect(fx.problems).toEqual([]);
    expect(particlesFormat.format(fx.value)).toBe(text);
    for (const [format, asset, path] of [
      [particleSubgraphFormat, subgraphTemplate(), SUB],
      [particleBlockFormat, blockTemplate(), BLOCK],
    ] as const) {
      const once = format.format(format.parse(JSON.parse(formatAsset(asset)), path).value);
      const read = format.parse(JSON.parse(once), path);
      expect(read.problems).toEqual([]);
      expect(format.format(read.value)).toBe(once);
    }
  });

  it("reads a foreign file as a graph with problems", async () => {
    const { project } = await open({ [FX]: '"nope"', [SUB]: '{ "format": "nope" }' });
    const bad = editor.assets.read<ParticleGraph>(project, FX);
    expect(bad.problems.length).toBeGreaterThan(0);
    expect(bad.value.systems).toBeDefined();
    expect(editor.assets.read(project, SUB).problems.length).toBeGreaterThan(0);
  });

  it("reads old-format effects as migrated graphs", async () => {
    const { project } = await open({ [FX]: JSON.stringify({ format: "myco.particles@1", emitters: [] }), "b.particles.json": formatParticleGraph(defaultParticleGraph()) });
    expect(effectFileMigrated(project, FX)).toBe(true);
    expect(effectFileMigrated(project, "b.particles.json")).toBe(false);
  });

  it("removes everything when deactivated", () => {
    editorHalf.off();
    expect(isPluginActive("myco.particles")).toBe(false);
    for (const k of ["particles", "particlesubgraph", "particleblock"]) {
      expect(registeredKind(k)).toBeUndefined();
    }
    expect(assetKind(FX)).toBe("json"); // a generic file again: it opens in the Code panel and adds to no scene
    expect(canAddToScene(FX)).toBe(false);
    expect(panels.get("particlegraph")).toBeUndefined();
    expect(registeredPanels().has("particlegraph")).toBe(false);
    expect(inspectorSectionsFor("engine.ParticleSystem", [["root"]])).toHaveLength(0);
  });
});

describe("the Particles plugin's runtime half (ADR 0135)", () => {
  afterEach(() => applyTestPlugins()); // as Vitest's setup file leaves it

  it("claims the ParticleSystem component and the lazy particles render feature", () => {
    expect(isRuntimePluginActive("myco.particles")).toBe(true);
    expect(getComponentClass("engine.ParticleSystem")).toBe(ParticleSystem);
    const feature = _registeredRenderFeatures().find((f) => f.spec.name === "particles");
    expect(feature?.spec).toMatchObject({ phase: "effects", types: [ParticleSystem], lazy: true, holdsFirstFrame: false });
  });

  it("loads the feature's factory on demand", async () => {
    const feature = _registeredRenderFeatures().find((f) => f.spec.name === "particles")!;
    expect(typeof (await feature.load())).toBe("function");
    // The runtime half's module names the feature module only in a dynamic import, so Babylon stays out of `myco`.
    const src = readFileSync(new URL("./runtime/index.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from "\.\/particlesFeature"/);
    expect(src).not.toMatch(/babylon\/particles"/);
  });

  it("removes them when deactivated", () => {
    runtimeActivator.deactivate("myco.particles");
    expect(getComponentClass("engine.ParticleSystem")).toBeUndefined();
    expect(_registeredRenderFeatures().some((f) => f.spec.name === "particles")).toBe(false);
  });
});

/** The file the Inspector shows with `entry` alone selected in the Assets panel (null: none). */
function inspectedFor(entry: string): string | null {
  selectAssets([entry]);
  const target = inspectorTarget.peek();
  const shown = target.kind === "asset" ? target.path : null;
  selectAssets([]);
  return shown;
}
