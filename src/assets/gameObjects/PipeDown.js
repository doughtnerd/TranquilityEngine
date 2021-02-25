import BoxCollider from "../../engine/BoxCollider";
import GameObject from "../../engine/GameObject";
import SpriteRenderer from "../../engine/rendering/SpriteRenderer";
import { Vector3 } from "../../engine/Vector3";
import pipeSprite from "../images/PipeDown.png";

export default class PipeDown extends GameObject {
  constructor(name = "PipeDown") {
    super(name);

    this.transform.scale = new Vector3(2, 10, 1);

    this.addBehavior(SpriteRenderer).init({
      sprite: pipeSprite,
      color: [1, 1, 1, 1],
      renderPriority: 2000,
    });

    this.addBehavior(BoxCollider).init({
      bounds: {
        size: [2, 5, 1],
      },
      isTrigger: true,
      collisionLayer: 1,
    });
  }
}
