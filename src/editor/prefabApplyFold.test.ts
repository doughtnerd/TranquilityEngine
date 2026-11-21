// The editor's prefab Apply as an adapter of the override fold (ADR 0280): for every case of the
// shared table, applying an instance's overrides writes a prefab file that, on its own, is what the
// instance was (the engine's src/engine/tests/overrideFold.test.ts runs the same table through the
// resolved view and instantiation).
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { FORMAT, PREFAB, expectCase, observeResolved, overrideCases, prefabFiles } from "../engine/tests/overrideCases";
import { AddNode } from "./document";
import { OrbitCamera } from "./OrbitCamera";
import { applyOverridesTo } from "./prefabs";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { currentProject, openScene, sceneCamera } from "./state";
import { MemoryFileSystem, ROOT, demoFolder } from "./testing";

let fs: MemoryFileSystem;
let project: EditorProject;

beforeEach(async () => {
  Input.reset();
  fs = demoFolder();
  for (const [path, file] of Object.entries(prefabFiles)) fs.files.set(joinPath(ROOT, path), JSON.stringify(file));
  project = await openFolderProject(fs, ROOT);
  useProjectAssets(project);
  currentProject.value = project;
  const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, project.mainScene!);
});

const onDisk = (path: string): unknown => {
  const text = fs.files.get(joinPath(ROOT, path));
  return typeof text === "string" ? JSON.parse(text) : undefined;
};

describe("Apply folds an instance's overrides into its prefab (ADR 0280)", () => {
  for (const c of overrideCases) {
    it(c.name, async () => {
      const scene = openScene.value!;
      scene.stack.execute(new AddNode({ id: "inst", prefab: PREFAB, ...(c.overrides.length ? { overrides: structuredClone(c.overrides) } : {}) }));
      // What the instance is before Apply: the document's resolved view.
      expectCase(c, observeResolved(scene.doc.path, (p) => (p === scene.doc.path ? { format: FORMAT, nodes: [scene.doc.node("inst")] } : onDisk(p))));
      expect(await applyOverridesTo(scene, project, ["inst"])).toBe(c.overrides.length);
      expect(scene.doc.node("inst").overrides).toBeUndefined();
      // The prefab file alone is now what the instance was.
      expectCase(c, observeResolved(PREFAB, onDisk));
    });
  }
});
