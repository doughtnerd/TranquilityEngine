const GameObject = require('../../engine/GameObject');
const Damageable = require('../behaviors/Damageable');
const Damager = require('../behaviors/Damager');
const DropItemOnDeath = require('../behaviors/DropItemOnDeath');

class MonsterBase extends GameObject {

  constructor(name = 'Monster') {
    super(name)
    this.addBehavior(Damageable).init({ health: 1 });
    this.addBehavior(Damager).init({ damageAmount: 1 });
    this.addBehavior(DropItemOnDeath).init({ item: 'potion' });
  }

}

module.exports = MonsterBase;
