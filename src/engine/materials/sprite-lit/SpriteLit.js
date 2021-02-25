class SpriteLit extends Shader {
  constructor() {
    super(require("./sprite-default.vert"), require("./sprite-default.frag"), [
      {
        name: "aVertexPosition",
        type: "geometry",
        componentType: Shader.AttributeType.Float,
        numComponents: 3,
        normalize: false,
        stride: 0,
        offset: 0,
        buffer: this.createGeometryBuffer,
      },
      {
        name: "aVertexColor",
        type: "color",
        componentType: Shader.AttributeType.Float,
        numComponents: 4,
        normalize: false,
        stride: 0,
        offset: 0,
        buffer: this.createColorBuffer,
      },
      {
        name: "aTextureCoord",
        type: "texture",
        componentType: Shader.AttributeType.Float,
        numComponents: 2,
        normalize: false,
        stride: 0,
        offset: 0,
        buffer: this.createTextureCoordinateBuffer,
      },
      {
        name: "aNormal",
        type: "normal",
        componentType: Shader.AttributeType.Float,
        numComponents: 3,
        normalize: false,
        stride: 0,
        offset: 0,
        buffer: this.createNormalBuffer,
      },
    ]);

    this.renderPriority = 1000;
  }
}
