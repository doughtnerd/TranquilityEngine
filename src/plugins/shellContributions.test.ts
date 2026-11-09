// ADR 0146: plugin code that lived in the editor shell reaches it through contribution points. Create Tilemap and
// Create Particle System keep their places in the Create menu, Create Tileset from Slices is an asset action, the
// Play Stats agent count, the particle preview, the embedded-effect migration and the physics prefetch are
// registered by their plugins, and all of them go when their plugin does.
import { describe, expect, it } from "vitest";
import { defaultImportSettings, formatImportSettings, sidecarPath } from "../engine/scene/importSettings";
import { NEW_NODE_KINDS, newNodeKinds, newNodeEntry } from "../editor/nodeCreate";
import { joinPath, openFolderProject } from "../editor/projects";
import { assetActions, hierarchyCreateEntries, idlePrefetches, panelExtensions, playStatsCounters, sceneOpenMigrations, viewportTools } from "../editor/sdk/contributions";
import { SceneDocument } from "../editor/document";
import { MemoryFileSystem, ROOT, useCoreAssetKinds } from "../editor/testing";
import { useEditorPlugins } from "./testEditorPlugins";
import { navigationEditorPlugin } from "./navigation/editor";
import { particlesEditorPlugin } from "./particles/editor";
import { physicsEditorPlugin } from "./physics/editor";
import { tilemapsEditorPlugin } from "./tilemaps/editor";

const PLUGINS = [particlesEditorPlugin, navigationEditorPlugin, tilemapsEditorPlugin, physicsEditorPlugin];
useCoreAssetKinds();
const halves = useEditorPlugins(PLUGINS, "each");

describe("the Hierarchy's Create menu (ADR 0146)", () => {
  it("lists plugins' kinds where they have always been", () => {
    const labels = newNodeKinds().map((k) => k.label);
    expect(labels.slice(0, 4)).toEqual(["Empty", "Sprite", "Tilemap", "Camera"]);
    expect(labels.slice(labels.indexOf("Reflection Probe"), labels.indexOf("Reflection Probe") + 3)).toEqual(["Reflection Probe", "Particle System", "Water"]);
    expect(labels).toHaveLength(NEW_NODE_KINDS.length + 2);
  });

  it("makes the plugins' nodes", () => {
    const doc = new SceneDocument({ format: "myco.scene@1", nodes: [] } as never, "a.scene.json");
    const map = newNodeEntry(doc, "tilemap", null, [1, 2, 0], "asset:t.tileset.json");
    expect(map.name).toBe("Tilemap");
    expect(map.components).toEqual([
      { type: "engine.Transform", data: { position: [1, 2, 0] } },
      { type: "engine.Tilemap", data: { tileset: "asset:t.tileset.json" } },
      { type: "engine.TilemapCollider2D", data: {} },
    ]);
    expect(newNodeEntry(doc, "particle-system", null).components![1]).toEqual({ type: "engine.ParticleSystem", data: {} });
    expect(hierarchyCreateEntries.get("particle-system")!.createAsset).toBeTypeOf("function");
  });

  it("drops a disabled plugin's kinds", () => {
    halves.off(); // Tilemaps and Particles among them
    expect(newNodeKinds().map((k) => k.kind)).toEqual(NEW_NODE_KINDS.map((k) => k.kind));
    const doc = new SceneDocument({ format: "myco.scene@1", nodes: [] } as never, "a.scene.json");
    expect(() => newNodeEntry(doc, "tilemap", null)).toThrow(/plugin disabled/);
  });
});

describe("Create Tileset from Slices (ADR 0146)", () => {
  it("is offered for slices and for an image with slices", async () => {
    const fs = new MemoryFileSystem();
    fs.files.set(joinPath(ROOT, "project.json"), "{}");
    fs.files.set(joinPath(ROOT, "images/t.png"), new Uint8Array([137, 80, 78, 71]));
    fs.files.set(joinPath(ROOT, "images/u.png"), new Uint8Array([137, 80, 78, 71]));
    const settings = defaultImportSettings();
    settings.sprites = [{ name: "a", rect: [0, 0, 16, 16], pivot: [0.5, 0.5] }];
    fs.files.set(joinPath(ROOT, sidecarPath("images/t.png")), formatImportSettings(settings));
    const project = await openFolderProject(fs, ROOT);
    const action = assetActions.get("myco.tilemaps.tileset-from-slices")!;
    expect(action.label).toBe("Create Tileset from Slices");
    expect(action.appliesTo(project, [{ path: "images/t.png" }])).toBe(true);
    expect(action.appliesTo(project, [{ path: "images/t.png", slice: "a" }])).toBe(true);
    expect(action.appliesTo(project, [{ path: "images/u.png" }])).toBe(false);
    expect(action.appliesTo(project, [{ path: "images/t.png" }, { path: "images/u.png" }])).toBe(false);
  });
});

describe("the plugins' other shell contributions (ADR 0146)", () => {
  it("are registered while their plugin is active, and go with it", () => {
    const ids = () => [
      playStatsCounters.get("myco.navigation.agents")?.label,
      viewportTools.get("myco.particles.preview")?.id,
      panelExtensions.get("myco.particles.preview")?.panel,
      sceneOpenMigrations.get("myco.particles.embedded-effects")?.failure,
      idlePrefetches.get("myco.physics")?.id,
      assetActions.get("myco.tilemaps.tileset-from-slices")?.id,
    ];
    expect(ids()).toEqual(["nav agents", "myco.particles.preview", "scene", "move the embedded particle effects out of", "myco.physics", "myco.tilemaps.tileset-from-slices"]);
    halves.off();
    expect(ids()).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  });
});
