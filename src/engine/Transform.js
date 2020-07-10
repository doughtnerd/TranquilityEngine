const GameBehavior = require("./GameBehavior");
const { Vector3 } = require("./Vector3");
const { mat4, quat } = require("gl-matrix");

class Transform extends GameBehavior {
  position = Vector3.zero;

  rotation = {
    x: 0,
    y: 0,
    z: 0,
  };

  scale = {
    x: 1,
    y: 1,
    z: 1,
  };

  createModelMatrix() {
    let quaternion = quat.fromEuler(
      [],
      -this.rotation.x,
      -this.rotation.y,
      this.rotation.z
    );

    const modelViewMatrix = mat4.fromRotationTranslationScale(
      [],
      quaternion,
      [this.position.x, this.position.y, -this.position.z],
      [this.scale.x, this.scale.y, this.scale.z]
    );

    return modelViewMatrix;
  }
}

module.exports = Transform;
