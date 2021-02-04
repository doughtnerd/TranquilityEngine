const GameObject = require("../../engine/GameObject");
const SpriteRenderer = require("../../engine/rendering/SpriteRenderer");
const Transform = require("../../engine/Transform");
const { Vector3 } = require("../../engine/Vector3");

class Background extends GameObject {
  constructor(name = "background") {
    super(name);
    this.transform.scale = new Vector3(30, 25, 0);
    this.addBehavior(SpriteRenderer).init({
      rendererPriority: 500,
      sprite: require("../images/background.png"),
      color: [1, 1, 1, 1],
    });
  }
}

module.exports = Background;