import Engine from "./engine/Engine";
import Input from "./engine/Input";
import SceneManager from "./engine/SceneManager";
import Screen from "./engine/rendering/Screen";

let gameScreen = Screen.create({ resolution: { width: 1080, height: 720 } });
document.body.appendChild(gameScreen.screenElement);
Screen.register(0, gameScreen);

Input.registerScreen(gameScreen.screenElement);

SceneManager.scenes = [require("./assets/scenes/scene1.js")];

SceneManager.eventEmitter.on("sceneLoading", (data: { progress: any }) => {
  console.log("Scene Load Progress: ", data.progress);
});

SceneManager.loadScene(0);

Engine.play();
