const GameBehavior = require('./GameBehavior');

class Camera extends GameBehavior {

  static main;

  clearFlags = 1;
  background;
  cullingMask;
  projection = 'perspective';
  fieldOfView = 60;
  clippingPlanes = {
    near: 0.1,
    far: 10
  };
  viewPortRect = {
    x: 0,
    y: 0,
    w: 1,
    h: 1
  };

}

module.exports = Camera;
