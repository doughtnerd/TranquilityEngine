process.env.ENGINE_ASSETS_FOLDER_PATH = './src/assets';

const Engine = require('./engine/Engine');
const SceneManager = require('./engine/SceneManager');
const AssetDatabase = require('./engine/AssetDatabase');
const Input = require('./engine/Input');

SceneManager.scenes = ['@assets/scenes/scene1.json'];
SceneManager.loadScene(0);

Engine.play();

