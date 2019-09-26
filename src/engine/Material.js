const Renderer = require('./Renderer');

class Material {

  shader;

  constructor(shader) {
    this.shader = shader;
  }
}

module.exports = Material;
