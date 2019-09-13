const GameObject = require('../../engine/GameObject');
const GameController = require('../behaviors/GameController');

class Controllers extends GameObject {

  constructor() {
    super('Controllers');
    this.addBehavior(GameController);
  }
}

module.exports = Controllers;
