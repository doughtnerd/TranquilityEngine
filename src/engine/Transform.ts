import { Vector3 } from "./Vector3";

const GameBehavior = require("./GameBehavior");
const { mat4, quat } = require("gl-matrix");

export class Transform extends GameBehavior {
  public position: Vector3 = Vector3.zero;

  public rotation = {
    x: 0,
    y: 0,
    z: 0,
  };

  public scale = Vector3.one;

  transformPoint(point: Vector3): Vector3 {
    return Vector3.add(this.position, point);
  }

  inverseTransformPoint(point: Vector3): Vector3 {
    return Vector3.subtract(point, this.position);
  }

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

export default Transform;
