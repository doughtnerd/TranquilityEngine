
class Scene {

  gameObjects = [];
  updateFuncs = [];
  behaviors = [];

  constructor(gameObjects) {
    this.gameObjects = gameObjects;
    this.gameObjects.forEach(obj => {
      this.behaviors = [...this.behaviors, ...obj.getBehaviors()];
    });
  }

  awake() {
    this.gameObjects.forEach(obj => {
      obj.behaviors.forEach(b => b.awake());
    });
  }

  update() {
    this.behaviors.forEach(b => b.update());
  }

  start() {
    this.behaviors.forEach(b => b.start());
  }

  instantiate(gameObject) {
    gameObject.behaviors.forEach(b => b.awake());
    this.gameObjects.push(gameObject);
  }

  findObjectOfType(gameObjectType) {
    return this.gameObjects.find(obj => obj instanceof gameObjectType);
  }


}

module.exports = Scene;
