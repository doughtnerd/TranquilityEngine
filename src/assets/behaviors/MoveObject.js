const Time = require('../../engine/Time');
const GameBehavior = require('../../engine/GameBehavior');
const Camera = require('../../engine/Camera');
const Input = require('../../engine/Input');

class MoveObject extends GameBehavior {

  yaw = 0;
  pitch = 0;

  update() {


    if (Input.getKey('w')) {
      this.gameObject.transform.position.y += 1 * 10 * Time.deltaTime;
    }

    if (Input.getKey('s')) {
      this.gameObject.transform.position.y -= 1 * 10 * Time.deltaTime;
    }

    if (Input.getKey('a')) {
      this.gameObject.transform.position.x -= 1 * 10 * Time.deltaTime;
    }

    if (Input.getKey('d')) {
      this.gameObject.transform.position.x += 1 * 10 * Time.deltaTime;
    }

    // console.log(Input.getMouseDown(), Input.getMouse(), Input.mousePosition, Input.mouseAxis);

    // if (Input.getMouse()) {
    // Camera.main.gameObject.transform.rotation = this.calculateRotation(Input.mouseAxis);
    // }

    Camera.main.gameObject.transform.position = {
      x: this.gameObject.transform.position.x,
      y: this.gameObject.transform.position.y + 2,
      z: this.gameObject.transform.position.z - 6
    }
  }

  calculateRotation(rotationAmount) {
    this.yaw += 5 * rotationAmount.x;
    this.pitch -= 5 * rotationAmount.y;

    // this.pitch = this.pitch > this.maxPitch ? this.maxPitch : this.pitch;
    // this.pitch = this.pitch < this.minPitch ? this.minPitch : this.pitch;

    const newEulerRotation = {
      x: this.pitch,
      y: this.yaw,
      z: 0
    };

    return newEulerRotation;
  }

}

module.exports = MoveObject;
