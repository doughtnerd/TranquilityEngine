const Material = require('../../../Material');

class SpriteDefaultMaterial extends Material {

  vert = require('./sprite-default.vert');
  frag = require('./sprite-default.vert');

  colors = new Map([
    ['aColor', [1, 1, 1, 1]]
  ])

  textures = [

  ];
}
