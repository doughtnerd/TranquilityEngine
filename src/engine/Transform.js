const GameBehavior = require('./GameBehavior');
const mat4 = require('gl-matrix').mat4;
const quat = require('gl-matrix').quat;
const vec3 = require('gl-matrix').vec3;

class Transform extends GameBehavior {

  position = {
    x: 0,
    y: 0,
    z: 0
  };

  rotation = {
    x: 0,
    y: 0,
    z: 0
  };

  scale = {
    x: 1,
    y: 1,
    z: 1
  };

  createModelMatrix() {
    let quaternion = quat.fromEuler(
      [],
      -this.rotation.x,
      -this.rotation.y,
      this.rotation.z,
    );

    const modelViewMatrix = mat4.fromRotationTranslationScale(
      [],
      quaternion,
      [this.position.x, this.position.y, -this.position.z],
      [this.scale.x, this.scale.y, this.scale.z]
    )

    return modelViewMatrix;
  }
}

module.exports = Transform;
