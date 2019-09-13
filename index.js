const Engine = require('./engine/Engine');
const SceneManager = require('./engine/SceneManager');
const path = require('path');

SceneManager.scenes = [path.join(__dirname, 'assets/scenes/scene1.json')];
SceneManager.loadScene(0);

Engine.play();
