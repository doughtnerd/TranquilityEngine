// Scene editor entry (ADR 0022). An Editor World with an orbiting scene camera; the render
// backend draws a ground grid and axes for Editor Worlds. Inspector, hierarchy, gizmos and
// play mode come later.
import { Engine, GameObject } from "../engine";
import { OrbitCamera } from "./OrbitCamera";

async function main(): Promise<void> {
  const container = document.getElementById("viewport") ?? document.body;
  const engine = await Engine.create({
    kind: "editor",
    container,
    project: { name: "TranquilityEditor", display: { width: 1280, height: 720, backgroundColor: "#24272d" } },
  });

  const orbit = OrbitCamera.create(GameObject.create("SceneCamera"));

  engine.start();
  Object.assign(window, { engine, orbit });
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend", `<pre style="color:#f88;padding:16px">${String(err?.stack ?? err)}</pre>`);
});
