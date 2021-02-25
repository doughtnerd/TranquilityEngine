import BoxCollider from "../../engine/BoxCollider";
import GameObject from "../../engine/GameObject";
import SpriteRenderer from "../../engine/rendering/SpriteRenderer";
import RigidBody from "../../engine/RigidBody";
import Damageable from "../behaviors/Damageable";
import MoveObject from "../behaviors/MoveObject";
import VelocityBasedRotation from "../behaviors/VelocityBasedRotation";
import flappyBird from "../images/flappyBird.png";

export default class PlayerObject extends GameObject {
  constructor(name = "Player") {
    super(name);
    this.addBehavior(Damageable).init({ health: 1 });
    this.addBehavior(SpriteRenderer).init({
      sprite: flappyBird,
      color: [1, 1, 1, 1],
      rendererPriority: 1000,
    });
    this.addBehavior(MoveObject);
    this.addBehavior(BoxCollider).init({
      bounds: {
        size: [0.25, 0.5, 0.5],
      },
      collisionLayer: 1,
    });
    this.addBehavior(RigidBody).init({ mass: 20, useGravity: true });
    this.addBehavior(VelocityBasedRotation);
  }
}
