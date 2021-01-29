const Shader = require('../../../rendering/Shader');

class SpriteDefaultShader extends Shader {

  constructor() {
    super(
      require('./sprite-default.vert'),
      require('./sprite-default.frag'),
      [
        {
          name: 'aVertexPosition',
          type: 'geometry',
          componentType: Shader.AttributeType.Float,
          numComponents: 3,
          normalize: false,
          stride: 0,
          offset: 0,
        },
        {
          name: 'aVertexColor',
          type: 'color',
          componentType: Shader.AttributeType.Float,
          numComponents: 4,
          normalize: false,
          stride: 0,
          offset: 0,
        },
        {
          name: 'aTextureCoord',
          type: 'texture',
          componentType: Shader.AttributeType.Float,
          numComponents: 2,
          normalize: false,
          stride: 0,
          offset: 0,
        },
      ]
    );

    this.renderPriority = 1000;
  }
}

module.exports = SpriteDefaultShader;
