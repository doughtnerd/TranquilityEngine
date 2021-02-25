import SpriteDefaultMaterial from "../materials/sprite-default/SpriteDefaultMaterial";
import Renderer from "./Renderer";
import defaultSprite from "../sprites/White-Square.jpg";
import Material from "../materials/Material";

export default class SpriteRenderer extends Renderer {
  sprite = defaultSprite;
  material = new SpriteDefaultMaterial();
  color = [1, 1, 1, 1];
  flipX = false;
  flipY = false;
  size = 1;

  awake() {
    this.material.attributes = [
      {
        name: "aVertexPosition",
        componentType: Material.AttributeType.Float,
        numComponents: 3,
        normalize: false,
        stride: 0,
        offset: 0,
        data: [-0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0],
        buffer: [],
      },
      {
        name: "aTextureCoord",
        componentType: Material.AttributeType.Float,
        numComponents: 2,
        normalize: false,
        stride: 0,
        offset: 0,
        data: [0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0],
        buffer: [],
      },
    ];
  }

  start() {
    this.material.mainColor = this.color;
    this.material.mainTexture = this.sprite;
  }
}
