import GameBehavior from "../../engine/GameBehavior";

export default class Damager extends GameBehavior {
  damageAmount = 1;

  damage(damageable) {
    var rand = Math.floor(Math.random() * (1 - 0 + 1)) + 0;
    if (rand === 1) {
      damageable.damage(this.damageAmount);
    } else {
      console.debug(`${this.gameObject.name} missed ${damageable.gameObject.name}`);
      damageable.damage(0);
    }
  }
}
