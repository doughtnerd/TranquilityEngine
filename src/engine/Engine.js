const Time = require('./Time');
const SceneManager = require('./SceneManager');

class Engine {

  static interval;
  static targetFrameRate = 2;
  static frameRate = 0;

  static play() {
    if (Engine.interval) {
      clearInterval(Engine.interval);
    }
    Engine.startTime = Date.now();

    Engine.start();

    Engine.interval = setInterval(() => {
      const frameStart = Date.now();

      Engine.runFrame();

      Time.time = (Date.now() - Time.startTime) * .001;
      Time.deltaTime = (((1 / Engine.targetFrameRate) * 1000) + Date.now() - frameStart) * .001;

      Engine.frameRate = 1 / Time.deltaTime;
      // console.log(Engine.frameRate);
    }, (1 / Engine.targetFrameRate) * 1000);
  }

  static runFrame() {
    // Engine.processInput();
    Engine.update();
    Engine.render();
  }

  static update() {
    SceneManager.activeScene.update();
  }

  static start() {
    SceneManager.activeScene.start();
  }

  static processInput() {

  }

  static render() {
  }
}

module.exports = Engine;
