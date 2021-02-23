const GameBehavior = require("../../engine/GameBehavior");
const Camera = require("../../engine/rendering/Camera");
const Input = require("../../engine/Input");
const RigidBody = require("../../engine/RigidBody");
const { Vector3 } = require("../../engine/Vector3");

class MoveObject extends GameBehavior {
  yaw = 0;
  pitch = 0;

  awake() {}

  update() {
    if (Input.getKey("w")) {
      this.gameObject.getBehavior(RigidBody).addForce(Vector3.scale(Vector3.up, 30), 'force');
    }

    if (Input.getKey("s")) {
      this.gameObject.getBehavior(RigidBody).addForce(Vector3.scale(Vector3.down, 30), 'force');
    }

    if (Input.getKey("a")) {
      this.gameObject.getBehavior(RigidBody).addForce(Vector3.scale(Vector3.left, 30), 'force');
    }

    if (Input.getKey("d")) {
      this.gameObject.getBehavior(RigidBody).addForce(Vector3.scale(Vector3.right, 30), 'force');
    }

    if (Input.getKeyDown(" ")) {
      this.gameObject.getBehavior(RigidBody).addForce(Vector3.scale(Vector3.up, 200), 'impulse');
    }

    // if (Input.getMouse()) {
    //   Camera.main.gameObject.transform.rotation = this.calculateRotation(
    //     Input.mouseAxis
    //   );
    // }

    // const cameraPositionDelta = new Vector3(0, 0, -6);
    // const newCameraPosition = Vector3.add(
    //   this.gameObject.transform.position,
    //   cameraPositionDelta
    // );

    // Camera.main.gameObject.transform.position = newCameraPosition;
  }

  calculateRotation(rotationAmount) {
    this.yaw += 5 * rotationAmount.x;
    this.pitch -= 5 * rotationAmount.y;

    this.pitch = this.pitch > this.maxPitch ? this.maxPitch : this.pitch;
    this.pitch = this.pitch < this.minPitch ? this.minPitch : this.pitch;

    const newEulerRotation = {
      x: this.pitch,
      y: this.yaw,
      z: 0,
    };

    return newEulerRotation;
  }
}

module.exports = MoveObject;
