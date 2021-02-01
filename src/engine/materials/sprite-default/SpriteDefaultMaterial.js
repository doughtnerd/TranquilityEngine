const Material = require('../Material');
const SpriteDefaultShader = require('./SpriteDefaultShader')
class SpriteDefaultMaterial extends Material {

  shader = new SpriteDefaultShader()

  colors = { uMainColor: [] };

  textures = { uMainTex: null }

  attributes = [];

}

module.exports = SpriteDefaultMaterial;
