const Camera = require('./rendering/Camera');
const GameObject = require('./GameObject');

class CameraObject extends GameObject {

  constructor(name = 'Camera') {
    super(name);
    this.addBehavior(Camera);
  }

}

module.exports = CameraObject;
