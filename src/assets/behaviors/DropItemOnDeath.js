const GameBehavior = require('../../engine/GameBehavior');
const Damageable = require('./Damageable');
const Time = require('../../engine/Time');

class DropItemOnDeath extends GameBehavior {

  item;

  awake() {
    this.gameObject.getBehavior(Damageable).eventEmitter.addListener('Died', this.dropItem.bind(this));
  }
  update() {
    this.gameObject.transform.rotation.x = Time.time * 200;
  }

  dropItem() {
    console.log(`${this.gameObject.name} Dropped: ${this.item}`);
  }
}

module.exports = DropItemOnDeath;
