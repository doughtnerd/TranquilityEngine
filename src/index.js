const Engine = require('./engine/Engine');
const Renderer = require('./engine/Renderer');
const SceneManager = require('./engine/SceneManager');

Renderer.init({ resolution: { width: 720, height: 480 } });

SceneManager.scenes = [require('./assets/scenes/scene1.js')];

SceneManager.eventEmitter.on('SceneLoading', (data) => {
  console.log('Scene Load Progress: ', data.progress);
});

SceneManager.loadScene(0);

Engine.play();
