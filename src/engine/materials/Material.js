class Material {

  /**
   * The Shader instance the material uses.
   *
   * @memberof Material
   */
  shader;
  
  colors = {};
  textures = {};
  attributes = [];

  set mainTexture(texture) {
    this.setTexture('uMainTex', texture)
  }

  get mainTexture() {
    return this.getTexture('uMainTex')
  }

  set mainColor(color) {
    this.setColor('uMainColor', color);
  }

  get mainColor() {
    return this.getColor('uMainColor')
  }

  setColor(uniformName, value) {
    this.colors[uniformName] = value;
  }

  getColor(uniformName) {
    return this.colors[uniformName];
  }

  setTexture(uniformName, value) {
    this.textures[uniformName] = value;
  }

  getTexture(uniformName, value) {
    return this.textures[uniformName];
  }

  static createBuffer(renderingContext, data) {
    const buffer = renderingContext.createBuffer();
    renderingContext.bindBuffer(renderingContext.ARRAY_BUFFER, buffer);
    renderingContext.bufferData(renderingContext.ARRAY_BUFFER, new Float32Array(data), renderingContext.STATIC_DRAW);

    return buffer;
  }
}

module.exports = Material;
