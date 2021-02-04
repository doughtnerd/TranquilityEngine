const GameBehavior = require("../../engine/GameBehavior");
const RigidBody = require("../../engine/RigidBody");


class VelocityBasedRotation extends GameBehavior {

    rigidBody;

    awake() {
        this.rigidBody = this.gameObject.getBehavior(RigidBody);
    }


    update() {
        if(this.rigidBody.velocity.y < 0) {
            this.transform.rotation.z = -15;
        } else if (this.rigidBody.velocity.y > 0) {
            this.transform.rotation.z = 15;
        }
    }
}

module.exports = VelocityBasedRotation;