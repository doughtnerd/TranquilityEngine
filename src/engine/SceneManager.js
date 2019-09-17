const EventEmitter = require('events');
const Scene = require('./Scene');
const AssetDatabase = require('./AssetDatabase');

class SceneManager {

  static eventEmitter = new EventEmitter();
  static scenes;

  static activeScene;

  static loadScene(index) {
    const scene = require(AssetDatabase.parseLoadPath(SceneManager.scenes[index]));

    const toInstantiate = scene.gameObjects;
    const instantiatedObjects = SceneManager.instantiateSceneObjects(toInstantiate);

    this.activeScene = new Scene(instantiatedObjects);
    this.activeScene.awake();

    SceneManager.eventEmitter.emit('SceneLoaded');
  }

  static instantiateSceneObjects(gameObjects) {
    return gameObjects.map(
      obj => SceneManager.instantiateSceneObject(obj)
    );
  }

  static instantiateSceneObject(gameObject) {
    const loadPath = AssetDatabase.parseLoadPath(gameObject.loadPath);
    const obj = new (require(loadPath));

    for (const key in gameObject.attributes) {
      if (obj.hasOwnProperty(key)) {
        obj[key] = gameObject.attributes[key];
      }
    }

    const settings = gameObject.behaviors || {};

    for (const key in settings) {
      const behaviorType = require(AssetDatabase.parseLoadPath(settings[key].loadPath));
      const behavior = obj.getBehavior(behaviorType);
      const attributes = settings[key].attributes;

      behavior.init(attributes);
    }

    console.log(obj);

    return obj;

  }
}

module.exports = SceneManager;
