const GameObject = require('../../engine/GameObject');
const Damageable = require('../behaviors/Damageable');
const Damager = require('../behaviors/Damager');
const Renderer = require('../../engine/Renderer');

class PlayerObject extends GameObject {

  constructor(name = 'Player') {
    super(name)
    this.addBehavior(Damageable).init({ health: 3 });
    this.addBehavior(Damager).init({ damageAmount: 1 });
    this.addBehavior(Renderer);
  }

}

module.exports = PlayerObject;
