import { GameBehavior, GameObject, Time, behavior, field } from "myco";

/** A client-side lightning bolt: flickers for a moment, then removes itself. */
@behavior("pirates.Bolt", { worlds: ["client"] })
export class Bolt extends GameBehavior {
  /** Seconds it lasts. */
  @field(Number) life = 0.35;
  private age = 0;

  update(): void {
    this.age += Time.deltaTime;
    const visual = this.node.find("Visual");
    if (visual) {
      const on = Math.floor(this.age * 30) % 3 !== 2;
      if (visual.active !== on) visual.setActive(on);
    }
    if (this.age >= this.life) GameObject.destroy(this.node);
  }
}
