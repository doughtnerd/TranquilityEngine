const GameObject = require("../../engine/GameObject");
const SpriteRenderer = require("../../engine/rendering/SpriteRenderer");
const Transform = require("../../engine/Transform");
const { Vector3 } = require("../../engine/Vector3");

class Ground extends GameObject {
  constructor(name = "ground") {
    super(name);
    this.transform.scale = new Vector3(32, 10, 0)
    this.addBehavior(SpriteRenderer).init({
        sprite: require("../images/ground.jpg"),
        color: [1, 1, 1, 1],
    });
  }
}

module.exports = Ground;