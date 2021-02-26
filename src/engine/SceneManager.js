import EventEmitter from "events";
import Scene from "./Scene";

class SceneManager {
  static eventEmitter = new EventEmitter();
  static scenes;

  static activeScene;

  static loadScene(index) {
    const scene = SceneManager.scenes[index];

    const toInstantiate = scene.gameObjects;
    const instantiatedObjects = SceneManager.instantiateSceneObjects(toInstantiate);

    SceneManager.activeScene = new Scene(instantiatedObjects);
    SceneManager.activeScene.awake();

    SceneManager.eventEmitter.emit("sceneLoaded");
  }

  static instantiateSceneObjects(gameObjects) {
    return gameObjects.map((obj, index) => {
      console.debug("---Instantiating: ", obj);
      const instantiatedObj = SceneManager.instantiateSceneObject(obj);
      console.debug("---Instantiated: ", instantiatedObj);

      SceneManager.eventEmitter.emit("sceneLoading", {
        progress: (index + 1) / gameObjects.length,
      });

      return instantiatedObj;
    });
  }

  static instantiateSceneObject(gameObject) {
    console.debug("---Now instancing gameobject: ", gameObject);
    const instantiatedGameObject = new gameObject.type(); //.type();
    console.debug("---Instanced gameobject: ", gameObject);

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

      console.debug("---Applying behavior settings for: ", behaviorType);

      const attributes = behaviorSettings[behaviorType].attributes;
      let behavior = gameObject.getBehavior(behaviorType);

      if(key === "Transform" ) {
        console.log(behavior)
      } 

      if (!behavior) {
        console.debug("---GameObject does not have behavior attached. ", behavior);
        gameObject.addBehavior(behaviorSettings[behaviorType].type);
        behavior = gameObject.getBehavior(behaviorSettings[behaviorType].type);
      }

      console.debug("---Initializing GameBehavior. ", behaviorType, attributes);

      behavior.init(attributes);

      console.debug("---Finished applying behavior settings for: ", behaviorType);
    }
  }
}

// module.exports = SceneManager;
export default SceneManager;
