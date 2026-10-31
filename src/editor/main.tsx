// Scene editor entry (ADR 0022, 0025, 0026). Renders the Preact layout, boots an Editor World
// into the viewport panel with the scene view camera, and opens the demo scene. The render backend draws a grid and axes
// for Editor Worlds and fills the panel.
import { render } from "preact";
import { Engine, GameObject } from "../engine";
import { OrbitCamera } from "./OrbitCamera";
import { DEMO_SCENE, demoAssets, demoSettings, openSceneFile } from "./project";
import { sceneCamera, viewMode } from "./state";
import { App } from "./ui/App";
import "./ui/editor.css";

async function main(): Promise<void> {
  render(<App />, document.getElementById("app")!);

  const engine = await Engine.create({
    kind: "editor",
    container: document.getElementById("viewport")!,
    project: demoSettings(),
    assets: demoAssets(),
  });

  // Editor tools live under the World root, outside the edited scene, so they keep running (ADR 0026).
  const orbit = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  orbit.mode = viewMode.value;
  sceneCamera.value = orbit;

  openSceneFile(engine, DEMO_SCENE);
  engine.start();
  Object.assign(window, { engine, orbit });
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend", `<pre style="color:#f88;padding:16px">${String(err?.stack ?? err)}</pre>`);
});
