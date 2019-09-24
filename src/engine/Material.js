const Renderer = require('./Renderer');

class Material {

  shaderSettings;
  programInfo;

  constructor(vert, frag, shaderSettings) {
    this.shaderSettings = shaderSettings;

    const shaderProgram = Material.initShaderProgram(vert, frag);

    this.programInfo = {
      program: shaderProgram,
      attributeLocations: {
        vertexPosition: Renderer.glContext.getAttribLocation(shaderProgram, 'aVertexPosition'),
        vertexColor: Renderer.glContext.getAttribLocation(shaderProgram, 'aVertexColor'),
        textureCoord: Renderer.glContext.getAttribLocation(shaderProgram, 'aTextureCoord'),
      },
      uniformLocations: {
        projectionMatrix: Renderer.glContext.getUniformLocation(shaderProgram, 'uProjectionMatrix'),
        modelViewMatrix: Renderer.glContext.getUniformLocation(shaderProgram, 'uModelViewMatrix'),
        resolution: Renderer.glContext.getUniformLocation(shaderProgram, 'uResolution'),
        uSampler: Renderer.glContext.getUniformLocation(shaderProgram, 'uSampler'),
      },
    };
  }

  static initShaderProgram(vsSource, fsSource) {
    const vertexShader = Material.loadShader(Renderer.glContext.VERTEX_SHADER, vsSource);
    const fragmentShader = Material.loadShader(Renderer.glContext.FRAGMENT_SHADER, fsSource);

    const shaderProgram = Renderer.glContext.createProgram();
    Renderer.glContext.attachShader(shaderProgram, vertexShader);
    Renderer.glContext.attachShader(shaderProgram, fragmentShader);
    Renderer.glContext.linkProgram(shaderProgram);

    if (!Renderer.glContext.getProgramParameter(shaderProgram, Renderer.glContext.LINK_STATUS)) {
      alert('Unable to initialize the shader program: ' + Renderer.glContext.getProgramInfoLog(shaderProgram));
      return null;
    }

    return shaderProgram;
  }

  static loadShader(type, source) {
    const shader = Renderer.glContext.createShader(type);

    Renderer.glContext.shaderSource(shader, source);
    Renderer.glContext.compileShader(shader);

    if (!Renderer.glContext.getShaderParameter(shader, Renderer.glContext.COMPILE_STATUS)) {
      alert('An error occurred compiling the shaders: ' + Renderer.glContext.getShaderInfoLog(shader));
      Renderer.glContext.deleteShader(shader);
      return null;
    }

    return shader;
  }
}

module.exports = Material;
