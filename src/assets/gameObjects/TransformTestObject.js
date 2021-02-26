import GameObject from "../../engine/GameObject";
import SpriteRenderer from "../../engine/rendering/SpriteRenderer";
import Transform from "../../engine/Transform";
import Ground from "./Ground";
import flappyBird from "../images/moderncraft.png";

export default class TransformTestObject extends GameObject {

  constructor(name = "TTest") {
    super(name);

    this.addBehavior(SpriteRenderer).init({
      sprite: flappyBird,
      color: [1, 1, 1, 1],
      rendererPriority: 1000,
    });
  }
}