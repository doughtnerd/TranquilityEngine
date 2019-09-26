const Renderer = require('./Renderer');

class Material {

  shader;

  constructor(shader) {
    this.shader = shader;
  }

  createBuffer(renderingContext, data) {
    const buffer = renderingContext.createBuffer();
    renderingContext.bindBuffer(renderingContext.ARRAY_BUFFER, buffer);
    renderingContext.bufferData(renderingContext.ARRAY_BUFFER, new Float32Array(data), renderingContext.STATIC_DRAW);

    return buffer;
  }
}

module.exports = Material;
