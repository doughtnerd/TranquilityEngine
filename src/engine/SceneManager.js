const EventEmitter = require("events");
const Scene = require("./Scene");

class SceneManager {
  static eventEmitter = new EventEmitter();
  static scenes;

  static activeScene;

  static loadScene(index) {
    const scene = SceneManager.scenes[index];

    const toInstantiate = scene.gameObjects;
    const instantiatedObjects = SceneManager.instantiateSceneObjects(
      toInstantiate
    );

    SceneManager.activeScene = new Scene(instantiatedObjects);
    SceneManager.activeScene.awake();

    SceneManager.eventEmitter.emit("SceneLoaded");
  }

  static instantiateSceneObjects(gameObjects) {
    return gameObjects.map((obj, index) => {
      const instantiatedObj = SceneManager.instantiateSceneObject(obj);

      SceneManager.eventEmitter.emit("sceneLoading", {
        progress: (index + 1) / gameObjects.length,
      });

      return instantiatedObj;
    });
  }

  static instantiateSceneObject(gameObject) {
    const instantiatedGameObject = new gameObject.type();

    SceneManager.applyGameObjectAttributes(
      instantiatedGameObject,
      gameObject.attributes
    );

    const behaviorSettings = gameObject.behaviors || {};
    SceneManager.applyGameBehaviorSettings(
      instantiatedGameObject,
      behaviorSettings
    );

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

      const attributes = behaviorSettings[behaviorType].attributes;
      console.log(behaviorType);
      let behavior = gameObject.getBehavior(behaviorType);

      if (!behavior) {
        gameObject.addBehavior(behaviorSettings[behaviorType].type);
        behavior = gameObject.getBehavior(behaviorSettings[behaviorType].type);
      } else {
        behavior = gameObject.getBehavior(behaviorType);
      }

      behavior.init(attributes);
    }
  }
}

module.exports = SceneManager;
