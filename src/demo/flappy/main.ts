import { Assets, Engine, SceneManager, type ProjectSettingsInput } from "../../engine";
import "./game";
import project from "./project.json";

async function main(): Promise<void> {
  const container = document.getElementById("game") ?? document.body;
  const assets = Assets.fromWebpackContext(require.context("./", true, /\.(png|jpe?g|mp3|json)$/));
  const engine = await Engine.create({ container, project: project as unknown as ProjectSettingsInput, assets });
  await SceneManager.load("scenes/main.scene.json");
  engine.start();
  // Handy for poking at the running world from the dev tools console.
  (window as unknown as { engine: Engine }).engine = engine;
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend", `<pre style="color:#f88;padding:16px">${String(err?.stack ?? err)}</pre>`);
});
