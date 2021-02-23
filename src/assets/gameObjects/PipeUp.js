const BoxCollider = require("../../engine/BoxCollider");
const GameObject = require("../../engine/GameObject");
const SpriteRenderer = require("../../engine/rendering/SpriteRenderer");
const { Vector3 } = require("../../engine/Vector3");

class PipeUp extends GameObject {
  constructor(name = "PipeUp") {
    super(name);

    this.transform.scale = new Vector3(2, 10, 1);

    this.addBehavior(SpriteRenderer).init({
      sprite: require("../images/PipeUp.png"),
      color: [1, 1, 1, 1],
      renderPriority: 2000,
    });

    this.addBehavior(BoxCollider).init({
      bounds: {
        size: [2, 10, 1],
      },
      isTrigger: true,
    });
  }
}

module.exports = PipeUp;
// export default PipeUp;
