import Input from "./Input";
import PhysicsEngine from "./PhysicsEngine";
import Camera from "./rendering/Camera";
import SceneManager from "./SceneManager";
import Time from "./Time";

export default class Engine {
  static updateInterval;
  static fixedUpdateInterval;
  static timestep = 20;
  static targetFrameRate = 200;
  static frameRate = 0;
  static startTime;

  static play() {
    if (Engine.updateInterval) {
      clearInterval(Engine.updateInterval);
    }

    Engine.startTime = Date.now();

    Engine.start();

    Engine.loop();
    Engine.updateInterval = setInterval(Engine.loop, (1 / Engine.targetFrameRate) * 1000);

    Engine.fixedUpdateInterval = setInterval(() => {
      const fixedStart = Date.now();
      PhysicsEngine.fixedUpdate();
      Time.fixedDeltaTime = (20 + Date.now() - fixedStart) * 0.001;
    }, Engine.timestep);
  }

  static loop() {
    const frameStart = Date.now();

    Engine.processInput();

    Engine.update();
    Engine.lateUpdate();
    Engine.render();

    Time.deltaTime = ((1 / Engine.targetFrameRate) * 1000 + Date.now() - frameStart) * 0.001;

    Engine.frameRate = 1 / Time.deltaTime;
    Time.time += Time.deltaTime;
  }

  static start() {
    SceneManager.activeScene.start();
  }

  static processInput() {
    Input.processKeyboardInput();
    Input.processMouseInput();
  }

  static update() {
    SceneManager.activeScene.update();
  }

  static lateUpdate() {
    SceneManager.activeScene.lateUpdate();
  }

  static render() {
    Camera.allCameras.forEach((cam) => cam.render());
  }

  static stop() {
    clearInterval(Engine.updateInterval)
    clearInterval(Engine.fixedUpdateInterval)
  }
}

