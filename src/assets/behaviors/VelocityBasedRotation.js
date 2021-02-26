import GameBehavior from "../../engine/GameBehavior";
import RigidBody from "../../engine/RigidBody";

export default class VelocityBasedRotation extends GameBehavior {
  rigidBody = null;

  awake() {
    console.log("AWAKE")
    this.rigidBody = this.gameObject.getBehavior(RigidBody);
  }

  update() {
    if (this.rigidBody.velocity.y < 0) {
      this.transform.rotation.z = -15;
    } else if (this.rigidBody.velocity.y > 0) {
      this.transform.rotation.z = 15;
    }
  }
}
