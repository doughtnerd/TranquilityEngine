const Material = require('./Material');
const SpriteDefaultShader = require('../shaders/sprite/default/SpriteDefaultShader')
class SpriteDefaultMaterial extends Material {

  shader = new SpriteDefaultShader()

  colors = { uDiffuseColor: [] };

  textures = { uDiffuse: null }

  attributes = [];

}

module.exports = SpriteDefaultMaterial;
