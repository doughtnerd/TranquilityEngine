import Engine from "./engine/Engine";
import Renderer from "./engine/Renderer";
import SceneManager from "./engine/SceneManager";

Renderer.init({ resolution: { width: 720, height: 480 } });

SceneManager.scenes = [require("./assets/scenes/scene1.js")];

SceneManager.eventEmitter.on("SceneLoading", (data: { progress: any }) => {
  console.log("Scene Load Progress: ", data.progress);
});

SceneManager.loadScene(0);

Engine.play();
