const Camera = require('./Camera');
const GameObject = require('./GameObject');

class CameraObject extends GameObject {

  constructor(name = 'Camera') {
    super(name);

    this.addBehavior(Camera);

    Camera.main = Camera.main == null ? this.getBehavior(Camera) : Camera.main;
  }

}

module.exports = CameraObject;
