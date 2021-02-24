const GameBehavior = require("../GameBehavior");
const Endpoint = require("./Endpoint");
const { Vector3 } = require("../Vector3");
class Collider extends GameBehavior {
  enabled = true;
  isTrigger = false;
  attachedRigidbody;

  physicsLayer = 0;

  bounds = {
    center: [],
    size: [0.5, 0.5, 0.5],
  };

  endpoints = {
    x: [],
    y: [],
    z: [],
  };

  awake() {
    this.updateCenter();
    this.endpoints.x = [
      new Endpoint(this, this.bounds.center[0] - this.bounds.size[0], true),
      new Endpoint(this, this.bounds.center[0] + this.bounds.size[0], false),
    ];
    this.endpoints.y = [
      new Endpoint(this, this.bounds.center[1] - this.bounds.size[1], true),
      new Endpoint(this, this.bounds.center[1] + this.bounds.size[1], false),
    ];
    this.endpoints.z = [
      new Endpoint(this, this.bounds.center[2] - this.bounds.size[2], true),
      new Endpoint(this, this.bounds.center[2] + this.bounds.size[2], false),
    ];
  }

  fixedUpdate() {
    this.updateCenter();

    this.updateEndpoints();
  }

  updateCenter() {
    this.bounds.center = [this.gameObject.transform.position.x, this.gameObject.transform.position.y, this.gameObject.transform.position.z];
  }

  updateEndpoints() {
    this.endpoints.x[0].value = this.bounds.center[0] - this.bounds.size[0];
    this.endpoints.x[1].value = this.bounds.center[0] + this.bounds.size[0];

    this.endpoints.y[0].value = this.bounds.center[1] - this.bounds.size[1];
    this.endpoints.y[1].value = this.bounds.center[1] + this.bounds.size[1];

    this.endpoints.z[0].value = this.bounds.center[2] - this.bounds.size[2];
    this.endpoints.z[1].value = this.bounds.center[2] + this.bounds.size[2];
  }

  getNearestPoint(to) {
    const endpointVectors = [];
    for (let i = 0; i < 2; i++) {
      const vect = new Vector3(this.endpoints.x[i], this.endpoints.y[i], this.endpoints.z[i]);
      endpointVectors.push(vect);
    }

    let closestDistance = Infinity;
    let closestVector;
    for (let i = 0; i < endpointVectors; i++) {
      const result = Vector3.distance(to, endpointVectors[i]);
      if (result < closestDistance) {
        closestVector = endpointVectors[0];
        closestDistance = result;
      }
    }

    return closestVector;
  }

  static testAABBOverlap(a, b) {
    const isIntersecting =
      a.endpoints.x[1].value > b.endpoints.x[0].value &&
      a.endpoints.x[0].value < b.endpoints.x[1].value &&
      a.endpoints.y[1].value > b.endpoints.y[0].value &&
      a.endpoints.y[0].value < b.endpoints.y[1].value &&
      a.endpoints.z[1].value > b.endpoints.z[0].value &&
      a.endpoints.z[0].value < b.endpoints.z[1].value;
    return isIntersecting;
  }

  static AABBAABB(a, b) {
    if (a.physicsLayer !== b.physicsLayer) {
      return {
        isIntersecting: false,
        nEnter: Vector3.zero,
        penetration: 0,
      };
    }

    let mtvDistance = Number.MAX_VALUE;
    // let mtvAxis = new Vector3(1, 1, 1);
    let mtvAxis = Vector3.zero;

    const xTest = Collider.TestAxisStatic(
      Vector3.right,
      a.endpoints.x[0].value,
      a.endpoints.x[1].value,
      b.endpoints.x[0].value,
      b.endpoints.x[1].value,
      mtvAxis,
      mtvDistance
    );
    if (!xTest.result) {
      return {
        isIntersecting: false,
        nEnter: Vector3.zero,
        penetration: 0,
      };
    }
    mtvDistance = xTest.mtvDistance;
    mtvAxis = xTest.mtvAxis;

    const yTest = Collider.TestAxisStatic(
      Vector3.up,
      a.endpoints.y[0].value,
      a.endpoints.y[1].value,
      b.endpoints.y[0].value,
      b.endpoints.y[1].value,
      mtvAxis,
      mtvDistance
    );
    if (!yTest.result) {
      return {
        isIntersecting: false,
        nEnter: Vector3.zero,
        penetration: 0,
      };
    }
    mtvDistance = yTest.mtvDistance;
    mtvAxis = yTest.mtvAxis;

    const zTest = Collider.TestAxisStatic(
      Vector3.forward,
      a.endpoints.z[0].value,
      a.endpoints.z[1].value,
      b.endpoints.z[0].value,
      b.endpoints.z[1].value,
      mtvAxis,
      mtvDistance
    );
    if (!zTest.result) {
      return {
        isIntersecting: false,
        nEnter: Vector3.zero,
        penetration: 0,
      };
    }
    mtvDistance = zTest.mtvDistance;
    mtvAxis = zTest.mtvAxis;

    return {
      isIntersecting: true,
      nEnter: Vector3.normalize(mtvAxis),
      penetration: Math.sqrt(mtvDistance) * 1.001,
    };
  }

  static TestAxisStatic(axis, minA, maxA, minB, maxB, mtvAxis, mtvDistance) {
    const axisLengthSquared = Vector3.dot(axis, axis);

    if (axisLengthSquared < 1.0e-8) {
      return {
        result: true,
        mtvDistance,
        mtvAxis,
      };
    }

    const d0 = maxB - minA;
    const d1 = maxA - minB;

    if (d0 <= 0 || d1 <= 0) {
      return {
        result: false,
        mtvDistance,
        mtvAxis,
      };
    }

    const overlap = d0 < d1 ? d0 : -d1;

    const overlapDivAxisLength = overlap / axisLengthSquared;
    // console.log(overlapDivAxisLength);
    const sep = Vector3.multiplyScalar(axis, overlapDivAxisLength);

    const sepLengthSquared = Vector3.dot(sep, sep);

    if (sepLengthSquared < mtvDistance) {
      mtvDistance = sepLengthSquared;
      mtvAxis = sep;
    }

    return {
      result: true,
      mtvDistance,
      mtvAxis,
    };
  }
}

module.exports = Collider;
