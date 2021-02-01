const Material = require("../materials/Material");
const SceneRenderer = require("./SceneRenderer");
const Shader = require("./Shader");
const TextureLoader = require("./TextureLoader");
const Camera = require("./Camera");
const Renderer = require('./Renderer');

class SpriteRenderer extends Renderer {
  sprite = require('../sprites/White-Square.jpg');
  color = [1,1,1,1];
  flipX = false;
  flipY = false;
  size = 1;

  start() {
    this.material.attributes = [
      {
        name: "aVertexPosition",
        componentType: Shader.AttributeType.Float,
        numComponents: 3,
        normalize: false,
        stride: 0,
        offset: 0,
        data: [
          -0.5, -0.5, 0, 
          0.5, 0.5, 0, 
          -0.5, 0.5, 0, 

          -0.5, -0.5, 0, 
          0.5, -0.5, 0,
          0.5, 0.5, 0, 
        ],
        buffer: [],
      },
      {
        name: "aTextureCoord",
        componentType: Shader.AttributeType.Float,
        numComponents: 2,
        normalize: false,
        stride: 0,
        offset: 0,
        data: [
          0.0, 1.0, 
          1.0, 0.0, 
          0.0, 0.0, 
          
          0.0, 1.0, 
          1.0, 1.0, 
          1.0, 0.0, 
        ],
        buffer: [],
      },
    ];
    this.material.shader.shaderProgram = this.material.shader.loadShaderProgram(
      Camera.main.targetDisplay.glContext
    );
    this.material.textures.uMainTex = TextureLoader.load(
      this.sprite,
      Camera.main.targetDisplay.glContext
    );
    
    this.material.colors.uMainColor = this.color;

    this.material.attributes.forEach((attribute) => {
      attribute.buffer = Material.createBuffer(
        Camera.main.targetDisplay.glContext,
        attribute.data
      );
    });
  }
}

module.exports = SpriteRenderer;
