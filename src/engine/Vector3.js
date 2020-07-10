import { vec3 } from "gl-matrix";

export class Vector3 {
  _vector;

  constructor(x, y, z) {
    this._vector = [x, y, z];
  }

  get x() {
    return this._vector[0];
  }

  get y() {
    return this._vector[1];
  }

  get z() {
    return this._vector[2];
  }

  set x(value) {
    this._vector[0] = value;
  }

  set y(value) {
    this._vector[1] = value;
  }

  set z(value) {
    this._vector[2] = value;
  }

  static get zero() {
    return new Vector3(0, 0, 0);
  }

  static get left() {
    return new Vector3(-1, 0, 0);
  }

  static get right() {
    return new Vector3(1, 0, 0);
  }

  static get up() {
    return new Vector3(0, 1, 0);
  }

  static get down() {
    return new Vector3(0, -1, 0);
  }

  static get forward() {
    return new Vector3(0, 0, 1);
  }

  static get backward() {
    return new Vector3(0, 0, -1);
  }

  length() {
    return Math.sqrt(
      Math.pow(this.x, 2) + Math.pow(this.y, 2) + Math.pow(this.z, 2)
    );
  }

  toArray() {
    return [this.x, this.y, this.z];
  }

  static scale(vector, scaleBy) {
    const [x, y, z] = vec3.scale([], vector.toArray(), scaleBy);
    return new Vector3(x, y, z);
  }

  static subtract(vecA, vecB) {
    const [x, y, z] = vec3.subtract([], vecA.toArray(), vecB.toArray());
    return new Vector3(x, y, z);
  }

  static add(a, b) {
    const result = new Vector3(a.x + b.x, a.y + b.y, a.z + b.z);
    console.log(result);
    return result;
  }

  static fromArray([x, y, z]) {
    return new Vector3(x, y, z);
  }

  static multiply(vecA, vecB) {
    const [x, y, z] = vec3.multiply([], vecA, vecB);
    return new Vector3(x, y, z);
  }
}
