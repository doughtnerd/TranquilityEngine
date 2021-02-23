const GameObject = require("../../engine/GameObject");
const SpriteRenderer = require("../../engine/rendering/SpriteRenderer");
const { Vector3 } = require("../../engine/Vector3");

class PipeDown extends GameObject {
  constructor(name = "PipeDown") {
    super(name);

    this.transform.scale = new Vector3(2, 10, 1);

    this.addBehavior(SpriteRenderer).init({
      sprite: require("../images/PipeDown.png"),
      color: [1, 1, 1, 1],
      renderPriority: 2000,
    });
  }
}

module.exports = PipeDown;
