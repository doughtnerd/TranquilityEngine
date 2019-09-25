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
    const instantiatedGameObject = new (gameObject.type);

    SceneManager.applyGameObjectAttributes(instantiatedGameObject, gameObject.attributes);

    const behaviorSettings = gameObject.behaviors || {};
    SceneManager.applyGameBehaviorSettings(instantiatedGameObject, behaviorSettings);

    return instantiatedGameObject;

  }

  static applyGameObjectAttributes(instantiatedGameObject, attributes) {
    for (const key in attributes) {
      if (instantiatedGameObject.hasOwnProperty(key)) {
        instantiatedGameObject[key] = attributes[key];
      }
    }
  }

  static applyGameBehaviorSettings(gameObject, behaviorSettings) {
    for (const key in behaviorSettings) {
      const behaviorType = key;
      const behavior = gameObject.getBehavior(behaviorType);
      const attributes = behaviorSettings[key].attributes;

      behavior.init(attributes);
    }
  }
}

module.exports = SceneManager;
