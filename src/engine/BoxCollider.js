const Collider = require("./physics/Collider");
const Endpoint = require("./physics/Endpoint");
const PhysicsEngine = require("./PhysicsEngine");

class BoxCollider extends Collider {
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
}

module.exports = BoxCollider;
