
function loadShader(glContext, type, source) {
  const shader = glContext.createShader(type);

  glContext.shaderSource(shader, source);
  glContext.compileShader(shader);

  if (!glContext.getShaderParameter(shader, glContext.COMPILE_STATUS)) {
    alert('An error occurred compiling the shaders: ' + glContext.getShaderInfoLog(shader));
    glContext.deleteShader(shader);
    return null;
  }

  return shader;
}

class Shader {
  vert = null;
  frag = null;

  renderPriority = 1000;

  attributes = [];

  static AttributeType = {
    Float: 'FLOAT'
  }

  constructor(vert, frag, attributes) {
    this.vert = vert;
    this.frag = frag;
    this.attributes = attributes;
  }

  loadShaderProgram(glContext) {
    const vertexShader = loadShader(glContext, glContext.VERTEX_SHADER, this.vert);
    const fragmentShader = loadShader(glContext, glContext.FRAGMENT_SHADER, this.frag);

    const shaderProgram = glContext.createProgram();
    glContext.attachShader(shaderProgram, vertexShader);
    glContext.attachShader(shaderProgram, fragmentShader);

    this.attributes = this.attributes.map((attribute, index) => {
      glContext.bindAttribLocation(shaderProgram, index, attribute);
      return {
        ...attribute,
        boundLocation: index
      }
    });

    glContext.linkProgram(shaderProgram);

    if (!glContext.getProgramParameter(shaderProgram, glContext.LINK_STATUS)) {
      alert('Unable to initialize the shader program: ' + glContext.getProgramInfoLog(shaderProgram));
      return null;
    }

    return shaderProgram;
  }
}

module.exports = Shader;
