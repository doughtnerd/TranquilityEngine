const Material = require('../../../Material2');

module.exports = class SpriteDefaultMaterial extends Material2 {

  vert = require('./sprite-default.vert');
  frag = require('./sprite-default.vert');

  colors = new Map([
    ['aColor', [1, 1, 1, 1]]
  ])

  textures = [

  ];
}
