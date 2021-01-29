const GameObject = require('../../engine/GameObject');
const Damageable = require('../behaviors/Damageable');
const Damager = require('../behaviors/Damager');
const DropItemOnDeath = require('../behaviors/DropItemOnDeath');
const SpriteRenderer = require('../../engine/rendering/SpriteRenderer');

class MonsterBase extends GameObject {

  constructor(name = 'Monster') {
    super(name)
    this.addBehavior(Damageable).init({ health: 1 });
    this.addBehavior(Damager).init({ damageAmount: 1 });
    this.addBehavior(DropItemOnDeath).init({ item: 'potion' });
    this.addBehavior(SpriteRenderer);
  }

}

module.exports = MonsterBase;
