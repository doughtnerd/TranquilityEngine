const Time = require("./Time");
const SceneManager = require("./SceneManager");
const PhysicsEngine = require("./PhysicsEngine");

const Input = require("./Input");
const SceneRenderer = require("./rendering/SceneRenderer");
const Camera = require("./rendering/Camera");

let interval;
let targetFrameRate = 120;
let frameRate = 0;
let startTime;

function play() {
  if (interval) {
    clearInterval(interval);
  }

  startTime = Date.now();

  start();

  interval = setInterval(
    loop,
    (1 / targetFrameRate) * 1000
  );
}

function loop() {
  const frameStart = Date.now();

  runFrame();

  Time.deltaTime =
    ((1 / targetFrameRate) * 1000 + Date.now() - frameStart) * 0.001;

  frameRate = 1 / Time.deltaTime;
  Time.time += Time.deltaTime;
}

function runFrame() {
  processInput();
  PhysicsEngine.fixedUpdate();
  update();
  render();
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

function render() {
  Camera.allCameras.forEach(cam => cam.render());
}

module.exports = {
  play,
  frameRate,
  targetFrameRate
};
