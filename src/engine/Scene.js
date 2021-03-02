import Collider from "./physics/Collider";
import PhysicsEngine from "./PhysicsEngine";
import { Vector3 } from "./Vector3";

export default class Scene {
  gameObjects = [];

  constructor(gameObjects) {
    this.gameObjects = gameObjects;
  }

  awake() {
    this.gameObjects.forEach((obj) => {
      obj.getBehaviors().forEach((b) => {
        b.awake()
      });
    });
  }

  start() {
    this.gameObjects.forEach((obj) => {
      obj.getBehaviors().forEach((b) => b.start());
    });
  }

  fixedUpdate() {
    this.gameObjects.forEach((obj) => {
      obj.getBehaviors().forEach((b) => b.fixedUpdate());
    });
  }

  update() {
    this.gameObjects.forEach((obj) => {
      obj.getBehaviors().forEach((b) => b.update());
    });
  }

  lateUpdate() {
    this.gameObjects.forEach((obj) => {
      obj.getBehaviors().forEach(b => b.lateUpdate());
    })
  }
  
  instantiate(gameObject, position = Vector3.zero, transformParent = null) {
    const newObj = new gameObject();

    newObj.transform.setParent(transformParent);
    newObj.transform.position = position;
    
    newObj.getBehaviors().forEach((b) => {
      b.awake();
      b.start();

      if(b.isActive) {
        b.onEnable();
      }
    });
    this.gameObjects.push(newObj);
    return newObj;
  }

  destroy(gameObject) {
    gameObject.transform.getChildren().forEach(child => {
      this.destroy(child.gameObject);
    })
    const destroyed = this.gameObjects.splice(this.gameObjects.indexOf(gameObject), 1);

    destroyed.forEach(g => g.getBehaviors().forEach(b => b.onDestroy()));
    
    gameObject = null
  }

  unload() {
    this.gameObjects.forEach(g => this.destroy(g));
  }

  findObjectOfType(gameObjectType) {
    const result = this.gameObjects.reduce((prev, curr) => {
      const found = curr.getBehaviors().filter((b) => b instanceof gameObjectType);
      return [...prev, ...found];
    }, []);
    return result[0];
  }

  findObjectsOfType(gameObjectType) {
    const result = this.gameObjects.reduce((prev, curr) => {
      const found = curr.getBehaviors().filter((b) => b instanceof gameObjectType);
      return [...prev, ...found];
    }, []);
    return result;
  }
}
