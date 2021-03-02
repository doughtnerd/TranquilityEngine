import Engine from "./engine/Engine";
import Input from "./engine/Input";
import SceneManager from "./engine/SceneManager";
import Screen from "./engine/rendering/Screen";
import scene1 from './assets/scenes/scene1.js'
import scene2 from './assets/scenes/scene2.js'
import PhysicsEngine from "./engine/PhysicsEngine";

PhysicsEngine.initialize();

let gameScreen = Screen.create({ resolution: { width: 720, height: 680 } });
document.body.appendChild(gameScreen.screen.screenElement);

gameScreen.screen.canvasElement.focus()
Screen.register(0, gameScreen);

Input.registerScreen(gameScreen.screen.canvasElement);

SceneManager.scenes = [scene1, scene2];

SceneManager.eventEmitter.on("sceneLoading", (data: { progress: any }) => {
  console.debug("Scene Load Progress: ", data.progress);
});

SceneManager.loadScene(0);

Engine.play();
