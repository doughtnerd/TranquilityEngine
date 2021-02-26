import GameBehavior from "./GameBehavior";
import { Vector3 } from "./Vector3";

import { mat4, quat } from "gl-matrix";

export default class Transform extends GameBehavior {
  public parent: Transform = null;
  public position: Vector3 = Vector3.zero;
  public rotation = {
    x: 0,
    y: 0,
    z: 0,
  };
  public scale = Vector3.one;

  public localPosition: Vector3 = Vector3.zero;
  public localRotation = {
    x: 0,
    y: 0,
    z: 0
  };
  public localScale = Vector3.one;

  lateUpdate() {
    if(this.parent !== null) {
      this.localPosition = this.parent.inverseTransformPoint(this.transform.position);
      this.transform = this.parent.transformPoint(this.transform.position);
      console.log(this.localPosition, this.position);
    } else {
    }
  }

  /**
   * Transform point from local to world space.
   * @param point 
   */
  transformPoint(point: Vector3): Vector3 {
    return Vector3.add(this.position, point);
  }

  /**
   * Transform point from world to local space
   * @param point 
   */
  inverseTransformPoint(point: Vector3): Vector3 {
    return Vector3.subtract(point, this.position);
  }

  inverseTransformDirection(direction: Vector3): Vector3 {
    throw new Error("Unimplemented")
  }

  inverseTransformVector(vector: Vector3): Vector3 {
    throw new Error("Unimplemented")
  }

  setParent(transform: Transform) {
    this.parent = transform;
  }

  translate(translation: Vector3) {

  }

  createModelMatrix() {
    let quaternion = quat.fromEuler(
      quat.create(),
      -this.rotation.x,
      -this.rotation.y,
      this.rotation.z
    );

    const modelViewMatrix = mat4.fromRotationTranslationScale(
      mat4.create(),
      quaternion,
      [this.position.x, this.position.y, -this.position.z],
      [this.scale.x, this.scale.y, this.scale.z]
    );

    return modelViewMatrix;
  }
}
