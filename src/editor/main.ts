// Scene editor entry (ADR 0022). For now it's just an empty 3D scene view: an Editor World
// with a perspective camera looking at the origin. The render backend draws a ground grid and
// axes for Editor Worlds. Inspector, hierarchy, gizmos and play mode come later.
import { Camera, Engine, GameObject } from "../engine";

async function main(): Promise<void> {
  const container = document.getElementById("viewport") ?? document.body;
  const engine = await Engine.create({
    kind: "editor",
    container,
    project: { name: "TranquilityEditor", display: { width: 1280, height: 720, backgroundColor: "#24272d" } },
  });

  // Orbit-style rig: the pivot yaws around the origin, the camera sits back and pitches down.
  const pivot = GameObject.create("EditorCameraPivot");
  pivot.transform!.eulerAngles = [0, 35, 0];
  const camera = GameObject.create("EditorCamera", { parent: pivot });
  camera.transform!.position = [0, 4.5, 10];
  camera.transform!.eulerAngles = [-24, 0, 0];
  camera.addBehavior(Camera, { projection: "perspective", fieldOfView: 50 });

  engine.start();
  Object.assign(window, { engine });
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend", `<pre style="color:#f88;padding:16px">${String(err?.stack ?? err)}</pre>`);
});
