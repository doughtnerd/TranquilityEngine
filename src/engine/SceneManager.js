const EventEmitter = require('events');
const Scene = require('./Scene');

class SceneManager {

  static eventEmitter = new EventEmitter();
  static scenes;

  static activeScene;

  static loadScene(index) {
    const scene = SceneManager.scenes[index];

    const toInstantiate = scene.gameObjects;
    const instantiatedObjects = SceneManager.instantiateSceneObjects(toInstantiate);

    this.activeScene = new Scene(instantiatedObjects);
    this.activeScene.awake();

    SceneManager.eventEmitter.emit('SceneLoaded');
  }

  static instantiateSceneObjects(gameObjects) {
    return gameObjects.map((obj, index) => {
      const instantiatedObj = SceneManager.instantiateSceneObject(obj);

      SceneManager.eventEmitter.emit('SceneLoading', { progress: (index + 1) / gameObjects.length });

      return instantiatedObj;
    });
  }

  static instantiateSceneObject(gameObject) {
    const obj = new (gameObject.type);

    for (const key in gameObject.attributes) {
      if (obj.hasOwnProperty(key)) {
        obj[key] = gameObject.attributes[key];
      }
    }

    const settings = gameObject.behaviors || {};

    for (const key in settings) {
      const behaviorType = key;
      const behavior = obj.getBehavior(behaviorType);
      const attributes = settings[key].attributes;

      behavior.init(attributes);
    }

    console.log(obj);

    return obj;

  }
}

module.exports = SceneManager;
