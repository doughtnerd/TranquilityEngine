const GameBehavior = require("../GameBehavior");
const Endpoint = require("./Endpoint");
const PhysicsEngine = require("../PhysicsEngine");
class Collider extends GameBehavior {
  enabled;
  isTrigger;
  attachedRigidbody;

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

    PhysicsEngine.addCollider(this);
  }

  fixedUpdate() {
    this.updateCenter();

    this.updateEndpoints();
  }

  updateCenter() {
    this.bounds.center = [
      this.gameObject.transform.position.x,
      this.gameObject.transform.position.y,
      this.gameObject.transform.position.z,
    ];
  }

  updateEndpoints() {
    this.endpoints.x[0].value = this.bounds.center[0] - this.bounds.size[0];
    this.endpoints.x[1].value = this.bounds.center[0] + this.bounds.size[0];

    this.endpoints.y[0].value = this.bounds.center[1] - this.bounds.size[1];
    this.endpoints.y[1].value = this.bounds.center[1] + this.bounds.size[1];

    this.endpoints.z[0].value = this.bounds.center[2] - this.bounds.size[2];
    this.endpoints.z[1].value = this.bounds.center[2] + this.bounds.size[2];
  }

  static testAABBOverlap(a, b) {
    const isIntersecting =
      a.endpoints.x[1].value > b.endpoints.x[0].value &&
      a.endpoints.x[0].value < b.endpoints.x[1].value &&
      a.endpoints.y[1].value > b.endpoints.y[0].value &&
      a.endpoints.y[0].value < b.endpoints.y[1].value &&
      a.endpoints.z[1].value > b.endpoints.z[0].value &&
      a.endpoints.z[0].value < b.endpoints.z[1].value;

    if (isIntersecting) {
      // console.log(
      //   (
      //     Math.abs(a.endpoints.x[1].value - b.endpoints.x[1].value) -
      //     a.bounds.size[0]
      //   ).toFixed(2)
      // );
      //   console.log((a.endpoints.x[0].value - b.endpoints.x[0].value).toFixed(2));
      //   console.log(
      //     a.endpoints.x[1].value.toFixed(2),
      //     b.endpoints.x[0].value.toFixed(2)
      //   );
      //   const aPoint =
      //     b.endpoints.x[0].value > a.endpoints.x[1].value
      //       ? b.endpoints.x[0].value.toFixed(2)
      //       : a.endpoints.x[1].value.toFixed(2);
      //   const bPoint =
      //     b.endpoints.x[0].value > a.endpoints.x[1].value
      //       ? a.endpoints.x[1].value.toFixed(2)
      //       : b.endpoints.x[0].value.toFixed(2);
      //   console.log(aPoint - bPoint);
    }
    return isIntersecting;
  }
}

module.exports = Collider;
