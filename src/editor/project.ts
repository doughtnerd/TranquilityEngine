// Project loading. Until project folders open through the platform adapter (ADR 0026), the
// editor bundles the Flappy demo as its project: its assets, settings and script types.
import { Assets, Camera, DEG2RAD, GameObject, type AssetSource, type Engine, type ProjectSettingsInput } from "../engine";
import "../demo/flappy/game"; // registers the demo's behaviors, data components and systems
import demoProject from "../demo/flappy/project.json";
import { CommandStack, SceneDocument, WorldSync, type SceneFile } from "./document";
import { docVersion, openScene, sceneCamera, selection, setViewMode } from "./state";

const DEMO_ROOT = "../demo/flappy/";

/** The demo's assets, keyed relative to its folder like the game sees them. */
export function demoAssets(): AssetSource {
  const modules = import.meta.glob("../demo/flappy/**/*.{png,jpg,jpeg,mp3,json}", { eager: true, import: "default" });
  return Assets.fromGlob(Object.fromEntries(Object.entries(modules).map(([key, value]) => [key.slice(DEMO_ROOT.length), value])));
}

/** Demo project settings for the Editor World. Autoloads are dropped so nothing plays in the editor. */
export function demoSettings(): ProjectSettingsInput {
  const project = demoProject as unknown as ProjectSettingsInput;
  return { ...project, autoload: [], display: { ...project.display, backgroundColor: "#24272d" } };
}

export const DEMO_SCENE = "scenes/main.scene.json";

/** Open a scene file into the Editor World and frame it in the scene view. */
export function openSceneFile(engine: Engine, path: string): void {
  openScene.value?.sync.dispose();
  const doc = new SceneDocument(Assets.json<SceneFile>(path), path);
  const stack = new CommandStack(doc);
  const sync = new WorldSync(engine.world, doc);
  sync.build();
  sync.attach(stack);
  stack.subscribe(() => docVersion.value++);
  openScene.value = { path, doc, stack, sync };
  selection.value = null;
  docVersion.value++;
  frameSceneCamera(engine);
}

/** Match the scene view to the scene's own camera: 2D for orthographic scenes, centred on it. */
function frameSceneCamera(engine: Engine): void {
  const orbit = sceneCamera.value;
  if (!orbit) return;
  const camera = GameObject.findObjectsOfType(Camera).find((c) => engine.world.inEditMode(c.node.entity));
  if (!camera) return;
  const p = camera.transform!.worldPosition;
  if (camera.projection === "orthographic") {
    setViewMode("2d");
    orbit.focus([p.x, p.y, 0], (camera.orthographicSize * 1.15) / Math.tan((orbit.fieldOfView * DEG2RAD) / 2));
  } else {
    orbit.focus([p.x, p.y, p.z]);
  }
}
