const GameBehavior = require('./GameBehavior');
const Time = require('./Time');

class Transform extends GameBehavior {

  position = {
    x: 0,
    y: 0,
    z: 0
  };

  rotation = {
    x: 0,
    y: 0,
    z: 0
  };

  scale = {
    x: 1,
    y: 1,
    z: 1
  };

  update() {
    this.rotation.y += 5 * Time.deltaTime;
    this.position.z = Math.sin(Time.time * 3) * 2 - 5
  }
}

module.exports = Transform;
