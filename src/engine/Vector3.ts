import { vec3 } from "gl-matrix";

export class Vector3 {
  _vector: [number, number, number];

  constructor(x: number, y: number, z: number) {
    this._vector = [x, y, z];
  }

  public get x(): number {
    return this._vector[0];
  }

  public get y(): number {
    return this._vector[1];
  }

  public get z(): number {
    return this._vector[2];
  }

  public set x(value: number) {
    this._vector[0] = value;
  }

  public set y(value: number) {
    this._vector[1] = value;
  }

  public set z(value: number) {
    this._vector[2] = value;
  }

  public static get zero(): Vector3 {
    return new Vector3(0, 0, 0);
  }

  static get one(): Vector3 {
    return new Vector3(1, 1, 1);
  }

  public static get left(): Vector3 {
    return new Vector3(-1, 0, 0);
  }

  public static get right(): Vector3 {
    return new Vector3(1, 0, 0);
  }

  public static get up(): Vector3 {
    return new Vector3(0, 1, 0);
  }

  public static get down(): Vector3 {
    return new Vector3(0, -1, 0);
  }

  public static get forward(): Vector3 {
    return new Vector3(0, 0, 1);
  }

  public static get backward(): Vector3 {
    return new Vector3(0, 0, -1);
  }

  public get magnitude(): number {
    return Math.sqrt(
      Math.pow(this.x, 2) + Math.pow(this.y, 2) + Math.pow(this.z, 2)
    );
  }

  public get sqrMagnitude(): number {
    return Math.pow(this.magnitude, 2);
  }

  public get normalized(): Vector3 {
    const { x, y, z } = this;
    const magnitude = this.magnitude;
    return new Vector3(x / magnitude, y / magnitude, z / magnitude);
  }

  public toArray(): [number, number, number] {
    return [this.x, this.y, this.z];
  }

  public static normalize(vecA: Vector3): Vector3 {
    const [x,y,z] = vec3.normalize(vec3.create(), vecA.toArray());
    return new Vector3(x, y, z);
  }

  public static dot(vecA: Vector3, vecB: Vector3): number {
    return vec3.dot(vecA.toArray(), vecB.toArray());
  }

  public static scale(vector, scaleBy): Vector3 {
    const [x, y, z] = vec3.scale(vec3.create(), vector.toArray(), scaleBy);
    return new Vector3(x, y, z);
  }

  public static subtract(vecA: Vector3, vecB: Vector3): Vector3 {
    const [x, y, z] = vec3.subtract(
      vec3.create(),
      vecA.toArray(),
      vecB.toArray()
    );
    return new Vector3(x, y, z);
  }

  public static add(a, b): Vector3 {
    const result = new Vector3(a.x + b.x, a.y + b.y, a.z + b.z);
    return result;
  }

  public static fromArray([x, y, z]): Vector3 {
    return new Vector3(x, y, z);
  }

  public static multiply(vecA, vecB): Vector3 {
    const [x, y, z] = vec3.multiply(vec3.create(), vecA.toArray(), vecB.toArray());
    return new Vector3(x, y, z);
  }

  public static multiplyScalar(a: Vector3, b: number) {
    return new Vector3(a.x * b, a.y * b, a.z * b);
  }

  public static divide(a: Vector3, b: Vector3): Vector3 {
    const [x,y,z] = vec3.divide(vec3.create(), a.toArray(), b.toArray())
    return new Vector3(x, y, z);
  }

  public static divideScalar(a: Vector3, b: number) {
    return new Vector3(a.x / b, a.y / b, a.z / b);
  }

  public static distance(a: Vector3, b: Vector3): number {
    return Vector3.subtract(a, b).magnitude;
  }
}
