const Shader = require('../../../Shader');
const Material = require('../../../Material');

class SpriteDefaultMaterial extends Material {

  shader = new Shader(
    require('./sprite-default.vert'),
    require('./sprite-default.frag'),
  );

  colors = { uDiffuseColor: [] };

  textures = { uDiffuse: null }

  attributes = [];

}

module.exports = SpriteDefaultMaterial;
