const GameBehavior = require('../../engine/GameBehavior');
const Damageable = require('./Damageable');

class DropItemOnDeath extends GameBehavior {

  item;

  awake() {
    this.gameObject.getBehavior(Damageable).eventEmitter.addListener('Died', this.dropItem.bind(this));
  }

  dropItem() {
    console.log(`${this.gameObject.name} Dropped: ${this.item}`);
  }
}

module.exports = DropItemOnDeath;
