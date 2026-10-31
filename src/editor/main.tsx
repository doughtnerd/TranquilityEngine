// Scene editor entry (ADR 0022, 0025). Renders the Preact layout, then boots an Editor World
// into the viewport panel with the scene view camera. The render backend draws a grid and axes
// for Editor Worlds and fills the panel.
import { render } from "preact";
import { Engine, GameObject } from "../engine";
import { OrbitCamera } from "./OrbitCamera";
import { sceneCamera, viewMode } from "./state";
import { App } from "./ui/App";
import "./ui/editor.css";

async function main(): Promise<void> {
  render(<App />, document.getElementById("app")!);

  const engine = await Engine.create({
    kind: "editor",
    container: document.getElementById("viewport")!,
    project: { name: "TranquilityEditor", display: { width: 1280, height: 720, backgroundColor: "#24272d" } },
  });

  const orbit = OrbitCamera.create(GameObject.create("SceneCamera"));
  orbit.mode = viewMode.value;
  sceneCamera.value = orbit;

  engine.start();
  Object.assign(window, { engine, orbit });
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend", `<pre style="color:#f88;padding:16px">${String(err?.stack ?? err)}</pre>`);
});
