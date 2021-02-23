const GameObject = require("../../engine/GameObject");
const Damageable = require("../behaviors/Damageable");
const Damager = require("../behaviors/Damager");
const SpriteRenderer = require("../../engine/rendering/SpriteRenderer");
const MoveObject = require("../behaviors/MoveObject");
const BoxCollider = require("../../engine/BoxCollider");
const RigidBody = require("../../engine/RigidBody");
const VelocityBasedRotation = require("../behaviors/VelocityBasedRotation");

class PlayerObject extends GameObject {
  constructor(name = "Player") {
    super(name);
    this.addBehavior(Damageable).init({ health: 3 });
    this.addBehavior(SpriteRenderer).init({
      sprite: require("../images/flappy-bird-1.png"),
      color: [1, 1, 1, 1],
      rendererPriority: 1000,
    });
    this.addBehavior(MoveObject);
    this.addBehavior(BoxCollider);
    this.addBehavior(RigidBody).init({ mass: 20, useGravity: false });
    this.addBehavior(VelocityBasedRotation);
  }
}

module.exports = PlayerObject;
