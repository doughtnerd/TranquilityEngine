const GameBehavior = require('../../engine/GameBehavior');

class Damager extends GameBehavior {

  damageAmount = 1;

  damage(damageable) {
    var rand = Math.floor(Math.random() * (1 - 0 + 1)) + 0;
    if (rand === 1) {
      damageable.damage(this.damageAmount);
    } else {
      console.log(`${this.gameObject.name} missed ${damageable.gameObject.name}`);
      damageable.damage(0);
    }
  }
}

module.exports = Damager;
