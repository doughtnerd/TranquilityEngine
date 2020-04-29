const Time = require('./Time');
const SceneManager = require('./SceneManager');
const PhysicsEngine = require('./PhysicsEngine');

const Input = require('./Input');
const Renderer = require('./Renderer');
const Camera = require('./Camera');


class Engine {

  static interval;
  static targetFrameRate = 120;
  static frameRate = 0;

  static play() {
    if (Engine.interval) {
      clearInterval(Engine.interval);
    }
    Engine.startTime = Date.now();

    Engine.start();

    Engine.interval = setInterval(Engine.loop, (1 / Engine.targetFrameRate) * 1000);
  }

  static loop() {
    const frameStart = Date.now();

    Engine.runFrame();

    Time.deltaTime = (((1 / Engine.targetFrameRate) * 1000) + Date.now() - frameStart) * .001;

    Engine.frameRate = 1 / Time.deltaTime;
    Time.time += Time.deltaTime;
  }

  static runFrame() {
    Engine.processInput();
    Engine.update();
    Engine.render();
    PhysicsEngine.fixedUpdate();
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

  static render() {
    Renderer.drawFrame(Camera.main);
  }
}

module.exports = Engine;
