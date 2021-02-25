import GameObject from "../../engine/GameObject";
import SpriteRenderer from "../../engine/rendering/SpriteRenderer";
import Damageable from "../behaviors/Damageable";
import Damager from "../behaviors/Damager";
import DropItemOnDeath from "../behaviors/DropItemOnDeath";

export default class MonsterBase extends GameObject {
  constructor(name = "Monster") {
    super(name);
    this.addBehavior(Damageable).init({ health: 1 });
    this.addBehavior(Damager).init({ damageAmount: 1 });
    this.addBehavior(DropItemOnDeath).init({ item: "potion" });
    this.addBehavior(SpriteRenderer);
  }
}
