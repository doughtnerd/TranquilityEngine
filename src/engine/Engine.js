import Input from "./Input";
import PhysicsEngine from "./PhysicsEngine";
import Camera from "./rendering/Camera";
import SceneManager from "./SceneManager";
import Time from "./Time";

let updateInterval;
let fixedUpdateInterval;
let timestep = 20;
let targetFrameRate = 200;
let frameRate = 0;
let startTime;

function play() {
  if (updateInterval) {
    clearInterval(updateInterval);
  }

  startTime = Date.now();

  start();

  loop();
  updateInterval = setInterval(loop, (1 / targetFrameRate) * 1000);

  fixedUpdateInterval = setInterval(() => {
    const fixedStart = Date.now();
    PhysicsEngine.fixedUpdate();
    Time.fixedDeltaTime = (20 + Date.now() - fixedStart) * 0.001;
  }, timestep);
}

function loop() {
  const frameStart = Date.now();

  processInput();

  update();
  lateUpdate();
  render();

  Time.deltaTime = ((1 / targetFrameRate) * 1000 + Date.now() - frameStart) * 0.001;

  frameRate = 1 / Time.deltaTime;
  Time.time += Time.deltaTime;
}

function start() {
  SceneManager.activeScene.start();
}

function processInput() {
  Input.processKeyboardInput();
  Input.processMouseInput();
}

function update() {
  SceneManager.activeScene.update();
}

function lateUpdate() {
  SceneManager.activeScene.lateUpdate();
}

function render() {
  Camera.allCameras.forEach((cam) => cam.render());
}

export default {
  play,
  frameRate,
  targetFrameRate,
};
