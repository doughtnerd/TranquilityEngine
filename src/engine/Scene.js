export default class Scene {
  gameObjects = [];

  constructor(gameObjects) {
    this.gameObjects = gameObjects;
  }

  awake() {
    this.gameObjects.forEach((obj) => {
      obj.getBehaviors().forEach((b) => b.awake());
    });
  }

  start() {
    this.gameObjects.forEach((obj) => {
      obj.getBehaviors().forEach((b) => b.start());
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
  
  instantiate(gameObject) {
    const newObj = new gameObject();

    newObj.getBehaviors().forEach((b) => {
      b.awake();
      b.start();
      b.onEnable();
    });
    this.gameObjects.push(newObj);
    return newObj;
  }

  destroy(gameObject) {
    this.gameObjects.splice(this.gameObjects.indexOf(gameObject), 1);
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
