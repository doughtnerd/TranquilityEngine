import GameObject from "../../engine/GameObject";
import SpriteRenderer from "../../engine/rendering/SpriteRenderer";
import { Vector3 } from "../../engine/Vector3";
import backgroundImage from "../images/background.png";

export default class Background extends GameObject {
  constructor(name = "background") {
    super(name);

    this.transform.scale = new Vector3(30, 25, 0);

    this.addBehavior(SpriteRenderer).init({
      rendererPriority: 0,
      sprite: backgroundImage,
      color: [1, 1, 1, 1],
    });
  }
}
