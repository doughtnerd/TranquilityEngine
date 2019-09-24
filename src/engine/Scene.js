const SpriteRenderer = require('./SpriteRenderer');
const Renderer = require('./Renderer');
const Camera = require('./Camera');

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
      const r = go.getBehavior(SpriteRenderer);
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

  render() {
    this.renderers.forEach(r => {
      Renderer.renderQueue.add(r);
    });
    Renderer.drawFrame(Camera.main);
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
