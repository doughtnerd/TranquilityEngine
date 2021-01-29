const GameBehavior = require("../GameBehavior");
const Material = require("../materials/Material");
const SceneRenderer = require("./SceneRenderer");
const Shader = require("./Shader");
const TextureLoader = require("./TextureLoader");
const Camera = require("./Camera");

class SpriteRenderer extends GameBehavior {
  sprite;
  color;
  material = {};

  start() {
    this.material.attributes = [
      {
        name: "aVertexPosition",
        componentType: Shader.AttributeType.Float,
        numComponents: 3,
        normalize: false,
        stride: 0,
        offset: 0,
        data: [-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0],
        buffer: [],
      },
      {
        name: "aTextureCoord",
        componentType: Shader.AttributeType.Float,
        numComponents: 2,
        normalize: false,
        stride: 0,
        offset: 0,
        data: [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0],
        buffer: [],
      },
    ];
    this.material.shader.shaderProgram = this.material.shader.loadShaderProgram(
      Camera.main.targetDisplay.glContext
    );
    this.material.textures.uDiffuse = TextureLoader.load(
      this.sprite,
      Camera.main.targetDisplay.glContext
    );
    this.material.colors.uDiffuseColor = this.color;

    this.material.attributes.forEach((attribute) => {
      attribute.buffer = Material.createBuffer(
        Camera.main.targetDisplay.glContext,
        attribute.data
      );
    });
  }

  update() {
    SceneRenderer.renderQueue.add({
      gameObjectTransform: this.gameObject.transform,
      material: this.material,
    });
  }
}

module.exports = SpriteRenderer;
