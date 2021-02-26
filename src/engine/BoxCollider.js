import Collider from "./physics/Collider";
import Endpoint from "./physics/Endpoint";
import PhysicsEngine from "./PhysicsEngine";

export default class BoxCollider extends Collider {
  awake() {
    PhysicsEngine.addCollider(this)
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

  onDestroy() {
    PhysicsEngine.removeCollider(this);
  }
}
