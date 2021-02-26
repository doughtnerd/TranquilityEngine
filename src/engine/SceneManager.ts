import EventEmitter from "events";
import GameObject from "./GameObject";
import Scene from "./Scene";

export default class SceneManager {
  static eventEmitter = new EventEmitter();
  static scenes = [];

  static activeScene = null;

  private static parsedGameObjectList = {};
  private static gameObjectQueue = [];

  static loadScene(index) {
    const scene = SceneManager.scenes[index];

    const rootLevelGameObjects = scene.gameObjects;

    const instancedGameObjects = [];
    for(let i = 0; i < rootLevelGameObjects.length; i++) {
      const gameObject = rootLevelGameObjects[i];
      SceneManager.createGameObjectInstance(gameObject, null, instancedGameObjects);
    }


    this.activeScene = new Scene(instancedGameObjects);
    this.activeScene.awake();
  }

  static createGameObjectInstance(gameObjectSettings, transformParent = null, instancedGameObjects) {
    const instancedObject: GameObject = new gameObjectSettings.type();

    for (const key in gameObjectSettings.attributes) {
      if (instancedObject.hasOwnProperty(key)) {
        instancedObject[key] = gameObjectSettings.attributes[key];
      }
    }

    const gameObjectBehaviors = Object.entries(gameObjectSettings.behaviors)
    for(let j = 0; j < gameObjectBehaviors.length; j++) {
      const [behaviorName, behaviorSettings] = gameObjectBehaviors[j];

      console.log(behaviorName, behaviorSettings)

      if(behaviorName === "Transform" && (behaviorSettings as any).attributes.children) {
        let behavior = instancedObject.getBehavior(behaviorName);
        if(!behavior) {
          instancedObject.addBehavior((behaviorSettings as any).type);
          behavior = instancedObject.getBehavior((behaviorSettings as any).type);
        }
        behavior.init((behaviorSettings as any).attributes);
        (behaviorSettings as any).attributes.children.forEach(obj => SceneManager.createGameObjectInstance(obj, instancedObject.transform, instancedGameObjects))
        
      } else {
        let behavior = instancedObject.getBehavior(behaviorName);
        if(!behavior) {
          instancedObject.addBehavior((behaviorSettings as any).type);
          behavior = instancedObject.getBehavior((behaviorSettings as any).type);
        }
        behavior.init((behaviorSettings as any).attributes);
      }
    }

    instancedGameObjects.push(instancedObject)
    // return instancedObject;
  }

  // static loadScene(index) {
  //   const scene = SceneManager.scenes[index];

  //   const toInstantiate = scene.gameObjects;
  //   const instantiatedObjects = SceneManager.instantiateSceneObjects(toInstantiate);

  //   SceneManager.activeScene = new Scene(instantiatedObjects);
  //   SceneManager.activeScene.awake();

  //   SceneManager.eventEmitter.emit("sceneLoaded");
  // }

  // static instantiateSceneObjects(gameObjects) {
  //   return gameObjects.map((obj, index) => {
  //     console.debug("---Instantiating: ", obj);
  //     const instantiatedObj = SceneManager.instantiateSceneObject(obj);
  //     console.debug("---Instantiated: ", instantiatedObj);

  //     SceneManager.eventEmitter.emit("sceneLoading", {
  //       progress: (index + 1) / gameObjects.length,
  //     });

  //     return instantiatedObj;
  //   });
  // }

  // static instantiateSceneObject(gameObject) {
  //   console.debug("---Now instancing gameobject: ", gameObject);
  //   const instantiatedGameObject = new gameObject.type(); //.type();
  //   console.debug("---Instanced gameobject: ", gameObject);

  //   SceneManager.applyGameObjectAttributes(instantiatedGameObject, gameObject.attributes);

  //   const behaviorSettings = gameObject.behaviors || {};
  //   SceneManager.applyGameBehaviorSettings(instantiatedGameObject, behaviorSettings);

  //   return instantiatedGameObject;
  // }

  // static applyGameObjectAttributes(instantiatedGameObject, attributes) {
  //   for (const key in attributes) {
  //     if (instantiatedGameObject.hasOwnProperty(key)) {
  //       instantiatedGameObject[key] = attributes[key];
  //     }
  //   }
  // }

  // static applyGameBehaviorSettings(gameObject, behaviorSettings) {
  //   for (const key in behaviorSettings) {
  //     const behaviorType = key;

  //     console.debug("---Applying behavior settings for: ", behaviorType);

  //     const attributes = behaviorSettings[behaviorType].attributes;
  //     let behavior = gameObject.getBehavior(behaviorType);

  //     if(key === "Transform" ) {
  //       console.log(behavior)
  //     } 

  //     if (!behavior) {
  //       console.debug("---GameObject does not have behavior attached. ", behavior);
  //       gameObject.addBehavior(behaviorSettings[behaviorType].type);
  //       behavior = gameObject.getBehavior(behaviorSettings[behaviorType].type);
  //     }

  //     console.debug("---Initializing GameBehavior. ", behaviorType, attributes);

  //     behavior.init(attributes);

  //     console.debug("---Finished applying behavior settings for: ", behaviorType);
  //   }
  // }
}
