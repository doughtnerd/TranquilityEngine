import EventEmitter from "events";
import GameObject from "./GameObject";
import Scene from "./Scene";

export default class SceneManager {
  static eventEmitter = new EventEmitter();
  static scenes = [];

  static activeScene: Scene = null;

  static loadScene(index) {
    if(this.activeScene) {
      this.activeScene.unload();
    }

    this.activeScene = new Scene([]);

    const scene = SceneManager.scenes[index];

    const rootLevelGameObjects = scene.gameObjects;

    const instancedGameObjects = [];

    for(let i = 0; i < rootLevelGameObjects.length; i++) {
      const gameObject = rootLevelGameObjects[i];
      SceneManager.createGameObjectInstance(gameObject, null, instancedGameObjects);
    }
    this.activeScene.setGameObjects(instancedGameObjects);

  }

  static createGameObjectInstance(gameObjectSettings, transformParent, instancedGameObjects) {
    const instancedObject: GameObject = new gameObjectSettings.type();
    instancedObject.scene = this.activeScene;

    for (const key in gameObjectSettings.attributes) {
      if (instancedObject.hasOwnProperty(key)) {
        instancedObject[key] = gameObjectSettings.attributes[key];
      }
    }

    const gameObjectBehaviors = Object.entries(gameObjectSettings.behaviors)
    for(let j = 0; j < gameObjectBehaviors.length; j++) {
      const [behaviorName, behaviorSettings] = gameObjectBehaviors[j];

      if(behaviorName === "Transform" && (behaviorSettings as any).attributes.children) {
        SceneManager.initializeBehavior(instancedObject, behaviorName, behaviorSettings);
        (behaviorSettings as any).attributes.children.forEach(obj => SceneManager.createGameObjectInstance(obj, instancedObject.transform, instancedGameObjects))
      } else {
        SceneManager.initializeBehavior(instancedObject, behaviorName, behaviorSettings);
      }
    }

    // instancedObject.broadcastMessage('awake')
    instancedGameObjects.push(instancedObject)
  }

  static initializeBehavior(instancedObject, behaviorName, behaviorSettings) {
    let behavior = instancedObject.getBehavior(behaviorName);
    if(!behavior) {
      instancedObject.addBehavior((behaviorSettings as any).type);
      behavior = instancedObject.getBehavior((behaviorSettings as any).type);
    }
    behavior.init((behaviorSettings as any).attributes);
  }
}
