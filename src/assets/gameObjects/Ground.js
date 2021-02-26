import GameObject from "../../engine/GameObject";
import SpriteRenderer from "../../engine/rendering/SpriteRenderer";
import { Vector3 } from "../../engine/Vector3";
import groundImage from "../images/ground.jpg";

export default class Ground extends GameObject {
  constructor(name = "ground") {
    super(name);
    this.transform.scale = new Vector3(32, 10, 0);
    this.addBehavior(SpriteRenderer).init({
      sprite: groundImage,
      color: [1, 1, 1, 1],
      rendererPriority: 4000,
    });
  }
}
