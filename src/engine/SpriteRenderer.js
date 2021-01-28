const GameBehavior = require("./GameBehavior");
const Material = require("./Material");
const Renderer = require("./Renderer");
const Shader = require("./Shader");
const TextureLoader = require("./TextureLoader");

class SpriteRenderer extends GameBehavior {
  sprite;
  color;
  material = {};

  awake() {
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
      Renderer.glContext
    );
    this.material.textures.uDiffuse = TextureLoader.load(
      this.sprite,
      Renderer.glContext
    );
    this.material.colors.uDiffuseColor = this.color;

    this.material.attributes.forEach((attribute) => {
      attribute.buffer = Material.createBuffer(
        Renderer.glContext,
        attribute.data
      );
    });
  }

  update() {
    Renderer.renderQueue.add({
      gameObjectTransform: this.gameObject.transform,
      material: this.material,
    });
  }
}

module.exports = SpriteRenderer;
