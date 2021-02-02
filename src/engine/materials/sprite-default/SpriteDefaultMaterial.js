const Material = require('../Material');
class SpriteDefaultMaterial extends Material {

  shader = {
    vert: require('./sprite-default.vert'),
    frag: require('./sprite-default.frag'),
  }

  colors = { uMainColor: [] };

  textures = { uMainTex: null };

  attributes = [];

}

module.exports = SpriteDefaultMaterial;
