import GameBehavior from "../../engine/GameBehavior";
import Time from "../../engine/Time";
import Damageable from "./Damageable";

export default class DropItemOnDeath extends GameBehavior {
  item;

  awake() {
    this.gameObject.getBehavior(Damageable).eventEmitter.addListener("Died", this.dropItem.bind(this));
  }

  update() {
    this.gameObject.transform.rotation.x = Time.time * 200;
  }

  onDestroy() {
    this.gameObject.getBehavior(Damageable).eventEmitter.removeListener(this.dropItem.bind(this));
  }

  dropItem() {
    console.debug(`${this.gameObject.name} Dropped: ${this.item}`);
  }
}
