const Renderer = require('./Renderer');

class Scene {

  gameObjects = [];
  updateFuncs = [];
  behaviors = [];
  renderers = [];

  constructor(gameObjects) {
    this.gameObjects = gameObjects;
    this.gameObjects.forEach(obj => {
      this.behaviors = [...this.behaviors, ...obj.getBehaviors()];
    });
    this.gameObjects.forEach(go => {
      const r = go.getBehavior(Renderer);
      if (r) {
        this.renderers.push(r);
      }
    })
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
    // TODO: Do a thing to add behaviors and such
  }

  findObjectOfType(gameObjectType) {
    return this.gameObjects.find(obj => obj instanceof gameObjectType);
  }


}

module.exports = Scene;
