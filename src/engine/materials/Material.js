import TextureLoader from "../rendering/TextureLoader";

export default class Material {
  _loaded = false;

  shader = {
    vert: null,
    frag: null,
    program: null,
  };

  static AttributeType = {
    Byte: "BYTE",
    Short: "SHORT",
    uByte: "UNSIGNED_BYTE",
    uShort: "UNSIGNED_SHORT",
    Float: "FLOAT",
  };

  colors = {};
  textures = {};
  renderQueue = 1000;
  attributes = [];

  set mainTexture(texture) {
    this.setTexture("uMainTex", texture);
  }

  get mainTexture() {
    return this.getTexture("uMainTex");
  }

  set mainColor(color) {
    this.setColor("uMainColor", color);
  }

  get mainColor() {
    return this.getColor("uMainColor");
  }

  setColor(colorName, value) {
    this.colors[colorName] = value;
  }

  getColor(colorName) {
    return this.colors[colorName];
  }

  setTexture(textureName, value) {
    this.textures[textureName] = value;
  }

  getTexture(textureName, value) {
    return this.textures[textureName];
  }

  setAttribute(attributeName, value) {
    this.attributes[attributeName] = value;
  }

  getAttribute(attributeName) {
    return this.attributes[attributeName];
  }

  load(glContext) {
    if (this._loaded) {
      return;
    }

    this.shader.shaderProgram = this.loadShaderProgram(glContext);

    Object.entries(this.textures).forEach(([key, value]) => {
      this.textures[key] = TextureLoader.load(value, glContext);
    });

    this.attributes.forEach((attribute) => {
      attribute.buffer = Material.createBuffer(glContext, attribute.data);
    });

    this._loaded = true;
  }

  static createBuffer(renderingContext, data) {
    const buffer = renderingContext.createBuffer();
    renderingContext.bindBuffer(renderingContext.ARRAY_BUFFER, buffer);
    renderingContext.bufferData(renderingContext.ARRAY_BUFFER, new Float32Array(data), renderingContext.STATIC_DRAW);

    return buffer;
  }

  loadShaderProgram(glContext) {
    const vertexShader = this.loadShader(glContext, glContext.VERTEX_SHADER, this.shader.vert);
    const fragmentShader = this.loadShader(glContext, glContext.FRAGMENT_SHADER, this.shader.frag);

    const shaderProgram = glContext.createProgram();
    glContext.attachShader(shaderProgram, vertexShader);
    glContext.attachShader(shaderProgram, fragmentShader);

    glContext.linkProgram(shaderProgram);

    if (!glContext.getProgramParameter(shaderProgram, glContext.LINK_STATUS)) {
      alert("Unable to initialize the shader program: " + glContext.getProgramInfoLog(shaderProgram));
      return null;
    }

    return shaderProgram;
  }

  loadShader(glContext, type, source) {
    const shader = glContext.createShader(type);

    glContext.shaderSource(shader, source);
    glContext.compileShader(shader);

    if (!glContext.getShaderParameter(shader, glContext.COMPILE_STATUS)) {
      alert("An error occurred compiling the shaders: " + glContext.getShaderInfoLog(shader));
      glContext.deleteShader(shader);
      return null;
    }

    return shader;
  }
}
