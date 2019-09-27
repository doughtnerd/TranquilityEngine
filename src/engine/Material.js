const Renderer = require('./Renderer');

class Material {

  shader;

  colors = {};
  textures = {};
  attributes = [];

  // constructor(shader, colors, textures, attributes) {
  //   this.shader = shader;
  //   this.colors = colors;
  //   this.textures = textures;
  //   this.attributes = attributes;
  // }

  addColor(uniformName, value) {
    this.colors[uniformName] = value;
  }

  addTexture(uniformName, value) {
    this.textures[uniformName] = value;
  }

  static createBuffer(renderingContext, data) {
    const buffer = renderingContext.createBuffer();
    renderingContext.bindBuffer(renderingContext.ARRAY_BUFFER, buffer);
    renderingContext.bufferData(renderingContext.ARRAY_BUFFER, new Float32Array(data), renderingContext.STATIC_DRAW);

    return buffer;
  }
}

module.exports = Material;
