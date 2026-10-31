import { Assets, Engine, GameObject, SceneManager, type ProjectSettingsInput } from "../../engine";
import "./game";
import { Bird } from "./behaviors/Bird";
import { GameManager } from "./behaviors/GameManager";
import project from "./project.json";

/** Snapshot of the game for the dev tools console and the Playwright smoke tests (tests/e2e). */
export interface FlappyState {
  frame: number;
  state: GameManager["state"] | null;
  score: number;
  best: number;
  birdY: number | null;
}

async function main(): Promise<void> {
  const container = document.getElementById("game") ?? document.body;
  const assets = Assets.fromGlob(import.meta.glob("./**/*.{png,jpg,jpeg,mp3,json}", { eager: true, import: "default" }));
  const engine = await Engine.create({ container, project: project as unknown as ProjectSettingsInput, assets });
  await SceneManager.load("scenes/main.scene.json");
  engine.start();

  const flappy = {
    state(): FlappyState {
      const manager = GameObject.findObjectOfType(GameManager);
      const bird = GameObject.findObjectOfType(Bird);
      return {
        frame: engine.world.time.frameCount,
        state: manager?.state ?? null,
        score: manager?.score ?? 0,
        best: manager?.best ?? 0,
        birdY: bird ? bird.transform.worldPosition.y : null,
      };
    },
  };
  Object.assign(window, { engine, flappy });
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend", `<pre style="color:#f88;padding:16px">${String(err?.stack ?? err)}</pre>`);
});
