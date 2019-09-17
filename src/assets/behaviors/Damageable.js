const GameBehavior = require('../../engine/GameBehavior');
const EventEmitter = require('events');

class Damageable extends GameBehavior {

  health = 1;
  eventEmitter = new EventEmitter();

  damage(amount) {
    this.health -= amount;
    this.eventEmitter.emit('Damaged', amount);
    if (this.health <= 0) {
      this.health = 0;
      this.eventEmitter.emit('Died');
    }
  }
}

module.exports = Damageable;
