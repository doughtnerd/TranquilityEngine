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
}

module.exports = Transform;
